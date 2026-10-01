import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { REVIEWED_MIGRATION_LEDGER, REVIEWED_MIGRATION_LEDGER_SHA256, verifyReviewedMigrationRepository } from "./lib/reviewed-migration-ledger.mjs";

// An enum/index-only migration can carry forward reviewed physical attnums.
// Column or routine changes require independent migration replay and review.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
if (!apply && !process.argv.includes("--check")) throw new Error("Use --apply or --check");
verifyReviewedMigrationRepository({ drizzleDirectory: path.join(root, "drizzle") });
const read = (file) => readFile(path.join(root, file), "utf8");
const tail = REVIEWED_MIGRATION_LEDGER.at(-1);
const next = String(tail.idx).padStart(4, "0");
const moduleSource = await read("scripts/database-runtime-capabilities.mjs");
const previous = moduleSource.match(/import snapshot(\d{4}) from/)[1];
const previousTag = moduleSource.match(/CURRENT_\d{4}_REVIEWED_MIGRATION_TAG =\s*"([^"]+)"/)[1];
const baseline = JSON.parse(await read("drizzle/meta/0069_public_column_attnums.json"));
const oldSnapshot = JSON.parse(await read("drizzle/meta/0069_snapshot.json"));
const snapshot = JSON.parse(await read(`drizzle/meta/${next}_snapshot.json`));
const columnShape = (value) => Object.entries(value.tables).map(([identity, table]) => [identity, Object.keys(table.columns).sort()]).sort();
if (JSON.stringify(columnShape(oldSnapshot)) !== JSON.stringify(columnShape(snapshot))) {
  throw new Error("Physical column changes require a separately reviewed attnum replay; cannot carry forward 0069");
}
for (const entry of REVIEWED_MIGRATION_LEDGER.slice(70)) {
  const sql = await read(`drizzle/${entry.tag}.sql`);
  if (!sql.split(/--> statement-breakpoint/).every((statement) => /^\s*(?:--[^\n]*\n\s*)*(?:ALTER TYPE|LOCK TABLE|WITH ranked AS|CREATE UNIQUE INDEX)/i.test(statement))) {
    throw new Error("Only reviewed enum/index extensions can carry forward this capability inventory");
  }
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (value, key = null) => {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonical(entry, key));
    return key === "values" ? entries : entries.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  }
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort(compare).map((name) => [name, canonical(value[name], name)])) : value;
};
const digest = (value) => createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
const fingerprint = (value) => digest(canonical(value));
const physical = { ...baseline, contract: `codestead-public-column-attnums-${next}-v1`, reviewedMigrationTail: tail.tag, reviewedMigrationLedgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256 };
const enums = Object.entries(snapshot.enums).map(([identity, value]) => ({ identity, values: value.values }));
const enumTypes = Object.entries(snapshot.enums).map(([identity, value]) => ({ identity, schema: "public", name: value.name, kind: "enum", owner: "learncoding_owner", values: value.values }));
const types = [...physical.tables.map(({ identity }) => ({ identity, schema: "public", name: identity.slice(7), kind: "composite", owner: "learncoding_owner" })), ...enumTypes, { identity: "drizzle.__drizzle_migrations", schema: "drizzle", name: "__drizzle_migrations", kind: "composite", owner: "learncoding_owner" }];
const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
const pinValues = { FULL_LEDGER: REVIEWED_MIGRATION_LEDGER_SHA256, JOURNAL_TAGS: digest(journal.entries.map(({ tag }) => tag)), PUBLIC_COLUMN_MANIFEST: digest(physical), ENUM: fingerprint(enums) };
const files = [
  "scripts/database-runtime-capabilities.mjs", "scripts/database-runtime-capabilities.d.mts", "scripts/database-runtime-capabilities.test.mjs",
  "scripts/bootstrap-database-runtime-capabilities.mjs", "scripts/bootstrap-database-runtime-capabilities.test.mjs",
  "scripts/verify-database-runtime-capabilities.mjs", "scripts/verify-database-runtime-capabilities.test.mjs",
  "scripts/lib/database-runtime-capability-test-fixture.mjs", "scripts/__tests__/backup-reporter-role-contract.test.ts",
  "infra/tests/database-least-privilege-static.test.mjs", "infra/tests/reviewed-migration-ledger-registration.test.mjs", "infra/tests/validate-static.mjs", "Dockerfile",
  "scripts/verify-restored-backup.ts", "scripts/verify-restored-backup-authority.test.ts", "scripts/verify-restored-backup.test.ts", "scripts/backup/restore-drill-isolated.sh",
];
const replacements = new Map();
for (const [name, value] of Object.entries(pinValues)) {
  const old = moduleSource.match(new RegExp(`const REVIEWED_${previous}_${name}_SHA256 =\\s*"([a-f0-9]+)"`))[1];
  replacements.set(old, value);
}
replacements.set("b831dd25967bf48e1d15ef5f1e3273c72d714a5a4f2e95aa310a464d042160fd", fingerprint(types));
let changed = false;
async function output(file, value) {
  let current;
  try { current = await read(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current?.replaceAll("\r\n", "\n") === value.replaceAll("\r\n", "\n")) return;
  changed = true;
  if (apply) await writeFile(path.join(root, file), value);
  else console.error(`Stale reviewed inventory: ${file}`);
}
await output(`drizzle/meta/${next}_public_column_attnums.json`, `${JSON.stringify(physical, null, 2)}\n`);
for (const file of files) {
  let source = await read(file);
  source = source.replaceAll(`CURRENT_${previous}`, `CURRENT_${next}`);
  source = source.replace(new RegExp(`REVIEWED_${previous}_(?=(?:FULL_LEDGER|JOURNAL_TAGS|PUBLIC_COLUMN_MANIFEST|TABLE_COLUMN|ENUM)_SHA256)`, "g"), `REVIEWED_${next}_`);
  source = source.replaceAll(`snapshot${previous}`, `snapshot${next}`).replaceAll(`journal${previous}`, `journal${next}`).replaceAll(`physicalPublicColumns${previous}`, `physicalPublicColumns${next}`).replaceAll(`assertReviewed${previous}`, `assertReviewed${next}`);
  source = source.replaceAll(`${previous}_snapshot`, `${next}_snapshot`).replaceAll(`${previous}_public_column_attnums`, `${next}_public_column_attnums`);
  source = source.replaceAll(`${previous}-current`, `${next}-current`).replaceAll(`attnums-${previous}-v1`, `attnums-${next}-v1`);
  for (const [old, value] of replacements) source = source.replaceAll(old, value);
  if (file === "scripts/database-runtime-capabilities.mjs") {
    source = source.replace(/(CURRENT_\d{4}_REVIEWED_MIGRATION_TAG =\s*)"[^"]+"/, `$1"${tail.tag}"`);
    source = source.replace(new RegExp(`(requiredMigrationFile:\\s*)"drizzle/${previousTag}\\.sql"`, "g"), `$1"drizzle/${tail.tag}.sql"`);
    source = source.replace(/REVIEWED_MIGRATION_TAGS.length === \d+/, `REVIEWED_MIGRATION_TAGS.length === ${journal.entries.length}`);
    source = source.replace(/enumLabelCount !== \d+/, `enumLabelCount !== ${enums.reduce((count, item) => count + item.values.length, 0)}`);
    source = source.replace(/the reviewed \d{4} inventory pin/, `the reviewed ${next} inventory pin`);
  }
  if (file === "scripts/database-runtime-capabilities.d.mts" || file === "scripts/database-runtime-capabilities.test.mjs") {
    source = source.replace(/(CURRENT_\d{4}_REVIEWED_MIGRATION_TAG: )"[^"]+"/, `$1"${tail.tag}"`);
    source = source.replace(/(const reviewedTag: )"[^"]+"/, `$1"${tail.tag}"`);
    source = source.replace(/enumLabels: \d+/, `enumLabels: ${enums.reduce((count, item) => count + item.values.length, 0)}`);
    source = source.replace(/request\(70, \{ reviewedMigrationCount: 71 \}\)/, "request(REVIEWED_MIGRATION_LEDGER.length, { reviewedMigrationCount: REVIEWED_MIGRATION_LEDGER.length + 1 })");
    if (file.endsWith(".d.mts")) {
      source = source.replaceAll(`reviewedMigrationTail: "${previousTag}"`, `reviewedMigrationTail: "${tail.tag}"`);
      source = source.replaceAll(`requiredMigrationFile: "drizzle/${previousTag}.sql"`, `requiredMigrationFile: "drizzle/${tail.tag}.sql"`);
    }
    source = source.replace(/types: "[a-f0-9]{64}"/, `types: "${fingerprint(types)}"`);
  }
  if (file === "scripts/verify-restored-backup.ts") {
    source = source.replace(/reviewed.REVIEWED_MIGRATION_LEDGER.length !== \d+/, `reviewed.REVIEWED_MIGRATION_LEDGER.length !== ${journal.entries.length}`);
    source = source.replace(/tail\?\.idx !== \d+/, `tail?.idx !== ${tail.idx}`);
    source = source.replace(/tail.tag !== "[^"]+"/, `tail.tag !== "${tail.tag}"`);
  }
  if (file === "scripts/verify-restored-backup-authority.test.ts") {
    source = source.replace(/appliedCount: \d+/g, `appliedCount: ${journal.entries.length}`);
    source = source.replace(/Array.from\(\{ length: \d+ \}/, `Array.from({ length: ${journal.entries.length} }`);
    source = source.replace(/idx === \d+ \? '[^']+'/, `idx === ${tail.idx} ? '${tail.tag}'`);
  }
  if (file === "scripts/verify-restored-backup.test.ts") {
    source = source.replace(/expect\(REVIEWED_MIGRATION_LEDGER\).toHaveLength\(\d+\)/, `expect(REVIEWED_MIGRATION_LEDGER).toHaveLength(${journal.entries.length})`);
    source = source.replace(/idx: \d+,\s*tag: "\d{4}_[^"]+"/, `idx: ${tail.idx},\n      tag: "${tail.tag}"`);
    source = source.replace(/appliedMigrationCount: \d+/, `appliedMigrationCount: ${journal.entries.length}`);
    source = source.replace(/exact \d{4} ledger/, `exact ${next} ledger`);
  }
  if (["scripts/database-runtime-capabilities.mjs", "scripts/verify-restored-backup.ts", "scripts/backup/restore-drill-isolated.sh"].includes(file)) {
    source = source.replaceAll("reviewed 0069", `reviewed ${next}`).replaceAll("the 0069 current phase", `the ${next} current phase`);
  }
  await output(file, source);
}
const runtime = await import(pathToFileURL(path.join(root, "scripts/database-runtime-capabilities.mjs")));
const policyFingerprint = runtime.fingerprintDatabaseRuntimeCapabilities(runtime[`CURRENT_${next}_DATABASE_RUNTIME_CAPABILITIES`]);
for (const file of ["scripts/bootstrap-database-runtime-capabilities.test.mjs", "scripts/verify-database-runtime-capabilities.test.mjs"]) {
  const source = await read(file);
  await output(file, source.replace(/(const CURRENT_POLICY_FINGERPRINT =\s*)"[a-f0-9]+"/, `$1"${policyFingerprint}"`));
}
if (!apply && changed) process.exitCode = 1;
