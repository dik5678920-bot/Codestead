import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "image-inputs.lock.json"), "utf8"));
export const buildInputPaths = ["Dockerfile", "entrypoint.sh", "build-cds.sh", "install-packages.mjs",
  "api-package.json", "api-package-lock.json", "image-inputs.lock.json", "downloads.sha256", ".dockerignore"];
export function validateDownload(record) {
  if (!/^(debs|npm|sources|toolchains)\/[a-zA-Z0-9_%+.~:-]+$/.test(record.name)
    || [".", ".."].includes(path.posix.basename(record.name))
    || !/^[a-f0-9]{64}$/.test(record.sha256) || !record.url.startsWith("https://")) {
    throw new Error("Invalid locked download");
  }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepareDownloads(records, target, fetchImpl = fetch) {
  const names = new Set();
  for (const record of records) {
    validateDownload(record);
    if (names.has(record.name)) throw new Error("Duplicate locked download");
    names.add(record.name);
  }
  for (const record of records) {
    const file = path.join(target, record.name);
    try {
      if (hash(await readFile(file)) === record.sha256) continue;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const response = await fetchImpl(record.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${record.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== record.sha256) throw new Error(`SHA-256 mismatch: ${record.name}`);
    await mkdir(path.dirname(file), { recursive: true });
    const staging = `${file}.partial`;
    try { await writeFile(staging, bytes); await rename(staging, file); }
    finally { await rm(staging, { force: true }); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDownloads(lock.downloads, path.join(root, ".downloads"));
  const lines = await Promise.all(buildInputPaths.map(async (file) => `${hash(await readFile(path.join(root, file)))}  ${file}\n`));
  await writeFile(path.join(root, "build-inputs.sha256"), lines.join(""));
}
