// Fails unless the image just built by build.mjs has exactly the manifest and
// config digests recorded in the reviewed PR4b runtime handoff. The build is
// reproducible, so any builder at this commit must produce these digests; a
// mismatch means an input or the build changed without a reviewed handoff.
//   node infra/piston/verify-digest.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function verifyDigest(metadata, handoff) {
  const manifest = metadata["containerimage.digest"];
  const config = metadata["containerimage.config.digest"];
  const pinned = handoff.imageReference?.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest ?? "") || manifest !== pinned || config !== handoff.imageConfigDigest) {
    throw new Error(`Piston image is not reproducible: built ${manifest} (config ${config}), `
      + `reviewed ${pinned} (config ${handoff.imageConfigDigest})`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  console.log(verifyDigest(await read("./build-metadata.json"), await read("./pr4b-runtime-handoff.json")));
}
