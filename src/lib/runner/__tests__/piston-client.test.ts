import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredPracticeRunnerClient,
  isTrustedRunnerJob,
  RunnerClient,
  runtimeByLanguage,
  type RunnerLanguage,
  type RunnerRequest,
} from "../client";
import { PISTON_RUNTIMES, PistonRunnerClient } from "../piston-client";
import { PRACTICE_LIMITS } from "../practice-dispatch";

const IMAGE = "codestead-piston:test@sha256:" + "a".repeat(64);
const languages: RunnerLanguage[] = ["c", "cpp", "java", "python", "javascript"];

type PistonStage = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  status?: string | null;
  message?: string | null;
  memory?: number;
  wall_time?: number;
};
type PistonCall = {
  language: string;
  version: string;
  files: Array<{ name: string; content: string }>;
  stdin: string;
  run_timeout: number;
  compile_timeout: number;
  run_memory_limit: number;
};

function stage(overrides: PistonStage = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    status: null,
    message: null,
    memory: 1000,
    wall_time: 5,
    ...overrides,
  };
}

function fakePiston(handler: (call: PistonCall) => { compile?: PistonStage; run: PistonStage } | Response) {
  const calls: PistonCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v2/runtimes")) {
      return Response.json(Object.values(PISTON_RUNTIMES).map((runtime) => ({
        language: runtime.language,
        version: runtime.version,
        aliases: [],
      })));
    }
    const call = JSON.parse(String(init?.body)) as PistonCall;
    calls.push(call);
    const outcome = handler(call);
    if (outcome instanceof Response) return outcome;
    return Response.json({
      language: call.language,
      version: call.version,
      ...(outcome.compile ? { compile: stage(outcome.compile) } : {}),
      run: stage(outcome.run),
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function request(language: RunnerLanguage, mode: RunnerRequest["mode"] = "RUN", extra: Partial<RunnerRequest> = {}): RunnerRequest {
  const runtime = runtimeByLanguage[language];
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    correlationId: "practice:22222222-2222-4222-8222-222222222222",
    language,
    runtimeVersion: runtime.version,
    mode,
    sourceFiles: [{ path: runtime.entrypoint, content: "source" }],
    entrypoint: runtime.entrypoint,
    stdin: "x\n",
    limits: { ...PRACTICE_LIMITS },
    ...extra,
  };
}

function client(fetchImpl: typeof fetch) {
  return new PistonRunnerClient("http://piston:2000", IMAGE, fetchImpl);
}

const isCheckCall = (call: PistonCall) => call.files[0]?.name.startsWith("__codestead_check");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Piston practice runner client", () => {
  it.each(languages)("returns a trusted legacy-shaped ACCEPTED result for %s", async (language) => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { ...(["c", "cpp"].includes(language) ? { compile: { code: 0 } } : {}), run: { stdout: "x\nhello\n" } });
    const runnerRequest = request(language);
    const job = await client(piston.fetchImpl).submit(runnerRequest, "33333333-3333-4333-8333-333333333333");

    expect(job.state).toBe("COMPLETED");
    expect(job.result?.status).toBe("ACCEPTED");
    expect(job.result?.run).toMatchObject({ stdout: "x\nhello\n", stderr: "", exitCode: 0 });
    expect(job.result?.imageDigest).toBe(IMAGE);
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
    const runCall = piston.calls.at(-1)!;
    expect(runCall).toMatchObject({
      language: PISTON_RUNTIMES[language].language,
      version: PISTON_RUNTIMES[language].version,
      stdin: "x\n",
      run_memory_limit: PRACTICE_LIMITS.memoryMb * 1024 * 1024,
    });
    expect(runCall.run_timeout).toBeLessThanOrEqual(PRACTICE_LIMITS.wallTimeMs);
    expect(runCall.files.map((file) => file.content)).toContain("source");
  });

  it.each([
    ["c", { compile: { code: 1, stderr: "/box/submission/main.c:1: error: x undeclared" }, run: { code: null } }],
    ["cpp", { compile: { code: 1, stderr: "/box/submission/main.cpp:1: error" }, run: { code: null } }],
  ] as const)("maps a %s compiler failure to COMPILE_ERROR without running", async (language, outcome) => {
    const piston = fakePiston(() => outcome);
    const job = await client(piston.fetchImpl).submit(request(language), "id");
    expect(job.result?.status).toBe("COMPILE_ERROR");
    expect(job.result?.compile.status).toBe("COMPILE_ERROR");
    expect(job.result?.compile.stderr).not.toContain("/box/submission");
    expect(job.result?.compile.stderr).toContain("<workspace>");
    expect(job.result?.run).toBeUndefined();
  });

  it.each(["python", "javascript", "java"] as const)(
    "checks %s syntax first and reports COMPILE_ERROR without running the program",
    async (language) => {
      const piston = fakePiston((call) => isCheckCall(call)
        ? { run: { code: 1, stderr: "SyntaxError: invalid syntax" } }
        : { run: { stdout: "should not run" } });
      const job = await client(piston.fetchImpl).submit(request(language), "id");
      expect(job.result?.status).toBe("COMPILE_ERROR");
      expect(job.result?.compile).toMatchObject({ status: "COMPILE_ERROR", exitCode: 1 });
      expect(job.result?.compile.stderr).toContain("SyntaxError");
      expect(piston.calls).toHaveLength(1);
      expect(piston.calls[0]!.files.some((file) => file.content === "source")).toBe(true);
    },
  );

  it.each([
    [{ status: "TO", code: null, signal: "SIGKILL" }, "TIMEOUT"],
    [{ status: "RE", code: 137 }, "MEMORY_LIMIT"],
    [{ status: "OL", code: null, signal: "SIGKILL", stdout: "y".repeat(100) }, "OUTPUT_LIMIT"],
    [{ status: "EL", code: null, signal: "SIGKILL" }, "OUTPUT_LIMIT"],
    [{ status: "RE", code: 3, stderr: "boom" }, "RUNTIME_ERROR"],
    [{ status: "XX", code: null, message: "internal" }, "INFRASTRUCTURE_ERROR"],
  ] as const)("maps Piston run outcome %j to %s", async (outcome, expected) => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: outcome });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");
    expect(job.result?.status).toBe(expected);
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("caps combined output at the requested byte limit on our side", async () => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { run: { stdout: "o".repeat(70_000), stderr: "e".repeat(70_000) } });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");
    const run = job.result!.run!;
    expect(Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr)).toBeLessThanOrEqual(PRACTICE_LIMITS.outputBytes);
    expect(job.result?.status).toBe("OUTPUT_LIMIT");
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("compiles only in COMPILE mode", async () => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: { stdout: "ran" } });
    const job = await client(piston.fetchImpl).submit(request("python", "COMPILE"), "id");
    expect(job.result?.status).toBe("COMPILE_ONLY");
    expect(job.result?.run).toBeUndefined();
    expect(piston.calls.every(isCheckCall)).toBe(true);
  });

  it("grades TEST mode in the app, sending only each test's stdin", async () => {
    const piston = fakePiston((call) => isCheckCall(call)
      ? { run: { code: 0 } }
      : { run: { stdout: call.stdin === "1\n" ? "2\n" : "wrong\n" } });
    const tests = [
      { id: "t1", visibility: "VISIBLE" as const, category: "basic", stdin: "1\n", expectedStdout: "2\n", comparison: "EXACT" as const },
      { id: "t2", visibility: "HIDDEN" as const, category: "edge", stdin: "5\n", expectedStdout: "10", comparison: "TRIMMED" as const },
    ];
    const runnerRequest = request("python", "TEST", { tests, stdin: undefined });
    const job = await client(piston.fetchImpl).submit(runnerRequest, "id");

    expect(job.result?.status).toBe("WRONG_ANSWER");
    expect(job.result?.totals).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(job.result?.tests.map((test) => [test.id, test.status, test.feedbackCode])).toEqual([
      ["t1", "PASSED", "VISIBLE_PASS"],
      ["t2", "FAILED", "HIDDEN_WRONG_ANSWER"],
    ]);
    expect(job.result?.tests[1]).not.toHaveProperty("expectedStdout");
    expect(piston.calls.flatMap((call) => [call.stdin, ...call.files.map((file) => file.content)]).join("\n")).not.toContain("10");
    expect(isTrustedRunnerJob(job, runnerRequest)).toBe(true);
  });

  it("fails closed on a Piston HTTP error instead of inventing a result", async () => {
    const piston = fakePiston(() => new Response(JSON.stringify({ message: "runtime is unknown" }), { status: 400 }));
    await expect(client(piston.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({
      code: "PISTON_REQUEST_REJECTED",
      retryable: false,
    });
  });

  it("fails closed when Piston is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(client(fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_UNREACHABLE" });
  });

  it("rejects an oversized or malformed Piston response", async () => {
    const big = fakePiston(() => new Response("x".repeat(3 * 1024 * 1024), { status: 200 }));
    await expect(client(big.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_RESPONSE_UNTRUSTED" });
    const bad = fakePiston(() => Response.json({ run: { stdout: 5 } }));
    await expect(client(bad.fetchImpl).submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_RESPONSE_UNTRUSTED" });
  });

  it("aborts a Piston call that outlives our own deadline", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const shortDeadline = new PistonRunnerClient("http://piston:2000", IMAGE, fetchImpl, 50);
    await expect(shortDeadline.submit(request("python"), "id")).rejects.toMatchObject({ code: "PISTON_TIMEOUT" });
  });

  it("reports availability from the installed runtimes", async () => {
    const ok = fakePiston(() => ({ run: {} }));
    await expect(client(ok.fetchImpl).checkAvailability()).resolves.toMatchObject({ available: true, status: "available" });

    const missing = vi.fn(async () => Response.json([{ language: "python", version: "3.12.0" }])) as unknown as typeof fetch;
    await expect(client(missing).checkAvailability()).resolves.toEqual({ available: false, status: "unavailable", code: "RUNNER_UNHEALTHY" });

    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(client(down).checkAvailability()).resolves.toEqual({ available: false, status: "offline", code: "RUNNER_OFFLINE" });
  });

  it("re-executes when asked to reconcile a job id it never stored", async () => {
    const piston = fakePiston((call) => isCheckCall(call) ? { run: { code: 0 } } : { run: { stdout: "again" } });
    const runnerRequest = request("python");
    const job = await client(piston.fetchImpl).waitForJob("piston:previous", runnerRequest);
    expect(job.jobId).toBe("piston:previous");
    expect(job.result?.run?.stdout).toBe("again");
  });
});

describe("practice runner provider selection", () => {
  it("defaults to the legacy runner", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "");
    vi.stubEnv("RUNNER_BASE_URL", "http://runner:4100");
    vi.stubEnv("RUNNER_SHARED_SECRET", "s".repeat(40));
    expect(configuredPracticeRunnerClient()).toBeInstanceOf(RunnerClient);
  });

  it("selects Piston only when explicitly configured", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    vi.stubEnv("PISTON_IMAGE", IMAGE);
    expect(configuredPracticeRunnerClient()).toBeInstanceOf(PistonRunnerClient);
  });

  it("fails closed instead of falling back to legacy when Piston is selected but not configured", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "");
    vi.stubEnv("PISTON_IMAGE", "");
    vi.stubEnv("RUNNER_BASE_URL", "http://runner:4100");
    vi.stubEnv("RUNNER_SHARED_SECRET", "s".repeat(40));
    expect(() => configuredPracticeRunnerClient()).toThrow(/Piston/);
  });

  it("rejects an unknown provider", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "judge0");
    expect(() => configuredPracticeRunnerClient()).toThrow(/CODE_RUNNER_PROVIDER/);
  });
});
