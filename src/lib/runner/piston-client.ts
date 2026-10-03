import { createHash } from "node:crypto";

import {
  isTrustedRunnerJob,
  RUNNER_HEALTH_TIMEOUT_MS,
  RUNNER_REQUEST_TIMEOUT_MS,
  RunnerClientError,
  serializeRunnerRequest,
  type RunnerAvailability,
  type RunnerJobResponse,
  type RunnerLanguage,
  type RunnerRequest,
} from "./client";

/**
 * Self-hosted Piston (docs/plans/piston-runner.md), reached only from the
 * server over the internal `piston` network. Piston executes synchronously, so
 * every job this client returns is already COMPLETED. Results use exactly the
 * legacy runner's shape and pass the same trust check before they are
 * returned; anything Piston cannot answer cleanly is an error, never a
 * fabricated result and never a fallback to the legacy runner.
 */

// Must match infra/piston/image-inputs.lock.json and the built API's inventory.
// Labels record exact tool identity; published exam pins migrate separately.
export const PISTON_RUNTIMES: Record<RunnerLanguage, { language: string; version: string; label: string }> = {
  c: { language: "c", version: "14.2.0", label: "C23 / GCC 14.2.0 (Piston)" },
  cpp: { language: "c++", version: "14.2.0", label: "C++20 / G++ 14.2.0 (Piston)" },
  java: { language: "java", version: "21.0.12", label: "Java 21.0.12.1+1 / Temurin (Piston)" },
  python: { language: "python", version: "3.14.8", label: "Python 3.14.8 (Piston)" },
  javascript: { language: "javascript", version: "22.23.3", label: "Node.js 22.23.3 (Piston)" },
};

// Must match PISTON_RUN_TIMEOUT / PISTON_COMPILE_TIMEOUT in compose.yaml:
// Piston rejects requests above its configured maxima.
const PISTON_MAX_RUN_TIMEOUT_MS = 3_000;
const PISTON_COMPILE_TIMEOUT_MS = 10_000;
const PISTON_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 65_536;
const DEFAULT_MEMORY_MB = 128;
const TRUNCATION_MARKER = "\n<output truncated>";

// Piston's interpreters have no separate compile stage. The legacy harness runs
// py_compile / node --check before running, so a syntax error is a
// COMPILE_ERROR there; these checkers give the same split. Java now has a real
// compile stage in our image and does not use an interpreter checker. Each runs as the
// entry file with the learner's file next to it, and never runs learner code.
const CHECKERS: Partial<Record<RunnerLanguage, { name: string; content: (entry: string) => string }>> = {
  python: {
    name: "__codestead_check.py",
    content: (entry) => [
      "import py_compile, sys",
      "try:",
      `    py_compile.compile(${JSON.stringify(entry)}, cfile="/tmp/__codestead_check.pyc", doraise=True)`,
      "except py_compile.PyCompileError as error:",
      "    sys.stderr.write(error.msg)",
      "    sys.exit(1)",
      "",
    ].join("\n"),
  },
  javascript: {
    name: "__codestead_check.js",
    content: (entry) => [
      "const fs = require(\"fs\");",
      "const vm = require(\"vm\");",
      `const source = fs.readFileSync(${JSON.stringify(entry)}, "utf8");`,
      "try {",
      "  new vm.Script(\"(function (exports, require, module, __filename, __dirname) {\" + source + \"\\n})\", "
        + `{ filename: ${JSON.stringify(entry)} });`,
      "} catch (error) {",
      "  process.stderr.write(String(error && error.stack ? error.stack : error));",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};

const pistonStageSchema = (value: unknown): PistonStage | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stage = value as Record<string, unknown>;
  if (
    typeof stage.stdout !== "string"
    || typeof stage.stderr !== "string"
    || !(stage.code === null || Number.isSafeInteger(stage.code))
    || !(stage.signal === null || typeof stage.signal === "string")
    || !(stage.status === null || stage.status === undefined || typeof stage.status === "string")
  ) return null;
  return {
    stdout: stage.stdout,
    stderr: stage.stderr,
    code: stage.code as number | null,
    signal: stage.signal as string | null,
    status: (stage.status ?? null) as string | null,
    wallTimeMs: typeof stage.wall_time === "number" && Number.isFinite(stage.wall_time) && stage.wall_time >= 0
      ? stage.wall_time
      : 0,
  };
};

interface PistonStage {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  status: string | null;
  wallTimeMs: number;
}

type Classification =
  | "OK"
  | "FAILED"
  | "TIMEOUT"
  | "MEMORY_LIMIT"
  | "OUTPUT_LIMIT"
  | "INFRASTRUCTURE_ERROR";

function classify(stage: PistonStage): Classification {
  if (stage.status === "XX") return "INFRASTRUCTURE_ERROR";
  if (stage.status === "TO") return "TIMEOUT";
  if (stage.status === "OL" || stage.status === "EL") return "OUTPUT_LIMIT";
  if (stage.code === 0) return "OK";
  // isolate reports a cgroup OOM kill as exit 137 / SIGKILL without a status.
  if (stage.code === 137 || (stage.code === null && stage.signal === "SIGKILL")) return "MEMORY_LIMIT";
  if (stage.code === null) return "INFRASTRUCTURE_ERROR";
  return "FAILED";
}

function sanitize(value: string) {
  return value
    .replaceAll("/box/submission/", "<workspace>/")
    .replaceAll("/box/submission", "<workspace>")
    .replaceAll("\u0000", "");
}

/** Shares one output budget across every stream, like the legacy runner. */
class OutputBudget {
  truncated = false;
  constructor(private remaining: number) {}

  take(raw: string) {
    const value = sanitize(raw);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= this.remaining) {
      this.remaining -= bytes.length;
      return value;
    }
    this.truncated = true;
    const marker = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    const keep = Math.max(0, this.remaining - marker);
    // Drop a partial UTF-8 sequence at the cut.
    const kept = bytes.subarray(0, keep).toString("utf8").replace(/\uFFFD$/u, "");
    const result = this.remaining >= marker ? kept + TRUNCATION_MARKER : "";
    this.remaining -= Buffer.byteLength(result, "utf8");
    return result;
  }
}

