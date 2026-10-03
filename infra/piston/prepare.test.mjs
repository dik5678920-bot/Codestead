import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildInputPaths, prepareDownloads, validateDownload } from "./prepare.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("reject traversal, missing hashes, non-HTTPS and duplicate downloads before fetching", async () => {
  const good = { name: "sources/ok.tar.gz", sha256: "a".repeat(64), url: "https://example.com/file" };
  for (const bad of [{ ...good, name: "sources/.." }, { ...good, name: "sources/../../file" },
    { ...good, sha256: "" }, { ...good, url: "http://example.com/file" }]) assert.throws(() => validateDownload(bad));
  await assert.rejects(prepareDownloads([good, good], "unused", () => { throw new Error("unexpected fetch"); }), /Duplicate/);
});
test("only verified downloads reach the cache; corrupt cache is replaced", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "piston-download-test-"));
  try {
    const record = { name: "sources/test.tar.gz", sha256: sha256("verified"), url: "https://example.com/file" };
    await assert.rejects(prepareDownloads([record], target, async () => new Response("wrong")), /SHA-256 mismatch/);
    await assert.rejects(readFile(path.join(target, record.name)), { code: "ENOENT" });
    await mkdir(path.join(target, "sources"));
    await writeFile(path.join(target, record.name), "corrupt");
    await prepareDownloads([record], target, async () => new Response("verified"));
    assert.equal(await readFile(path.join(target, record.name), "utf8"), "verified");
    await prepareDownloads([record], target, () => { throw new Error("verified cache must not fetch"); });
  } finally {
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("piston-download-test-"));
    await rm(target, { recursive: true, force: true });
  }
});
test("offline npm lock and Debian snapshot archives are all SHA-256 locked", async () => {
  const lock = JSON.parse(await readFile(new URL("./image-inputs.lock.json", import.meta.url)));
  const npm = JSON.parse(await readFile(new URL("./api-package-lock.json", import.meta.url)));
  const sums = await readFile(new URL("./downloads.sha256", import.meta.url), "utf8");
  for (const record of lock.downloads) {
    validateDownload(record);
    assert.ok(sums.includes(`${record.sha256}  ${record.name}\n`));
    if (record.name.startsWith("debs/")) assert.ok(record.url.includes(`/archive/`) && record.url.includes(`/${lock.debianSnapshot}/`));
  }
  for (const [key, pkg] of Object.entries(npm.packages)) {
    if (!key) continue;
    assert.ok(pkg.resolved?.startsWith("file:/downloads/npm/"), key);
    assert.ok(lock.downloads.some((record) => `file:/downloads/${record.name}` === pkg.resolved), key);
    assert.ok(pkg.integrity?.startsWith("sha512-"), key);
  }
});

test("PR4b handoff matches the committed build and validation inputs", async () => {
  const handoff = JSON.parse(await readFile(new URL("./pr4b-runtime-handoff.json", import.meta.url)));
  const lock = JSON.parse(await readFile(new URL("./image-inputs.lock.json", import.meta.url)));
  assert.deepEqual(handoff.runtimeLabels, lock.runtimes);
  assert.match(handoff.imageReference, /@sha256:[a-f0-9]{64}$/);
  assert.match(handoff.imageConfigDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(handoff.imageReference.split("@")[1], handoff.imageConfigDigest);
  assert.deepEqual(Object.keys(handoff.buildInputSha256), buildInputPaths);
  assert.deepEqual(Object.keys(handoff.testInputSha256), ["src/lib/runner/client.ts", "src/lib/runner/piston-client.ts",
    "src/lib/runner/__tests__/piston-client.integration.test.ts", "infra/piston/test-image.mjs"]);
  for (const [file, hash] of Object.entries(handoff.buildInputSha256)) {
    assert.equal(sha256(await readFile(new URL(`./${file}`, import.meta.url))), hash, file);
  }
  for (const [file, hash] of Object.entries(handoff.testInputSha256)) {
    assert.equal(sha256(await readFile(file)), hash, file);
  }
  assert.equal(handoff.validation.passed, true);
  assert.equal(handoff.validation.liveTests, 20);
});
