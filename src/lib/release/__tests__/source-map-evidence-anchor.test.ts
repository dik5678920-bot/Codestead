import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

// Previously ignored sourceSha256 maps must remain anchored and fully verified.
type Json = Record<string, unknown>;
const repositoryRoot = process.cwd();
const records = [
  ["docs/evidence/auth-recovery-verification-2026-07-12.json", 16],
  ["docs/evidence/chat-lifecycle-verification-2026-07-12.json", 6],
  ["docs/evidence/provider-operation-idempotency-verification-2026-07-12.json", 12],
  ["docs/evidence/tutor-structured-memory-verification-2026-07-12.json", 13],
] as const;
const logKeys = new Set(["supersededDigests", "artifactBindingRefresh", "previousSha256", "priorDigest"]);
const fixtures: string[] = [];

function shipped(file: string): Json {
  return JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8")) as Json;
}

type Pin = { holder: Json; key: string; target: string };

/** Both pin shapes used by these records: `{ "<path>": "<sha>" }` and `{ x: "<path>", xSha256: "<sha>" }`. */
function pins(value: unknown, found: Pin[] = []): Pin[] {
  if (!value || typeof value !== "object") return found;
  const holder = value as Json;
  for (const [key, child] of Object.entries(holder)) {
    if (typeof child === "string" && /^[0-9a-f]{64}$/.test(child)) {
      const sibling = key.endsWith("Sha256") ? holder[key.slice(0, -"Sha256".length)] : undefined;
      if (key === "sha256" && typeof holder.path === "string") found.push({ holder, key, target: holder.path });
      else if (key.includes("/") || key === "compose.yaml") found.push({ holder, key, target: key });
      else if (typeof sibling === "string") found.push({ holder, key, target: sibling });
    } else {
      pins(child, found);
    }
  }
  return found;
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

function fixtureBytes(target: string) {
  return target.startsWith("docs/evidence/") ? "{}\n" : `fixture source bytes for ${target}\n`;
}

async function repository(file: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-map-evidence-anchor-"));
  fixtures.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  const record = structuredClone(shipped(file));
  const recordPins = pins(record);
  for (const target of new Set(recordPins.map((pin) => pin.target))) {
    await write(root, target, fixtureBytes(target));
  }
  for (const pin of recordPins) {
    pin.holder[pin.key] = createHash("sha256").update(fixtureBytes(pin.target)).digest("hex");
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "recorded source bytes");
  record.sourceCommit = git(root, "rev-parse", "HEAD");
  const target = recordPins[0]!.target;
  await write(root, target, "later source bytes\n");
  git(root, "commit", "--quiet", "-am", "later source change");
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
    expect(path.basename(root)).toMatch(/^source-map-evidence-anchor-/);
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(records)("%s", (file, uniquePins) => {
  it("is anchored with a note, keeps its source pins, and carries no re-pin logs", () => {
    // Shipped blob integrity belongs to evidence:verify in full-history CI.
    const record = shipped(file);
    expect(record.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.sourceCommit).toBe("a5e5b1838b0f0ff48e54af4ed1789af70d2d07d5");
    expect(record.note).toContain("not the original proof commit");
    expect(record.note).toContain("historical checks were not rerun");
    const recordPins = pins(record);
    expect(new Set(recordPins.map((pin) => pin.target)).size).toBe(uniquePins);
    expect(Object.keys(record.sourceSha256 as Json)).toHaveLength(uniquePins);
    assertNoLogs(record);
  });

  it("checks every pin against its anchor commit after a later source change and removal", async () => {
    const { root, target } = await repository(file);
    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });
    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(pins(shipped(file)).length);
    await unlink(path.join(root, target));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([]);
  });

  it("rejects a tampered hash", async () => {
    const { root, record, target } = await repository(file);
    const pin = pins(record).find((candidate) => candidate.target === target)!;
    pin.holder[pin.key] = "0".repeat(64);
    await write(root, file, JSON.stringify(record));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([
      expect.objectContaining({ kind: "STALE_HASH", source: file, detail: expect.stringContaining(`${target}@${String(record.sourceCommit)}`) }),
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
