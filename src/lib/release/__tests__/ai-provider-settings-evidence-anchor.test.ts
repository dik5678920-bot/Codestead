import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

type SourceRecord = {
  sourceCommit?: string;
  note?: string;
  artifactSha256: Record<string, string>;
  [key: string]: unknown;
};
const repositoryRoot = process.cwd();
const retiredTool = "scripts/refresh-ai-provider-evidence-bindings.mjs";
const records = [
  ["docs/evidence/ai-provider-settings-2026-10-01.json", 29],
  ["docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json", 22],
  ["docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json", 14],
  ["docs/evidence/ai-provider-settings-ci-followup-2026-10-01.json", 11],
] as const;
const logKeys = new Set([
  "evidenceChanges", "historicalEvidence", "ciPinFollowup", "rebaseBindingRefresh",
  "schemaQualificationRefresh", "ciFollowupRefresh", "addedEvidenceMetadata",
  "evidenceBindingChanges", "metadataAdditions", "previousDigest", "currentDigest", "previousSha256",
]);
const fixtures: string[] = [];

function shipped(file: string): SourceRecord {
  return JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8"));
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, windowsHide: true }).trim();
}

async function write(root: string, file: string, contents: string) {
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function repository(file: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-provider-evidence-anchor-"));
  fixtures.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  const artifactSha256: Record<string, string> = {};
  for (const target of Object.keys(shipped(file).artifactSha256)) {
    if (target.startsWith("docs/evidence/") || target === retiredTool) continue;
    const contents = `fixture source bytes for ${target}\n`;
    await write(root, target, contents);
    artifactSha256[target] = createHash("sha256").update(contents).digest("hex");
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "recorded source bytes");
  const sourceCommit = git(root, "rev-parse", "HEAD");
  const target = Object.keys(artifactSha256)[0];
  await write(root, target, "later source bytes\n");
  git(root, "commit", "--quiet", "-am", "later source change");
  const record = { sourceCommit, artifactSha256 };
  await write(root, file, JSON.stringify(record));
  return { root, record, target };
}

function assertNoLogs(value: unknown) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(logKeys.has(key), key).toBe(false);
    assertNoLogs(child);
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^ai-provider-evidence-anchor-/);
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(records)("anchored AI provider record %s", (file, pinCount) => {
  it("declares an honest anchor with source pins and no cross-pins or re-pin logs", () => {
    // Shipped blob integrity belongs to evidence:verify in full-history CI.
    const record = shipped(file);
    expect(record.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.note).toContain("not the original proof commit");
    expect(record.note).toContain("Historical checks were not rerun");
    expect(Object.keys(record.artifactSha256)).toHaveLength(pinCount);
    for (const [target, digest] of Object.entries(record.artifactSha256)) {
      expect(target.startsWith("docs/evidence/"), target).toBe(false);
      expect(target, target).not.toBe(retiredTool);
      expect(digest, target).toMatch(/^[0-9a-f]{64}$/);
    }
    assertNoLogs(record);
  });

  it("checks every retained path against its fixture commit after source change and removal", async () => {
    const { root, target } = await repository(file);
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([]);
    await unlink(path.join(root, target));
    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });
    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(pinCount);
  });

  it("rejects a tampered hash", async () => {
    const { root, record, target } = await repository(file);
    record.artifactSha256[target] = "0".repeat(64);
    await write(root, file, JSON.stringify(record));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([
      expect.objectContaining({ kind: "STALE_HASH", source: file, detail: expect.stringContaining(`${target}@${record.sourceCommit}`) }),
    ]);
  });

  it("fails closed for a missing anchor without using current source", async () => {
    const { root, record } = await repository(file);
    record.sourceCommit = "0".repeat(40);
    await write(root, file, JSON.stringify(record));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([
      expect.objectContaining({ kind: "SOURCE_COMMIT_UNAVAILABLE", source: file }),
    ]);
  });
});

it("retires the evidence rebinding tool and its commands and review bindings", () => {
  expect(existsSync(path.join(repositoryRoot, retiredTool))).toBe(false);
  for (const file of [
    ...records.map(([file]) => file),
    "docs/reviewed-migration-inventory-pins.md",
    "docs/evidence/ai-provider-settings-migrator-schema-review-2026-10-01.md",
    "docs/evidence/ai-provider-settings-ci-followup-review-2026-10-01.md",
  ]) {
    expect(readFileSync(path.join(repositoryRoot, file), "utf8"), file).not.toContain(path.basename(retiredTool));
  }
});
