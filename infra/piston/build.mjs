// Reproducible offline build of the Codestead Piston image. Every builder (CI,
// a disposable VM, the NUC) runs this one command, so the same commit yields the
// same manifest digest. Run prepare.mjs first.
//   node infra/piston/build.mjs <tag>
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export function sourceDateEpoch(lock) {
  const match = /^(\d{4})(\d{2})(\d{2})T000000Z$/.exec(lock.debianSnapshot ?? "");
  const expected = match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) / 1000 : NaN;
  if (!Number.isInteger(lock.sourceDateEpoch) || lock.sourceDateEpoch !== expected) {
    throw new Error("sourceDateEpoch must equal the locked Debian snapshot time");
  }
  return lock.sourceDateEpoch;
}

// rewrite-timestamp clamps every layer file mtime to SOURCE_DATE_EPOCH. It
// cannot be combined with unpacking straight into the image store, so the image
// is exported as a tarball and then loaded (loading keeps the manifest digest).
export function buildArgs({ epoch, tag, archive, metadataFile, context }) {
  return ["buildx", "build", "--network=none", "--platform", "linux/amd64", "--provenance=false",
    "--build-arg", `SOURCE_DATE_EPOCH=${epoch}`,
    "--output", `type=docker,name=${tag},dest=${archive},rewrite-timestamp=true`,
    "--metadata-file", metadataFile, context];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag || process.argv.length !== 3) throw new Error("Usage: node infra/piston/build.mjs <tag>");
  const lock = JSON.parse(await readFile(path.join(root, "image-inputs.lock.json"), "utf8"));
  const work = await mkdtemp(path.join(os.tmpdir(), "codestead-piston-build-"));
  try {
    const archive = path.join(work, "image.tar");
    execFileSync("docker", buildArgs({ epoch: sourceDateEpoch(lock), tag, archive,
      metadataFile: path.join(root, "build-metadata.json"), context: root }), { stdio: "inherit" });
    execFileSync("docker", ["load", "--input", archive], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
