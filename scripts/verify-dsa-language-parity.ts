import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ContentRepository,
  DSA_PARITY_LANGUAGES,
  validateDsaLanguageParity,
  type CodeAssessmentItem,
} from "../src/lib/content";
import {
  LOCAL_RUNTIME_IDENTITY_LIMITATION,
  projectRuntimeIdentityEvidence,
  validateLocalRuntimeIdentity,
  type LocalRuntimeIdentityEvidence,
} from "./lib/local-runtime-identity";
import { verifyOrApplyDeterministicEvidence } from "./lib/deterministic-evidence";

type Language = "c" | "cpp" | "java" | "python";
const root = process.cwd();
const imageTags: Readonly<Record<Language, string>> = {
  c: "learncoding/runtime-c:local",
  cpp: "learncoding/runtime-cpp:local",
  java: "learncoding/runtime-java:local",
  python: "learncoding/runtime-python:local",
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type ParityResult = {
  itemId: string;
  skillId: string;
  language: string;
  visibility: string;
  status: "passed" | "failed";
  sourceHash: string;
  failure?: string;
};

// CI can run the full runtime case list as N shards. A shard executes every
// N-th case and writes only a partial result file; --merge-shards re-derives
// the complete case list from content, requires every case exactly once with
// matching identity and source hash, and then performs the normal deterministic
// evidence check, so the merged run is byte-identical to an unsharded run.
const shardDirectory = path.join(root, "services", "runner", "dist", "dsa-parity-shards");
const shardPath = (index: number, count: number) => path.join(shardDirectory, `shard-${index}-of-${count}.json`);

function parseShardArguments(argv: readonly string[]): { shard?: { index: number; count: number }; mergeCount?: number } {
  const shardArguments = argv.filter((argument) => argument.startsWith("--shard="));
  const mergeArguments = argv.filter((argument) => argument.startsWith("--merge-shards="));
  if (shardArguments.length > 1 || mergeArguments.length > 1 || (shardArguments.length > 0 && mergeArguments.length > 0)) {
    throw new Error("Provide at most one of --shard=I/N or --merge-shards=N, once.");
  }
  if (shardArguments[0] !== undefined) {
    const match = /^--shard=([1-8])\/([2-8])$/.exec(shardArguments[0]);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!match || index > count) throw new Error("--shard must be I/N with 1 <= I <= N and 2 <= N <= 8.");
    return { shard: { index, count } };
  }
  if (mergeArguments[0] !== undefined) {
    const match = /^--merge-shards=([2-8])$/.exec(mergeArguments[0]);
    if (!match) throw new Error("--merge-shards must be N with 2 <= N <= 8.");
    return { mergeCount: Number(match[1]) };
  }
  return {};
}

function exactResult(value: unknown, item: CodeAssessmentItem, visibility: string): ParityResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Shard result is not an object.");
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const expectedKeys = status === "failed"
    ? ["failure", "itemId", "language", "skillId", "sourceHash", "status", "visibility"]
    : ["itemId", "language", "skillId", "sourceHash", "status", "visibility"];
  if (
    Object.keys(candidate).sort().join(",") !== expectedKeys.join(",")
    || (status !== "passed" && status !== "failed")
    || candidate.itemId !== item.id
    || candidate.skillId !== item.skillId
    || candidate.language !== item.runtime.language
    || candidate.visibility !== visibility
    || candidate.sourceHash !== digest(item.answer.referenceSolution)
    || (status === "failed" && typeof candidate.failure !== "string")
  ) {
    throw new Error(`Shard result does not match the authored case for ${item.id}.`);
  }
  return {
    itemId: item.id,
    skillId: item.skillId,
    language: item.runtime.language,
    visibility,
    status,
    sourceHash: digest(item.answer.referenceSolution),
    ...(status === "failed" ? { failure: candidate.failure as string } : {}),
  };
}
function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status === 0;
}

