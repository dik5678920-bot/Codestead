// Fails unless two builds of the same commit by the same builder produced the
// same manifest and config digests (BuildKit metadata files). Digests differ
// across BuildKit versions, so exam forms pin the deployed PISTON_IMAGE digest
// at runtime instead of a committed one; this gate keeps each builder honest.
//   node infra/piston/verify-digest.mjs <first-metadata.json> <second-metadata.json>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function verifyReproducible(first, second) {
  const pick = (metadata) => [metadata["containerimage.digest"], metadata["containerimage.config.digest"]];
  const [manifestA, configA] = pick(first);
  const [manifestB, configB] = pick(second);
  if (![manifestA, configA].every((value) => DIGEST.test(value ?? ""))
    || manifestA !== manifestB || configA !== configB) {
    throw new Error(`Piston image is not reproducible: ${manifestA} (config ${configA}) `
      + `vs ${manifestB} (config ${configB})`);
  }
  return manifestA;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length !== 2) throw new Error("Usage: node infra/piston/verify-digest.mjs <first.json> <second.json>");
  const [first, second] = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  console.log(verifyReproducible(first, second));
}
