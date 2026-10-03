import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { buildInputPaths } from "./prepare.mjs";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Usage: node infra/piston/test-image.mjs <built-image>");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
const inspected = JSON.parse(docker("image", "inspect", image))[0];
assert.equal(inspected.Os, "linux");
assert.equal(inspected.Architecture, "amd64");
// Docker's classic store exposes a config ID; its containerd store can expose
// a manifest ID. Require BuildKit metadata and bind either identity explicitly.
const metadata = JSON.parse(await readFile("infra/piston/build-metadata.json", "utf8"));
const manifestDigest = metadata["containerimage.digest"];
const configDigest = metadata["containerimage.config.digest"];
if (![manifestDigest, configDigest].every((value) => /^sha256:[a-f0-9]{64}$/.test(value))
  || ![manifestDigest, configDigest].includes(inspected.Id)) throw new Error("Unbound build manifest");
const imageReference = inspected.RepoDigests?.find((value) => value.endsWith(`@${manifestDigest}`))
  ?? `codestead-piston@${manifestDigest}`;
const embeddedInputs = docker("run", "--rm", "--network", "none", "--entrypoint", "/bin/cat",
  image, "/usr/local/share/codestead-piston/build-inputs.sha256");
const expectedInputs = (await readFile("infra/piston/build-inputs.sha256", "utf8")).trim();
assert.equal(embeddedInputs, expectedInputs, "Image was built from different source inputs");
const name = `codestead-piston-pr5-test-${process.pid}`;
let started = false;
try {
  // Disposable Docker Desktop/CI VM test only. Production compose retains Kata
  // and never uses privileged. Private cgroups avoid touching the host's tree.
  docker("run", "-d", "--name", name, "--privileged", "--cgroupns=private",
    "-p", "127.0.0.1::2000", "--tmpfs", "/piston/jobs", "--tmpfs", "/tmp:exec",
    "--tmpfs", "/var/local/lib/isolate:exec",
    ...Object.entries({ PISTON_DISABLE_NETWORKING: "true", PISTON_RUN_TIMEOUT: "3000",
      PISTON_COMPILE_TIMEOUT: "10000", PISTON_RUN_MEMORY_LIMIT: "268435456",
      PISTON_COMPILE_MEMORY_LIMIT: "536870912", PISTON_MAX_CONCURRENT_JOBS: "2",
      PISTON_OUTPUT_MAX_SIZE: "65536", PISTON_MAX_PROCESS_COUNT: "32" })
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]), image);
  started = true;
  const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["2000/tcp"][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  let inventory;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/v2/runtimes`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { inventory = await response.json(); break; }
    } catch { /* wait for bounded local startup */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!inventory) throw new Error("Piston API did not become ready");
  execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
    "src/lib/runner/__tests__/piston-client.integration.test.ts", "--maxWorkers=1",
    "--outputFile", "test-results/piston-image-live.json"], {
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PISTON_TEST_URL: url, PISTON_TEST_IMAGE: imageReference },
  });
  const lock = JSON.parse(await readFile("infra/piston/image-inputs.lock.json", "utf8"));
  const runtimeKeys = (records) => records.map(({ language, version }) => `${language}@${version}`).sort();
  assert.deepEqual(runtimeKeys(inventory), runtimeKeys(Object.values(lock.runtimes)));
  const inputs = {};
  for (const relative of buildInputPaths) {
    inputs[relative] = createHash("sha256").update(await readFile(path.join("infra/piston", relative))).digest("hex");
    assert.ok(embeddedInputs.split("\n").includes(`${inputs[relative]}  ${relative}`), "Stale build source digest");
  }
  const testInputs = {};
  for (const relative of ["src/lib/runner/client.ts", "src/lib/runner/piston-client.ts",
    "src/lib/runner/__tests__/piston-client.integration.test.ts", "infra/piston/test-image.mjs"]) {
    testInputs[relative] = createHash("sha256").update(await readFile(relative)).digest("hex");
  }
  const report = JSON.parse(await readFile("test-results/piston-image-live.json", "utf8"));
  if (!report.success || report.numPendingTests !== 0) throw new Error("Live suite did not run completely");
  const result = { schemaVersion: 1, platform: "linux/amd64", imageReference, imageConfigDigest: configDigest,
    runtimeLabels: lock.runtimes, observedInventory: inventory, buildInputSha256: inputs, testInputSha256: testInputs,
    validation: { liveTests: report.numPassedTests, passed: true, host: docker("info", "--format", "{{.OperatingSystem}}"),
      kernel: docker("info", "--format", "{{.KernelVersion}}"),
      isolation: "isolate inside disposable Docker Desktop/CI VM; production Kata unchanged" } };
  await writeFile("infra/piston/image-result.json", `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  if (started) process.stderr.write(docker("logs", name));
  throw error;
} finally {
  if (started) docker("rm", "-f", name);
}
