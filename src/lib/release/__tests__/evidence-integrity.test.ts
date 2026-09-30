import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DSA_PARITY_LANGUAGES } from "@/lib/content/dsa-parity";
import { verifyEvidenceIntegrity } from "../../../../scripts/lib/evidence-integrity";

const fixtures: string[] = [];
const dsaDeclarationPath = "docs/evidence/dsa-parity-declaration-2026-07-12.json";
const runtimePinsPath = "scripts/curriculum-runtime-pins.json";
const dsaDigests = Object.fromEntries(DSA_PARITY_LANGUAGES.map((language, index) =>
  [language, `sha256:${String(index + 1).repeat(64)}`],
));

async function dsaFixture(overrides: Record<string, unknown> = {}) {
  const root = await fixture();
  await write(root, runtimePinsPath, JSON.stringify({
    schemaVersion: 1,
    records: Object.entries({ ...dsaDigests, javascript: `sha256:${"5".repeat(64)}` })
      .map(([language, digest]) => ({ language, digest })),
  }));
  await write(root, dsaDeclarationPath, JSON.stringify({
    courseId: "dsa", languages: DSA_PARITY_LANGUAGES, runtimeDigests: dsaDigests, ...overrides,
  }));
  return root;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-integrity-"));
  fixtures.push(root);
  await mkdir(path.join(root, "docs", "evidence"), { recursive: true });
  return root;
}

