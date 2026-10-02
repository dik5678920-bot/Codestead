import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

const fixtures: string[] = [];
const evidence = "docs/evidence/guard.json";
const contents = "recorded bytes\n";
const digest = createHash("sha256").update(contents).digest("hex");
const cli = path.resolve("scripts/verify-evidence-integrity.ts");
const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
const shapes = ["array", "named", "artifactSha256", "sha256", "sourceSha256", "fileSource"] as const;

function pin(shape: typeof shapes[number], target: string, hash: unknown = digest) {
  if (shape === "array") return { sourceHashes: [{ path: target, sha256: hash }] };
  if (shape === "named") return { input: target, inputSha256: hash };
  if (shape === "fileSource") return { file: target, sourceSha256: hash };
  return { [shape]: { [target]: hash } };
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=fixture",
    "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
  { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

async function write(root: string, file: string, bytes: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}

async function repository(target: string, bytes = contents) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-guard-"));
  fixtures.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  await write(root, target, bytes);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "recorded bytes");
  return { root, sourceCommit: git(root, "rev-parse", "HEAD") };
}

async function record(root: string, value: unknown) {
  await write(root, evidence, JSON.stringify(value));
  return verifyEvidenceIntegrity({ root, markdownRoots: [] });
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^evidence-guard-/);
    await rm(root, { recursive: true, force: true });
  }
});

