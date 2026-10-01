import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { REVIEWED_MIGRATION_LEDGER, REVIEWED_MIGRATION_LEDGER_SHA256 } from "./lib/reviewed-migration-ledger.mjs";

// Refresh this PR's current-source bindings only. Preserve historical run data
// and record each replaced value; no generic historical evidence rewrite.
const apply = process.argv.includes("--apply");
if (!apply && !process.argv.includes("--check")) throw new Error("Use --apply or --check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const records = [
  "docs/evidence/backup-status-outbox-2026-07-12.json",
  "docs/evidence/ai-provider-settings-2026-10-01.json",
  "docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json",
];
const changedPaths = new Set(execFileSync("git", ["diff", "--name-only"], { cwd: root, encoding: "utf8" }).trim().split("\n"));
const requiresRefresh = (target) => changedPaths.has(target) || records.includes(target);
const pointerPart = (key) => key.replaceAll("~", "~0").replaceAll("/", "~1");
async function digest(target) {
  if (!/^(?:src\/|scripts\/|integration\/|infra\/tests\/|drizzle\/|docs\/)/.test(target) || target.split("/").some((part) => part.startsWith("."))) {
    throw new Error("Evidence binding target is outside the public source inventory");
  }
  return createHash("sha256").update((await readFile(path.join(root, target), "utf8")).replaceAll("\r\n", "\n")).digest("hex");
}
let changed = false;
const inventory = [];
for (const file of records) {
  const value = JSON.parse(await readFile(path.join(root, file), "utf8"));
  const changes = [];
  const update = (record, key, next, pointer, artifact) => {
    if (record[key] === next) return;
    changes.push({ field: `${pointer}/${pointerPart(key)}`, artifact, previousDigest: record[key], currentDigest: next });
    record[key] = next;
  };
  async function walk(record, pointer = "") {
    if (!record || typeof record !== "object") return;
    if (typeof record.path === "string" && requiresRefresh(record.path) && /^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
      update(record, "sha256", await digest(record.path), pointer, record.path);
    }
    for (const key of ["artifactSha256", "sha256"]) {
      const bindings = record[key];
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) continue;
      for (const [target, expected] of Object.entries(bindings)) {
        if (typeof expected === "string" && requiresRefresh(target)) update(bindings, target, await digest(target), `${pointer}/${key}`, target);
      }
    }
    for (const [key, child] of Object.entries(record)) await walk(child, `${pointer}/${pointerPart(key)}`);
  }
  await walk(value);
  if (value.migration && file.includes("ai-provider-settings-2026")) {
    update(value.migration, "sqlSha256", REVIEWED_MIGRATION_LEDGER.at(-1).sqlSha256, "/migration", "drizzle/0070_credential_validation_preference.sql");
    update(value.migration, "newLedgerSha256", REVIEWED_MIGRATION_LEDGER_SHA256, "/migration", "reviewed-migration-ledger-identity");
  }
  if (changes.length === 0) continue;
  changed = true;
  inventory.push({ evidence: file, changes });
  if (apply) {
    value.schemaQualificationRefresh = {
      scope: "Current-source bindings and current 0070 migration identity only. Historical results are preserved; restricted-migrator verification is recorded separately.",
      changes,
    };
    await writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  } else console.error(`Stale AI provider evidence bindings: ${file}`);
}
if (apply) {
  await writeFile(path.join(root, ".agent2-schema-binding-changes.json"), `${JSON.stringify(inventory, null, 2)}\n`);
} else if (changed) process.exitCode = 1;