function normalizeOutput(value: string, comparison: "EXACT" | "TRIMMED") {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (comparison === "EXACT") return lines;
  return lines.split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function testFeedback(status: string, hidden: boolean) {
  if (status === "INFRASTRUCTURE_ERROR") return status;
  const prefix = hidden ? "HIDDEN_" : "VISIBLE_";
  return status === "PASSED" ? `${prefix}PASS` : status === "FAILED" ? `${prefix}WRONG_ANSWER` : `${prefix}${status}`;
}

const TEST_STATUS_PRIORITY = ["INFRASTRUCTURE_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "RUNTIME_ERROR"] as const;

export class PistonRunnerClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly imageReference: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = RUNNER_REQUEST_TIMEOUT_MS,
  ) {
    if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/u.test(baseUrl)) throw new Error("PISTON_URL must be an http(s) origin.");
    if (!imageReference.trim()) throw new Error("PISTON_IMAGE is required for result provenance.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async checkAvailability(): Promise<RunnerAvailability> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v2/runtimes`, {
        signal: AbortSignal.timeout(RUNNER_HEALTH_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return { available: false, status: "offline", code: "RUNNER_OFFLINE" };
    }
    const runtimes = response.ok ? await response.json().catch(() => null) as unknown : null;
    const installed = new Set(Array.isArray(runtimes)
      ? runtimes.map((runtime) => `${(runtime as { language?: unknown }).language}@${(runtime as { version?: unknown }).version}`)
      : []);
    const ready = Object.values(PISTON_RUNTIMES).every((runtime) => installed.has(`${runtime.language}@${runtime.version}`));
    return ready
      ? { available: true, status: "available", queueDepth: 0, activeJobs: 0, concurrency: 2 }
      : { available: false, status: "unavailable", code: "RUNNER_UNHEALTHY" };
  }

  async submit(request: RunnerRequest, idempotencyKey: string): Promise<RunnerJobResponse> {
    return this.execute(request, `piston:${idempotencyKey}`);
  }

  /**
   * Piston keeps no job store. A job id from an earlier attempt whose result
   * was never saved is reconciled by running the same immutable request again;
   * practice runs have no side effects outside their sandbox.
   */
  async waitForJob(jobId: string, request: RunnerRequest): Promise<RunnerJobResponse> {
    return this.execute(request, jobId);
  }

  async waitFrom(job: RunnerJobResponse, request: RunnerRequest): Promise<RunnerJobResponse> {
    if (!isTrustedRunnerJob(job, request)) {
      throw new RunnerClientError("PISTON_RESPONSE_UNTRUSTED", true, 502);
    }
    return job;
  }

  private async execute(request: RunnerRequest, jobId: string): Promise<RunnerJobResponse> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId)) throw new Error("Invalid runner job id.");
    const deadline = Date.now() + this.requestTimeoutMs;
    const runtime = PISTON_RUNTIMES[request.language];
    const entry = request.sourceFiles.find((file) => file.path === request.entrypoint);
    if (!runtime || !entry) throw new RunnerClientError("PISTON_REQUEST_INVALID", false, 400);
    const others = request.sourceFiles.filter((file) => file !== entry);
    const outputBytes = request.limits?.outputBytes ?? DEFAULT_OUTPUT_BYTES;
    const budget = new OutputBudget(outputBytes);
    const runTimeoutMs = Math.min(request.limits?.wallTimeMs ?? PISTON_MAX_RUN_TIMEOUT_MS, PISTON_MAX_RUN_TIMEOUT_MS);
    const memoryBytes = (request.limits?.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
    const learnerFiles = [entry, ...others].map((file) => ({ name: file.path, content: file.content }));

    const call = (files: Array<{ name: string; content: string }>, stdin: string, runTimeout = runTimeoutMs) =>
      this.call(deadline, {
        language: runtime.language,
        version: runtime.version,
        files,
        stdin,
        run_timeout: runTimeout,
        compile_timeout: PISTON_COMPILE_TIMEOUT_MS,
        run_memory_limit: memoryBytes,
      });

    // 1. Compile (or syntax-check) once.
    const checker = CHECKERS[request.language];
    let compileStage: PistonStage;
    let compiledRun: PistonStage | null = null;
    if (checker) {
      compileStage = (await call([{ name: checker.name, content: checker.content(entry.path) }, ...learnerFiles], "")).run;
    } else {
      // Piston compiles C/C++/Java on every call; RUN reuses this call's run stage.
      const first = await call(learnerFiles, request.mode === "RUN" ? request.stdin ?? "" : "", request.mode === "RUN" ? runTimeoutMs : 1);
      if (!first.compile) throw new RunnerClientError("PISTON_RESPONSE_UNTRUSTED", true, 502);
      compileStage = first.compile;
      if (request.mode === "RUN" && classify(compileStage) === "OK") compiledRun = first.run;
    }
    const compileClass = classify(compileStage);
    const compile = {
      status: compileClass === "OK" ? "OK" : compileClass === "FAILED" ? "COMPILE_ERROR" : compileClass,
      stdout: budget.take(compileStage.stdout),
      stderr: budget.take(compileStage.stderr),
      exitCode: compileStage.code,
      wallTimeMs: compileStage.wallTimeMs,
    };
    if (compile.status !== "OK") {
      return this.completed(request, jobId, compile.status, compile, undefined, []);
    }
    if (request.mode === "COMPILE") return this.completed(request, jobId, "COMPILE_ONLY", compile, undefined, []);

    // 2. Run once (RUN) or once per test (TEST).
    if (request.mode === "RUN") {
      const stage = compiledRun ?? (await call(learnerFiles, request.stdin ?? "")).run;
      const runClass = classify(stage);
      const run = {
        stdout: budget.take(stage.stdout),
        stderr: budget.take(stage.stderr),
        exitCode: stage.code,
        wallTimeMs: stage.wallTimeMs,
      };
      const status = budget.truncated && runClass !== "TIMEOUT" && runClass !== "MEMORY_LIMIT"
        ? "OUTPUT_LIMIT"
        : runClass === "OK" ? "ACCEPTED" : runClass === "FAILED" ? "RUNTIME_ERROR" : runClass;
      return this.completed(request, jobId, status, compile, run, []);
    }

    const tests: Array<{
      id: string;
      visibility: string;
      category: string;
      status: string;
      feedbackCode: string;
      exitCode: number | null;
      wallTimeMs: number;
      actualStdout?: string;
      expectedStdout?: string;
      stderr?: string;
    }> = [];
    for (const test of request.tests ?? []) {
      const stage = (await call(learnerFiles, test.stdin)).run;
      const runClass = classify(stage);
      const testBudget = new OutputBudget(outputBytes);
      const actual = testBudget.take(stage.stdout);
      const passed = runClass === "OK" && normalizeOutput(actual, test.comparison) === normalizeOutput(test.expectedStdout, test.comparison);
      const status = runClass === "OK"
        ? passed ? "PASSED" : "FAILED"
        : runClass === "FAILED" ? "RUNTIME_ERROR" : runClass;
      tests.push({
        id: test.id,
        visibility: test.visibility,
        category: test.category,
        status,
        feedbackCode: testFeedback(status, test.visibility === "HIDDEN"),
        exitCode: stage.code,
        wallTimeMs: stage.wallTimeMs,
        ...(test.visibility === "HIDDEN"
          ? {}
          : { actualStdout: actual, expectedStdout: test.expectedStdout, stderr: testBudget.take(stage.stderr) }),
      });
    }
    const worst = TEST_STATUS_PRIORITY.find((status) => tests.some((test) => test.status === status));
    const status = worst ?? (tests.some((test) => test.status === "FAILED") ? "WRONG_ANSWER" : "ACCEPTED");
    return this.completed(request, jobId, status, compile, undefined, tests);
  }

  private completed(
    request: RunnerRequest,
    jobId: string,
    status: string,
    compile: { status: string; stdout: string; stderr: string; exitCode: number | null; wallTimeMs: number },
    run: { stdout: string; stderr: string; exitCode: number | null; wallTimeMs: number } | undefined,
    tests: Array<{ id: string; visibility: string; category: string; status: string; feedbackCode: string }>,
  ): RunnerJobResponse {
    const passed = tests.filter((test) => test.status === "PASSED").length;
    const job: RunnerJobResponse = {
      jobId,
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: createHash("sha256").update(serializeRunnerRequest(request)).digest("hex"),
      state: "COMPLETED",
      queuePosition: null,
      result: {
        status,
        imageDigest: this.imageReference,
        runtimeVersion: PISTON_RUNTIMES[request.language].label,
        compile,
        ...(run ? { run } : {}),
        tests,
        totals: { passed, failed: tests.length - passed, total: tests.length },
      },
    };
    if (!isTrustedRunnerJob(job, request)) {
      throw new RunnerClientError("PISTON_RESPONSE_UNTRUSTED", true, 502);
    }
    return job;
  }

  private async call(deadline: number, body: object): Promise<{ compile?: PistonStage; run: PistonStage }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RunnerClientError("PISTON_TIMEOUT", true, 504);
    const signal = AbortSignal.timeout(remaining);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v2/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        cache: "no-store",
      });
    } catch {
      throw signal.aborted
        ? new RunnerClientError("PISTON_TIMEOUT", true, 504)
        : new RunnerClientError("PISTON_UNREACHABLE", true, 503);
    }
    // Piston's error bodies can carry stack traces; never forward them.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RunnerClientError("PISTON_REQUEST_REJECTED", false, 502);
    }
    let raw: string;
    try {
      raw = await readBounded(response);
    } catch {
      throw new RunnerClientError("PISTON_RESPONSE_UNTRUSTED", true, 502);
    }
    const parsed = (() => {
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
    })();
    const compile = parsed?.compile === undefined ? undefined : pistonStageSchema(parsed.compile);
    // Piston may omit the run stage when compilation failed.
    const run = parsed?.run === undefined && compile && compile.code !== 0
      ? { stdout: "", stderr: "", code: null, signal: null, status: null, wallTimeMs: 0 }
      : pistonStageSchema(parsed?.run);
    if (!parsed || !run || compile === null) throw new RunnerClientError("PISTON_RESPONSE_UNTRUSTED", true, 502);
    return compile ? { compile, run } : { run };
  }
}

async function readBounded(response: Response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > PISTON_MAX_RESPONSE_BYTES) throw new Error("too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PISTON_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function configuredPistonRunnerClient() {
  const url = process.env.PISTON_URL;
  const image = process.env.PISTON_IMAGE;
  if (!url || !image) throw new Error("Piston is selected but PISTON_URL or PISTON_IMAGE is not configured.");
  return new PistonRunnerClient(url, image);
}