describe("evidence path and anchor guard", () => {
  it.each(shapes)("rejects the real-Git unknown-path counterexample in %s pins", async (shape) => {
    const target = "unlisted-evidence-input.ts";
    const { root, sourceCommit } = await repository(target);
    for (const anchored of [false, true]) {
      for (const hash of ["0".repeat(64), digest]) {
        const report = await record(root, { ...(anchored ? { sourceCommit } : {}), ...pin(shape, target, hash) });
        expect(report.issues).toContainEqual(expect.objectContaining({
          kind: "INVALID_EVIDENCE_PATH", detail: expect.stringContaining(target),
        }));
        expect(report.evidence.hashes).toBe(0);
      }
    }
  });

  it("exits unsuccessfully from the CLI for all four original counterexamples", async () => {
    const target = "unlisted-evidence-input.ts";
    const { root, sourceCommit } = await repository(target);
    for (const anchored of [false, true]) {
      for (const hash of ["0".repeat(64), digest]) {
        await record(root, { ...(anchored ? { sourceCommit } : {}), ...pin("array", target, hash) });
        const result = spawnSync(process.execPath, [tsx, cli], { cwd: root, encoding: "utf8", windowsHide: true });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`INVALID_EVIDENCE_PATH ${evidence}: ${target}`);
      }
    }
  });

  it.each(shapes)("requires an anchor for live files in %s pins even when hashes match", async (shape) => {
    const target = "src/lib/example.ts";
    const { root, sourceCommit } = await repository(target);
    expect((await record(root, pin(shape, target))).issues).toContainEqual(expect.objectContaining({
      kind: "UNANCHORED_SOURCE_PIN", detail: expect.stringContaining(target),
    }));
    const accepted = await record(root, { sourceCommit, ...pin(shape, target) });
    expect(accepted.issues).toEqual([]);
    expect(accepted.evidence.hashes).toBe(1);
  });

  it.each(["package.json", "vitest.integration.config.ts", "evals/ai-tutor/v1/golden-cases.json"])(
    "checks recognized %s pins and requires anchoring", async (target) => {
      const { root, sourceCommit } = await repository(target);
      expect((await record(root, { sourceCommit, ...pin("sourceSha256", target) })).issues).toEqual([]);
      expect((await record(root, pin("sourceSha256", target))).issues).toContainEqual(
        expect.objectContaining({ kind: "UNANCHORED_SOURCE_PIN" }),
      );
    },
  );

  it.each(shapes)("checks immutable artifacts at HEAD in %s pins, including anchored records", async (shape) => {
    const target = "docs/evidence/runtime.json";
    const { root, sourceCommit } = await repository(target, "{}\n");
    const currentDigest = createHash("sha256").update("{}\n").digest("hex");
    for (const anchor of [{}, { sourceCommit }]) {
      expect((await record(root, { ...anchor, ...pin(shape, target, currentDigest) })).issues).toEqual([]);
      expect((await record(root, { ...anchor, ...pin(shape, target, digest) })).issues).toContainEqual(
        expect.objectContaining({ kind: "STALE_HASH", detail: expect.stringContaining(target) }),
      );
    }
    await write(root, target, '{"version":2}\n');
    const changedDigest = createHash("sha256").update('{"version":2}\n').digest("hex");
    // Neither a matching historical artifact nor matching HEAD bytes can
    // bypass the other integrity check in an anchored record.
    for (const hash of [currentDigest, changedDigest]) {
      expect((await record(root, { sourceCommit, ...pin(shape, target, hash) })).issues)
        .toContainEqual(expect.objectContaining({ kind: "STALE_HASH" }));
    }
  });

  it("verifies sourceSha256 after source edits/removal and rejects tampering", async () => {
    const target = "src/lib/example.ts";
    const { root, sourceCommit } = await repository(target);
    await write(root, target, "later bytes\n");
    git(root, "commit", "--quiet", "-am", "later source");
    expect((await record(root, { sourceCommit, ...pin("sourceSha256", target) })).issues).toEqual([]);
    await unlink(path.join(root, target));
    expect((await record(root, { sourceCommit, ...pin("sourceSha256", target) })).issues).toEqual([]);
    expect((await record(root, { sourceCommit, ...pin("sourceSha256", target, "0".repeat(64)) })).issues)
      .toContainEqual(expect.objectContaining({ kind: "STALE_HASH", detail: expect.stringContaining(`${target}@${sourceCommit}`) }));
    expect((await record(root, { sourceCommit: "0".repeat(40), ...pin("sourceSha256", target) })).issues)
      .toContainEqual(expect.objectContaining({ kind: "SOURCE_COMMIT_UNAVAILABLE" }));
  });

  it.each(shapes)("rejects malformed digests in %s pins", async (shape) => {
    const target = "src/lib/example.ts";
    const { root, sourceCommit } = await repository(target);
    for (const hash of ["latest", 42, null]) {
      expect((await record(root, { sourceCommit, ...pin(shape, target, hash) })).issues)
        .toContainEqual(expect.objectContaining({ kind: "INVALID_SOURCE_DECLARATION" }));
    }
  });

  it.each(["../outside.ts", "/tmp/source.ts", "C:\\tmp\\source.ts", "https://example.test/source.ts", "other/source.ts"])(
    "rejects an unsafe or unlisted pin %s", async (target) => {
      const { root, sourceCommit } = await repository("src/lib/example.ts");
      for (const shape of shapes) {
        expect((await record(root, { sourceCommit, ...pin(shape, target) })).issues)
          .toContainEqual(expect.objectContaining({ kind: "INVALID_EVIDENCE_PATH", detail: target }));
      }
    },
  );

  it("does not extend the auth-recovery live-worker exemption to other pins or new records", async () => {
    const target = "scripts/process-outbox.ts";
    const { root } = await repository(target);
    const auth = "docs/evidence/auth-recovery-verification-2026-07-12.json";
    await write(root, auth, JSON.stringify({ sourceSha256: { [target]: digest } }));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([]);
    await write(root, target, "drift\n");
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues)
      .toContainEqual(expect.objectContaining({ kind: "STALE_HASH", source: auth }));
    await write(root, target, contents);
    expect((await record(root, pin("sourceSha256", target))).issues)
      .toContainEqual(expect.objectContaining({ kind: "UNANCHORED_SOURCE_PIN", source: evidence }));
    await write(root, "scripts/other.ts", contents);
    await write(root, auth, JSON.stringify({ sourceSha256: { [target]: digest, "scripts/other.ts": digest } }));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues)
      .toContainEqual(expect.objectContaining({ kind: "UNANCHORED_SOURCE_PIN", detail: expect.stringContaining("scripts/other.ts") }));
  });

  it("keeps deterministic authorization source projections current without exempting their maps", async () => {
    const target = "src/lib/example.ts";
    const { root, sourceCommit } = await repository(target);
    const file = "docs/evidence/api-authorization-matrix-2026-07-12.json";
    await write(root, file, JSON.stringify({ sourceCommit, supportingOwnershipProofs: [pin("fileSource", target)] }));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([]);
    await write(root, target, "drift\n");
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues)
      .toContainEqual(expect.objectContaining({ kind: "STALE_HASH", source: file }));
    await write(root, target, contents);
    await write(root, file, JSON.stringify(pin("sourceSha256", target)));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues)
      .toContainEqual(expect.objectContaining({ kind: "UNANCHORED_SOURCE_PIN", source: file }));
  });

  it("distinguishes named metadata and route/file references from declared pins", async () => {
    const { root } = await repository("src/lib/example.ts");
    expect((await record(root, {
      generatedAt: "2026-07-14T00:00:00.000Z", generatedAtSha256: digest,
      externalReport: "https://example.test/report.json", externalReportSha256: digest,
      requests: [{ path: "/courses" }], file: "src/lib/example.ts",
    })).issues).toEqual([]);
    // A declared digest always makes path a pin, even if it resembles a route.
    expect((await record(root, { path: "/courses", sha256: digest })).issues)
      .toContainEqual(expect.objectContaining({ kind: "INVALID_EVIDENCE_PATH" }));
  });
});
