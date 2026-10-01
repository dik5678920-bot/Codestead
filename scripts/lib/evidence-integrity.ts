import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { DSA_PARITY_LANGUAGES } from "../../src/lib/content/dsa-parity";

export type EvidenceIntegrityIssueKind =
  | "BROKEN_LINK"
  | "INVALID_EVIDENCE_PATH"
  | "INVALID_JSON"
  | "MISSING_EVIDENCE_PATH"
  | "STALE_HASH"
  | "INVALID_SOURCE_DECLARATION"
  | "INVALID_RUNTIME_DECLARATION"
  | "STALE_RUNTIME_DIGEST";

export type EvidenceIntegrityIssue = Readonly<{
  kind: EvidenceIntegrityIssueKind;
  source: string;
  detail: string;
}>;

export type EvidenceIntegrityReport = Readonly<{
  issues: readonly EvidenceIntegrityIssue[];
  markdown: Readonly<{ files: number; links: number }>;
  evidence: Readonly<{ files: number; paths: number; hashes: number }>;
}>;

export type EvidenceIntegrityOptions = Readonly<{
  root: string;
  evidenceRoot?: string;
  markdownRoots?: readonly string[];
}>;

const defaultMarkdownRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  path.join("services", "runner", "README.md"),
  path.join("infra", "secrets", "README.md"),
] as const;

const repositoryPathPrefixes = [
  ".github/",
  "content/",
  "docs/",
  "drizzle/",
  "e2e/",
  "infra/",
  "integration/",
  "scripts/",
  "services/",
  "src/",
] as const;

const repositoryRootFiles = new Set([
  "compose.yaml",
  "Dockerfile",
  "package-lock.json",
  "package.json",
  "playwright.config.ts",
]);

const sha256Pattern = /^[0-9a-f]{64}$/i;
const runtimeDigestPattern = /^sha256:[0-9a-f]{64}$/;
const dsaDeclarationPath = "docs/evidence/dsa-parity-declaration-2026-07-12.json";
const authRecoveryPath = "docs/evidence/auth-recovery-verification-2026-07-12.json";
const outboxWorkerPath = "scripts/process-outbox.ts";
const runtimePinsPath = "scripts/curriculum-runtime-pins.json";

const byteExactExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sh",
  ".sql",
  ".webp",
  ".woff",
  ".woff2",
  ".yaml",
  ".yml",
]);

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function isByteExactPath(target: string) {
  return path.basename(target) === "Dockerfile"
    || byteExactExtensions.has(path.extname(target).toLowerCase());
}

function canonicalCrLfDigest(target: string, bytes: Buffer): string | null {
  if (isByteExactPath(target)) return null;
  let sawCrLf = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if (value === 0) return null;
    if (value === 13) {
      if (bytes[index + 1] !== 10) return null;
      sawCrLf = true;
      index += 1;
    } else if (value === 10) {
      return null;
    }
  }
  if (!sawCrLf) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return sha256(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"));
}

async function filesUnder(root: string, target: string, extension?: string): Promise<string[]> {
  const absolute = path.resolve(root, target);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return !extension || absolute.endsWith(extension) ? [absolute] : [];
  const result: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      result.push(...await filesUnder(root, path.relative(root, child), extension));
    } else if (!extension || child.endsWith(extension)) {
      result.push(child);
    }
  }
  return result;
}