async function write(root: string, target: string, contents: string) {
  const absolute = path.join(root, target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence integrity verifier", () => {
  it("walks nested evidence and accepts existing links, paths, and current hashes", async () => {
    const root = await fixture();
    const source = "export const ready = true;\n";
    await write(root, "README.md", "[Guide](docs/guide.md#usage)\n");
    await write(root, "docs/guide.md", "# Usage\n");
    await write(root, "integration/example.integration.test.ts", source);
    await write(root, "docs/evidence/current.json", JSON.stringify({
      nested: [{ artifacts: [{ path: "integration/example.integration.test.ts", sha256: sha256(source) }] }],
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: ["README.md", "docs"] });

    expect(report.issues).toEqual([]);
    expect(report.markdown.links).toBe(1);
    expect(report.evidence).toMatchObject({ files: 1, paths: 1, hashes: 1 });
  });

  it("rejects traversal and reports missing repository paths", async () => {
    const root = await fixture();
    await write(root, "docs/evidence/paths.json", JSON.stringify({
      artifacts: [
        { path: "docs/../../outside.json" },
        { path: "scripts/missing.ts" },
      ],
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "INVALID_EVIDENCE_PATH", detail: "docs/../../outside.json" }),
      expect.objectContaining({ kind: "MISSING_EVIDENCE_PATH", detail: "scripts/missing.ts" }),
    ]);
  });

  it("reports stale hashes, missing links, and malformed encoded links", async () => {
    const root = await fixture();
    await write(root, "README.md", "[Missing](docs/missing.md) [Malformed](docs/%ZZ.md)\n");
    await write(root, "scripts/check.ts", "changed\n");
    await write(root, "docs/evidence/stale.json", JSON.stringify({
      artifactSha256: { "scripts/check.ts": "0".repeat(64) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: ["README.md"] });

    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "BROKEN_LINK",
      "BROKEN_LINK",
      "STALE_HASH",
    ]);
    expect(report.issues.find((issue) => issue.kind === "STALE_HASH")?.detail)
      .toContain(`actual=${sha256("changed\n")}`);
  });

  it("accepts a uniform CRLF checkout for Git-normalized text evidence", async () => {
    const root = await fixture();
    const canonical = "export const checked = true;\nexport const count = 2;\n";
    await write(root, "scripts/check.ts", canonical.replaceAll("\n", "\r\n"));
    await write(root, "docs/evidence/text.json", JSON.stringify({
      artifactSha256: { "scripts/check.ts": sha256(canonical) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([]);
    expect(report.evidence.hashes).toBe(1);
  });

  it.each([
    ["infra/check.sh", "forced-LF deployment script"],
    ["docs/check.png", "binary asset"],
  ])("keeps %s byte-exact as a %s", async (target) => {
    const root = await fixture();
    const canonical = "first\nsecond\n";
    await write(root, target, canonical.replaceAll("\n", "\r\n"));
    await write(root, "docs/evidence/exact.json", JSON.stringify({
      artifactSha256: { [target]: sha256(canonical) },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_HASH",
        detail: expect.stringContaining(`actual=${sha256(canonical.replaceAll("\n", "\r\n"))}`),
      }),
    ]);
  });

  it("checks recursive named path and Sha256 pairs without treating metadata as artifacts", async () => {
    const root = await fixture();
    const source = "export const checked = true;\n";
    await write(root, "scripts/check.ts", source);
    await write(root, "docs/evidence/named.json", JSON.stringify({
      implementation: {
        runnerClient: "scripts/check.ts",
        runnerClientSha256: "0".repeat(64),
        nested: {
          migration: "scripts/check.ts",
          migrationSha256: sha256(source),
        },
        generatedAt: "2026-07-14T00:00:00.000Z",
        generatedAtSha256: "f".repeat(64),
        externalReport: "https://example.test/report.json",
        externalReportSha256: "e".repeat(64),
      },
    }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_HASH",
        source: "docs/evidence/named.json",
        detail: expect.stringContaining("scripts/check.ts expected="),
      }),
    ]);
    expect(report.evidence.hashes).toBe(2);
  });

  it("reports malformed evidence JSON without aborting the remaining files", async () => {
    const root = await fixture();
    await write(root, "docs/evidence/bad.json", "{not-json");
    await write(root, "docs/evidence/good.json", JSON.stringify({ report: "docs/evidence/good.json" }));

    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });

    expect(report.evidence.files).toBe(2);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "INVALID_JSON", source: "docs/evidence/bad.json" }),
    ]);
  });

  it("accepts a DSA declaration bound to all four current runtime pins", async () => {
    const root = await dsaFixture();
    const before = await readFile(path.join(root, dsaDeclarationPath), "utf8");
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([]);
    expect(await readFile(path.join(root, dsaDeclarationPath), "utf8")).toBe(before);
  });

  it.each(DSA_PARITY_LANGUAGES)("rejects a stale %s runtime digest without rewriting the declaration", async (language) => {
    const stale = `sha256:${"f".repeat(64)}`;
    const root = await dsaFixture({ runtimeDigests: { ...dsaDigests, [language]: stale } });
    const before = await readFile(path.join(root, dsaDeclarationPath), "utf8");
    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });
    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: "STALE_RUNTIME_DIGEST", source: dsaDeclarationPath,
        detail: expect.stringContaining(`${language} declared=${stale} pinned=${dsaDigests[language]}`),
      }),
    ]);
    expect(await readFile(path.join(root, dsaDeclarationPath), "utf8")).toBe(before);
  });

  it.each([
    ["missing map", { runtimeDigests: undefined }],
    ["array map", { runtimeDigests: Object.values(dsaDigests) }],
    ["missing language", { runtimeDigests: { ...dsaDigests, java: undefined } }],
    ["invalid digest", { runtimeDigests: { ...dsaDigests, c: "latest" } }],
    ["extra language", { runtimeDigests: { ...dsaDigests, ruby: dsaDigests.c } }],
    ["missing language list", { languages: undefined }],
    ["incomplete language list", { languages: ["c", "cpp", "java"] }],
    ["duplicate language", { languages: ["c", "cpp", "java", "java"] }],
  ])("rejects a DSA declaration with %s", async (_label, overrides) => {
    const root = await dsaFixture(overrides);
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([
      expect.objectContaining({ kind: "INVALID_RUNTIME_DECLARATION", source: dsaDeclarationPath }),
    ]);
  });

  it.each([
    ["missing pin", Object.entries(dsaDigests).filter(([language]) => language !== "python").map(([language, digest]) => ({ language, digest }))],
    ["duplicate pin", [...Object.entries(dsaDigests).map(([language, digest]) => ({ language, digest })), { language: "c", digest: dsaDigests.c }]],
    ["invalid pin", Object.entries(dsaDigests).map(([language, digest]) => ({ language, digest: language === "java" ? "latest" : digest }))],
  ])("fails closed with a %s in the canonical pins", async (_label, records) => {
    const root = await dsaFixture();
    await write(root, runtimePinsPath, JSON.stringify({ schemaVersion: 1, records }));
    expect((await verifyEvidenceIntegrity({ root, markdownRoots: [] })).issues).toEqual([
      expect.objectContaining({ kind: "INVALID_RUNTIME_DECLARATION", source: dsaDeclarationPath }),
    ]);
  });

  it("reports a missing canonical pins file while still checking other evidence", async () => {
    const root = await dsaFixture();
    await rm(path.join(root, runtimePinsPath));
    await write(root, "docs/evidence/bad.json", "{not-json");
    const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });
    expect(report.issues).toHaveLength(2);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "INVALID_RUNTIME_DECLARATION", source: dsaDeclarationPath }),
      expect.objectContaining({ kind: "INVALID_JSON", source: "docs/evidence/bad.json" }),
    ]));
  });
});