async function execute(
  item: CodeAssessmentItem,
  stdin: string,
  imageReference: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const language = item.runtime.language as Language;
  const directory = mkdtempSync(path.join(os.tmpdir(), `lc-dsa-${language}-`));
  const file = path.join(directory, item.runtime.entrypoint);
  writeFileSync(file, item.answer.referenceSolution, { encoding: "utf8", mode: 0o444 });
  try {
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
  } catch {
    // Docker Desktop manages bind permissions.
  }
  const name = `lc-dsa-${language}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never", "--network", "none",
    "--ipc", "none", "--log-driver", "none", "--read-only", "--init", "--stop-timeout", "1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
    "--memory", `${item.runtime.memoryLimitMb}m`, "--memory-swap", `${item.runtime.memoryLimitMb}m`, "--cpus", "0.5",
    "--ulimit", "fsize=16777216:16777216", "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    "--mount", `type=bind,src=${directory},dst=/input,readonly`, imageReference,
    "/opt/runner/execute", "--mode", "run", "--language", language,
    "--source-root", "/input", "--entrypoint", `/input/${item.runtime.entrypoint}`,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
    }, Math.max(15_000, item.runtime.timeLimitMs * 5));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", windowsHide: true });
      rmSync(directory, { recursive: true, force: true });
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(stdin);
  });
}

async function main(): Promise<void> {
  const repository = new ContentRepository({ contentRoot: path.join(root, "content") });
  const [course, authored] = await Promise.all([
    repository.getCourse("dsa"),
    repository.getAuthoredContentSet(),
  ]);
  if (!course) throw new Error("DSA course is missing.");
  const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id));
  const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "dsa");
  const structure = validateDsaLanguageParity(banks, declared);
  const items = banks
    .flatMap((bank) => bank.items)
    .filter((item): item is CodeAssessmentItem => item.kind === "code" && item.parity !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const structureOnly = process.argv.includes("--structure-only");
  const limitArguments = process.argv.filter((argument) => /^--limit/.test(argument));
  if (limitArguments.length > 1 || (limitArguments[0] !== undefined && !/^--limit=[1-9]\d*$/.test(limitArguments[0]))) {
    throw new Error("--limit must be provided once as a positive integer.");
  }
  const limit = limitArguments[0] ? Number.parseInt(limitArguments[0].slice("--limit=".length), 10) : items.length;
  const selected = items.slice(0, limit);
  const sharding = parseShardArguments(process.argv.slice(2));
  const shard = sharding.shard;
  const mergeCount = sharding.mergeCount;
  if ((shard || mergeCount) && (structureOnly || limitArguments.length > 0)) {
    throw new Error("--shard and --merge-shards require the complete runtime case list.");
  }

  let runtimeIdentities: Readonly<Record<string, LocalRuntimeIdentityEvidence>> = {};
  let imageEvidence: Readonly<Record<string, unknown>> = Object.fromEntries(
    DSA_PARITY_LANGUAGES.map((language) => [language, {
      tag: imageTags[language],
      manifestDigest: structure.imageDigests[language],
      configDigest: null,
      immutableReference: null,
      tagDescriptorDigest: null,
      tagImageId: null,
      exactReferenceDescriptorDigest: null,
      exactReferenceImageId: null,
      independentlyValidated: false,
    }]),
  );
  if (!structureOnly && !mergeCount) {
    if (!dockerAvailable()) {
      throw new Error("Docker is unavailable; use --structure-only only when runtime execution is intentionally deferred.");
    }
    const runtimeManifestPath = path.join(root, "services", "runner", "dist", "runtime-local-build-identities.json");
    const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8")) as unknown;
    runtimeIdentities = validateLocalRuntimeIdentity({
      manifest: runtimeManifest,
      expectations: DSA_PARITY_LANGUAGES.map((language) => ({
        language,
        tag: imageTags[language],
        declaredContentDigest: structure.imageDigests[language],
      })),
    });
    imageEvidence = Object.fromEntries(DSA_PARITY_LANGUAGES.map((language) => {
      const runtimeIdentity = runtimeIdentities[language];
      if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${language}.`);
      return [language, projectRuntimeIdentityEvidence(runtimeIdentity)];
    }));
  }

  const jobs = selected.flatMap((item) => item.tests.map((test) => ({ item, test })));
  const results: ParityResult[] = [];
  const assigned = jobs.map((_, index) => index).filter((index) => !shard || index % shard.count === shard.index - 1);
  let next = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (next >= assigned.length) return;
      const index = assigned[next++]!;
      const { item, test } = jobs[index]!;
      try {
        const runtimeIdentity = runtimeIdentities[item.runtime.language];
        if (!runtimeIdentity) throw new Error(`Validated local runtime identity is missing for ${item.runtime.language}.`);
        const result = await execute(item, test.stdin, runtimeIdentity.immutableReference);
        const actual = test.comparison === "trimmed" ? result.stdout.trim() : result.stdout;
        const expected = test.comparison === "trimmed" ? test.expectedStdout.trim() : test.expectedStdout;
        if (result.timedOut || result.code !== 0 || actual !== expected) {
          throw new Error(result.timedOut ? "timeout" : result.code !== 0 ? `runner exit ${result.code}` : "stdout mismatch");
        }
        results[index] = {
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          visibility: test.visibility,
          status: "passed",
          sourceHash: digest(item.answer.referenceSolution),
        };
      } catch (error) {
        results[index] = {
          itemId: item.id,
          skillId: item.skillId,
          language: item.runtime.language,
          visibility: test.visibility,
          status: "failed",
          sourceHash: digest(item.answer.referenceSolution),
          failure: error instanceof Error ? error.message : String(error),
        };
      }
      completed += 1;
      if (completed % 40 === 0 || completed === assigned.length) {
        console.log(`DSA parity runtime progress: ${completed}/${assigned.length} cases.`);
      }
    }
  }
  if (!structureOnly && !mergeCount) await Promise.all([worker(), worker()]);

  if (shard) {
    const shardFailures = assigned.filter((index) => results[index]?.status !== "passed").length;
    await mkdir(shardDirectory, { recursive: true });
    await writeFile(shardPath(shard.index, shard.count), `${JSON.stringify({
      schemaVersion: 1,
      shard,
      declaredItems: items.length,
      jobCount: jobs.length,
      imageEvidence,
      cases: assigned.map((index) => ({ index, result: results[index] })),
    }, null, 2)}\n`);
    console.log(`DSA parity runtime shard ${shard.index}/${shard.count}: ${assigned.length} executed cases, ${shardFailures} failures.`);
    if (shardFailures) process.exitCode = 1;
    return;
  }

  if (mergeCount) {
    let mergedImageEvidence: string | undefined;
    for (let index = 1; index <= mergeCount; index += 1) {
      const partial = JSON.parse(await readFile(shardPath(index, mergeCount), "utf8")) as {
        schemaVersion?: unknown;
        shard?: { index?: unknown; count?: unknown };
        declaredItems?: unknown;
        jobCount?: unknown;
        imageEvidence?: unknown;
        cases?: unknown;
      };
      if (
        partial.schemaVersion !== 1
        || partial.shard?.index !== index
        || partial.shard?.count !== mergeCount
        || partial.declaredItems !== items.length
        || partial.jobCount !== jobs.length
        || !Array.isArray(partial.cases)
      ) {
        throw new Error(`DSA parity shard ${index}/${mergeCount} does not match the authored case list.`);
      }
      const shardImageEvidence = JSON.stringify(partial.imageEvidence);
      if (mergedImageEvidence === undefined) mergedImageEvidence = shardImageEvidence;
      else if (mergedImageEvidence !== shardImageEvidence) {
        throw new Error("DSA parity shards executed against different runtime image identities.");
      }
      for (const entry of partial.cases as Array<{ index?: unknown; result?: unknown }>) {
        const caseIndex = entry.index;
        if (
          typeof caseIndex !== "number"
          || !Number.isInteger(caseIndex)
          || caseIndex < 0
          || caseIndex >= jobs.length
          || caseIndex % mergeCount !== index - 1
          || results[caseIndex] !== undefined
        ) {
          throw new Error(`DSA parity shard ${index}/${mergeCount} contains an unassigned or duplicate case.`);
        }
        const { item, test } = jobs[caseIndex]!;
        results[caseIndex] = exactResult(entry.result, item, test.visibility);
      }
    }
    for (let caseIndex = 0; caseIndex < jobs.length; caseIndex += 1) {
      if (results[caseIndex] === undefined) throw new Error(`DSA parity shards are missing case ${caseIndex}.`);
    }
    imageEvidence = JSON.parse(mergedImageEvidence ?? "null") as Readonly<Record<string, unknown>>;
  }

  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === items.length;
  const buildEvidence = () => ({
    structure,
    selectedItems: selected.length,
    declaredItems: items.length,
    executedCases: results.length,
    passedCases: results.length - failures.length,
    failedCases: failures.length,
    fullRuntimeRun,
    externalProviderCalls: 0,
    imageEvidence,
    results,
    limitations: [
      "All content remains AI-assisted draft with zero exam eligibility.",
      "Numeric module-scoped contracts prove deterministic four-runtime equivalence, not human-reviewed pedagogy or idiomatic language quality.",
      LOCAL_RUNTIME_IDENTITY_LIMITATION,
      "Local Docker execution does not prove production KVM/NUC deployment, isolation, recovery, or capacity.",
    ],
  });
  const reportName = structureOnly
    ? "dsa-parity-structure-2026-07-12.json"
    : fullRuntimeRun
      ? "dsa-parity-runtime-2026-07-12.json"
      : "dsa-parity-sample-2026-07-12.json";
  await verifyOrApplyDeterministicEvidence({
    argv: process.argv.slice(2),
    root,
    trustedDirectory: "exclusive-writer",
    relativePath: path.join("docs", "evidence", reportName),
    buildEvidence,
    applyCommand: structureOnly
      ? "npm run dsa:parity:structure:apply"
      : mergeCount
        ? `npm run dsa:parity:evidence:apply -- --merge-shards=${mergeCount}`
        : fullRuntimeRun
          ? "npm run dsa:parity:evidence:apply"
          : `npm run dsa:parity:evidence:apply -- --limit=${selected.length}`,
    allowArgument: (argument) => argument === "--structure-only"
      || /^--limit=[1-9]\d*$/.test(argument)
      || /^--merge-shards=[2-8]$/.test(argument),
  });
  console.log(`DSA parity ${structureOnly ? "structure" : "runtime"} verification: ${structure.skillCount} skills, ${structure.itemCount} items, ${results.length} executed cases, ${failures.length} failures, full=${fullRuntimeRun}.`);
  if (failures.length || (process.argv.includes("--check") && !structureOnly && !fullRuntimeRun)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