function relative(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function isInside(root: string, target: string) {
  const inside = path.relative(root, target);
  return inside === "" || (
    inside !== ".." &&
    !inside.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(inside)
  );
}

function hasTraversal(value: string) {
  return value.replaceAll("\\", "/").split("/").includes("..");
}

function repositoryPath(root: string, value: string): string | null {
  const slashNormalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(slashNormalized) ||
    path.win32.isAbsolute(value) ||
    hasTraversal(value) ||
    slashNormalized.includes("://")
  ) return null;
  const normalized = path.posix.normalize(slashNormalized.replace(/^\.\//, ""));
  if (
    (!repositoryRootFiles.has(normalized) &&
      !repositoryPathPrefixes.some((prefix) => normalized.startsWith(prefix))) ||
    !isInside(root, path.resolve(root, normalized))
  ) return null;
  return normalized;
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function digests(target: string) {
  const bytes = await readFile(target);
  const raw = sha256(bytes);
  const canonical = canonicalCrLfDigest(target, bytes);
  return {
    accepted: canonical ? new Set([raw, canonical]) : new Set([raw]),
    reported: canonical ?? raw,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function verifyDsaRuntimeDigests(
  root: string,
  declaration: unknown,
  issues: EvidenceIntegrityIssue[],
) {
  const invalid = (detail: string) => issues.push({
    kind: "INVALID_RUNTIME_DECLARATION", source: dsaDeclarationPath, detail,
  });
  const value = object(declaration);
  const declared = object(value?.runtimeDigests);
  const expectedLanguages = [...DSA_PARITY_LANGUAGES].sort();
  if (!value || value.courseId !== "dsa" || !declared
    || !Array.isArray(value.languages)
    || JSON.stringify([...value.languages].sort()) !== JSON.stringify(expectedLanguages)
    || JSON.stringify(Object.keys(declared).sort()) !== JSON.stringify(expectedLanguages)
    || DSA_PARITY_LANGUAGES.some((language) =>
      typeof declared[language] !== "string" || !runtimeDigestPattern.test(declared[language]))
  ) {
    invalid("DSA declaration must contain exactly C, C++, Java, and Python languages and valid sha256 runtime digests.");
    return;
  }

  let pins: Record<string, unknown> | null;
  try {
    pins = object(JSON.parse(await readFile(path.join(root, runtimePinsPath), "utf8")));
  } catch {
    invalid(`${runtimePinsPath} could not be read as JSON.`);
    return;
  }
  if (!pins || pins.schemaVersion !== 1 || !Array.isArray(pins.records)) {
    invalid(`${runtimePinsPath} must contain a version-1 records array.`);
    return;
  }
  const expected = new Map<string, string>();
  for (const language of DSA_PARITY_LANGUAGES) {
    const records = pins.records.map(object).filter((record) => record?.language === language);
    const digest = records[0]?.digest;
    if (records.length !== 1 || typeof digest !== "string" || !runtimeDigestPattern.test(digest)) {
      invalid(`${runtimePinsPath} must contain exactly one valid sha256 pin for ${language}.`);
      return;
    }
    expected.set(language, digest);
  }
  for (const language of DSA_PARITY_LANGUAGES) {
    const pinned = expected.get(language)!;
    if (declared[language] !== pinned) issues.push({
      kind: "STALE_RUNTIME_DIGEST", source: dsaDeclarationPath,
      detail: `${language} declared=${declared[language]} pinned=${pinned} (${runtimePinsPath}); regenerate with npm run dsa:parity:generate`,
    });
  }
}

async function verifyMarkdown(
  root: string,
  markdownRoots: readonly string[],
  issues: EvidenceIntegrityIssue[],
) {
  const files = (await Promise.all(markdownRoots.map(async (target) => {
    try {
      return await filesUnder(root, target, ".md");
    } catch {
      return [];
    }
  }))).flat();
  let checked = 0;
  const localLink = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const file of files) {
    const document = await readFile(file, "utf8");
    for (const match of document.matchAll(localLink)) {
      const raw = match[1]!.split("#")[0]!.trim().replace(/^<|>$/g, "");
      if (!raw) continue;
      checked += 1;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        issues.push({ kind: "BROKEN_LINK", source: relative(root, file), detail: `Invalid encoded path: ${raw}` });
        continue;
      }
      const target = path.resolve(path.dirname(file), decoded);
      if (!isInside(root, target) || !await exists(target)) {
        issues.push({ kind: "BROKEN_LINK", source: relative(root, file), detail: raw });
      }
    }
  }
  return { files: files.length, links: checked };
}

async function verifyEvidence(
  root: string,
  evidenceRoot: string,
  issues: EvidenceIntegrityIssue[],
) {
  const files = await filesUnder(root, evidenceRoot, ".json");
  const checkedPaths = new Set<string>();
  const checkedHashes = new Set<string>();
  const invalidPaths = new Set<string>();

  function rejectTraversal(source: string, value: string) {
    if (!hasTraversal(value)) return false;
    const key = `${source}\0${value}`;
    if (!invalidPaths.has(key)) {
      invalidPaths.add(key);
      issues.push({ kind: "INVALID_EVIDENCE_PATH", source, detail: value });
    }
    return true;
  }

  async function checkPath(source: string, value: string) {
    if (rejectTraversal(source, value)) return;
    const candidate = repositoryPath(root, value);
    if (!candidate) return;
    const key = `${source}\0${candidate}`;
    if (checkedPaths.has(key)) return;
    checkedPaths.add(key);
    if (!await exists(path.join(root, candidate))) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
    }
  }

  async function checkHash(source: string, value: string, expected: string) {
    if (rejectTraversal(source, value)) return;
    const candidate = repositoryPath(root, value);
    if (!candidate || !sha256Pattern.test(expected)) return;
    const key = `${source}\0${candidate}\0${expected.toLowerCase()}`;
    if (checkedHashes.has(key)) return;
    checkedHashes.add(key);
    const target = path.join(root, candidate);
    if (!await exists(target)) {
      issues.push({ kind: "MISSING_EVIDENCE_PATH", source, detail: candidate });
      return;
    }
    const actual = await digests(target);
    if (!actual.accepted.has(expected.toLowerCase())) {
      issues.push({
        kind: "STALE_HASH",
        source,
        detail: `${candidate} expected=${expected.toLowerCase()} actual=${actual.reported}`,
      });
    }
  }

  async function walk(source: string, value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      for (const item of value) await walk(source, item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") {
      await checkPath(source, record.path);
      if (typeof record.sha256 === "string") await checkHash(source, record.path, record.sha256);
    }
    for (const [key, expected] of Object.entries(record)) {
      if (!key.endsWith("Sha256") || typeof expected !== "string") continue;
      const candidate = record[key.slice(0, -"Sha256".length)];
      if (typeof candidate === "string") await checkHash(source, candidate, expected);
    }
    for (const key of ["report", "inventory"] as const) {
      if (typeof record[key] === "string") await checkPath(source, record[key]);
    }
    for (const key of ["artifactSha256", "sha256"] as const) {
      const hashes = record[key];
      if (hashes && typeof hashes === "object" && !Array.isArray(hashes)) {
        for (const [candidate, expected] of Object.entries(hashes as Record<string, unknown>)) {
          if (typeof expected === "string") await checkHash(source, candidate, expected);
        }
      }
    }
    for (const child of Object.values(record)) await walk(source, child);
  }

  for (const file of files) {
    const source = relative(root, file);
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (source === dsaDeclarationPath) await verifyDsaRuntimeDigests(root, value, issues);
      if (source === authRecoveryPath) {
        const pinned = object(object(value)?.sourceSha256)?.[outboxWorkerPath];
        if (typeof pinned !== "string" || !sha256Pattern.test(pinned)) {
          issues.push({
            kind: "INVALID_SOURCE_DECLARATION", source,
            detail: `Auth recovery evidence must pin ${outboxWorkerPath} in sourceSha256 with a valid sha256 hash.`,
          });
        } else {
          await checkHash(source, outboxWorkerPath, pinned);
        }
      }
      await walk(source, value);
    } catch (error) {
      issues.push({
        kind: "INVALID_JSON",
        source,
        detail: error instanceof Error ? error.message : "JSON could not be parsed",
      });
    }
  }
  return { files: files.length, paths: checkedPaths.size, hashes: checkedHashes.size };
}

export async function verifyEvidenceIntegrity(
  options: EvidenceIntegrityOptions,
): Promise<EvidenceIntegrityReport> {
  const root = path.resolve(options.root);
  const issues: EvidenceIntegrityIssue[] = [];
  const [markdown, evidence] = await Promise.all([
    verifyMarkdown(root, options.markdownRoots ?? defaultMarkdownRoots, issues),
    verifyEvidence(root, options.evidenceRoot ?? path.join("docs", "evidence"), issues),
  ]);
  issues.sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.source.localeCompare(right.source) ||
    left.detail.localeCompare(right.detail));
  return { issues, markdown, evidence };
}
