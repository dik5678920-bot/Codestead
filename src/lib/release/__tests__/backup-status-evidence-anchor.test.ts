import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

const repositoryRoot = process.cwd();
const evidencePath = "docs/evidence/backup-status-outbox-2026-07-12.json";
const ciPath = ".github/workflows/ci.yml";
type BackupEvidence = {
  sourceCommit?: string;
  note?: string;
  sourceHashes: { path: string; sha256: string }[];
  [key: string]: unknown;
};
const shipped: BackupEvidence = JSON.parse(readFileSync(path.join(repositoryRoot, evidencePath), "utf8"));
let root: string;
let proofCommit: string;
let record: BackupEvidence;

function git(directory: string, ...args: string[]) {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, windowsHide: true });
}

async function write(target: string, contents: string | Buffer) {
  const absolute = path.join(root, target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function verify() {
  return verifyEvidenceIntegrity({ root, markdownRoots: [] });
}

beforeAll(async () => {
  expect(shipped.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  root = await mkdtemp(path.join(os.tmpdir(), "backup-evidence-anchor-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  for (const pin of shipped.sourceHashes) {
    // Reconstruct the actual recorded source bytes in a disposable real repo.
    await write(pin.path, git(repositoryRoot, "cat-file", "blob", `${shipped.sourceCommit}:${pin.path}`));
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "recorded source bytes");
  proofCommit = git(root, "rev-parse", "HEAD").toString("utf8").trim();
  await write(ciPath, "# later CI changes must not rewrite historical evidence\n");
  git(root, "commit", "--quiet", "-am", "later CI change");
});

beforeEach(async () => {
  record = { ...structuredClone(shipped), sourceCommit: proofCommit };
  await write(evidencePath, JSON.stringify(record));
});

afterAll(async () => {
  if (root) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^backup-evidence-anchor-/);
    await rm(root, { recursive: true, force: true });
  }
});

describe("backup status evidence anchor", () => {
  it("retains the shipped source pins and an explicit anchoring note", () => {
    expect(shipped.note).toEqual(expect.any(String));
    expect(shipped.note?.trim().length).toBeGreaterThan(0);
    git(repositoryRoot, "merge-base", "--is-ancestor", shipped.sourceCommit!, "HEAD");
    for (const pin of shipped.sourceHashes) {
      const blob = git(repositoryRoot, "cat-file", "blob", `${shipped.sourceCommit}:${pin.path}`);
      const raw = createHash("sha256").update(blob).digest("hex");
      const canonical = createHash("sha256").update(blob.toString("utf8").replaceAll("\r\n", "\n")).digest("hex");
      expect([raw, canonical], pin.path).toContain(pin.sha256);
    }
  });

  it("checks every shipped pin against its blob after CI changes and working-tree removal", async () => {
    expect((await verify()).issues).toEqual([]);
    await unlink(path.join(root, ciPath));
    const report = await verify();
    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(shipped.sourceHashes.length);
  });

  it.each([ciPath, "vitest.integration.config.ts"])("rejects a tampered %s pin instead of using current source", async (target) => {
    const pin = record.sourceHashes.find((pin) => pin.path === target)!;
    pin.sha256 = "0".repeat(64);
    await write(evidencePath, JSON.stringify(record));
    expect((await verify()).issues).toEqual([
      expect.objectContaining({ kind: "STALE_HASH", source: evidencePath, detail: expect.stringContaining(`${target}@${proofCommit}`) }),
    ]);
  });

  it("also rejects a tampered integration-config pin in an unanchored record", async () => {
    await write(evidencePath, JSON.stringify({ sourceHashes: [{ path: "vitest.integration.config.ts", sha256: "0".repeat(64) }] }));
    expect((await verify()).issues).toEqual([
      expect.objectContaining({ kind: "STALE_HASH", source: evidencePath, detail: expect.stringContaining("vitest.integration.config.ts") }),
    ]);
  });

  it.each([
    ["HEAD", "INVALID_SOURCE_COMMIT"],
    ["0".repeat(40), "SOURCE_COMMIT_UNAVAILABLE"],
  ])("fails closed for sourceCommit %s", async (anchor, kind) => {
    record.sourceCommit = anchor;
    await write(evidencePath, JSON.stringify(record));
    expect((await verify()).issues).toEqual([expect.objectContaining({ kind, source: evidencePath })]);
  });
});
