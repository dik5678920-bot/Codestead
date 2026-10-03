import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.GITLEAKS_BIN || "gitleaks";
const config = join(root, ".gitleaks.toml");
const scanScript = join(root, "scripts/ci/scan-gitleaks.sh");
const fixturePath = "services/runner/src/__tests__/fixtures.ts";
// Construct synthetic values at runtime; no credential-shaped test token in Git.
const fixtureSecret = ["test", "secret", "that", "is", "at", "least", "32", "bytes", "long"].join("-");
function freshCanary(t) {
  const directory = workspace(t);
  const report = join(directory, "finding.json");
  const files = ["canary-api.ts", "canary-shared.ts"];
  // Entropy and stopword filters can reject random values. Prove that this
  // fresh value hits the real rule in both contexts before testing bypasses.
  for (let attempt = 0; attempt < 10; attempt++) {
    const canary = randomBytes(24).toString("base64url");
    write(directory, files[0], `api_key = "${canary}";\n`);
    write(directory, files[1], `sharedSecret = "${canary}";\n`);
    rmSync(report, { force: true });
    const result = scan(directory, "dir", ["--report-format=json", `--report-path=${report}`]);
    assert.ok(result.status === 0 || result.status === 1, "canary pre-check scanner failed");
    if (result.status === 1) {
      const findings = JSON.parse(readFileSync(report, "utf8"));
      if (files.every((file) => findings.some((finding) =>
        finding.RuleID === "generic-api-key" && finding.File.endsWith(file)))) {
        return canary;
      }
    }
  }
  assert.fail("could not generate a detectable generic-api-key canary");
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "gitleaks-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function write(directory, file, value) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function scan(directory, mode = "dir", extra = []) {
  write(directory, "empty-ignore", "");
  return spawnSync(binary, [mode, "--config", config, "--redact=100", "--no-banner",
    "--ignore-gitleaks-allow", "--gitleaks-ignore-path", join(directory, "empty-ignore"),
    ...extra, "."], { cwd: directory, encoding: "utf8" });
}
function git(directory, ...args) {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, "fixture Git command failed");
  return result.stdout.trim();
}
function init(directory) {
  git(directory, "init", "--quiet");
  git(directory, "config", "user.name", "Synthetic fixture");
  git(directory, "config", "user.email", "fixture@example.invalid");
}
function commit(directory) {
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "synthetic fixture");
  return git(directory, "rev-parse", "HEAD");
}

test("reviewed binary is required", () => {
  const result = spawnSync(binary, ["version"], { encoding: "utf8" });
  assert.equal(result.status, 0, "Gitleaks is unavailable");
  assert.equal(result.stdout.trim(), "8.30.1");
});

test("fixture exception requires both the exact path and exact value", (t) => {
  const directory = workspace(t);
  write(directory, fixturePath, `sharedSecret = "${fixtureSecret}";\n`);
  assert.equal(scan(directory).status, 0, "known fixture should be allowed");
  write(directory, fixturePath, `sharedSecret = "${freshCanary(t)}";\n`);
  assert.equal(scan(directory).status, 1, "new secret in fixture path must fail");
  write(directory, fixturePath, "// fixture removed\n");
  write(directory, "other.test.ts", `sharedSecret = "${fixtureSecret}";\n`);
  assert.equal(scan(directory).status, 1, "same fixture outside reviewed path must fail");
});

test("inline suppressions cannot hide canaries and reports are redacted", (t) => {
  const directory = workspace(t);
  const canary = freshCanary(t);
  write(directory, "unexpected.ts", `api_key = "${canary}"; // gitleaks:allow\n`);
  const report = join(directory, "finding.json");
  const result = scan(directory, "dir", ["--verbose", "--report-format=json", `--report-path=${report}`]);
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(canary), "logs must redact the canary");
  const finding = JSON.parse(readFileSync(report, "utf8"))[0];
  assert.equal(finding.Secret, "REDACTED");
  rmSync(report);
});

test("PR commit range catches a canary removed before the final tree", (t) => {
  const directory = workspace(t);
  init(directory);
  write(directory, "README.md", "clean fixture\n");
  const base = commit(directory);
  write(directory, "unexpected.ts", `api_key = "${freshCanary(t)}";\n`);
  commit(directory);
  write(directory, "unexpected.ts", "// removed\n");
  const head = commit(directory);
  assert.equal(scan(directory).status, 0);
  assert.equal(scan(directory, "git", [`--log-opts=${base}..${head}`]).status, 1);
});

test("CI bootstrap audits old history; subsequent PRs only scan their range", {
  skip: process.platform === "win32" ? "Linux CI shell contract is tested in Docker" : false,
}, (t) => {
  const directory = workspace(t);
  init(directory);
  write(directory, "old.ts", `api_key = "${freshCanary(t)}";\n`);
  commit(directory);
  write(directory, "old.ts", "// removed\n");
  const base = commit(directory);
  write(directory, ".gitleaks.toml", readFileSync(config));
  const head = commit(directory);
  const run = (baseSha, headSha) => spawnSync("bash", [scanScript], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, GITLEAKS_BASE_SHA: baseSha, GITLEAKS_HEAD_SHA: headSha },
  });
  const bootstrap = run(base, head);
  assert.equal(bootstrap.status, 1, "initial audit must catch old removed canary");
  assert.match(bootstrap.stdout, /initial full history audit/);
  write(directory, "README.md", "next clean PR\n");
  const next = commit(directory);
  const incremental = run(head, next);
  assert.equal(incremental.status, 0);
  assert.ok(!incremental.stdout.includes("initial full history audit"));
  write(directory, ".gitleaksignore", "a-fingerprint\n");
  const forbiddenIgnore = run(head, next);
  assert.notEqual(forbiddenIgnore.status, 0);
  assert.match(forbiddenIgnore.stderr, /\.gitleaksignore is not permitted/);
  rmSync(join(directory, ".gitleaksignore"));
  assert.notEqual(run("invalid;echo bypass", next).status, 0, "reject shell-bearing SHA input");
  const shallow = join(workspace(t), "shallow");
  git(directory, "clone", "--quiet", "--depth=1", `file://${directory}`, shallow);
  const shallowResult = spawnSync("bash", [scanScript], {
    cwd: shallow, encoding: "utf8",
    env: { ...process.env, GITLEAKS_BASE_SHA: next, GITLEAKS_HEAD_SHA: next },
  });
  assert.notEqual(shallowResult.status, 0);
  assert.match(shallowResult.stderr, /full checkout history is required/);
});

test("installer rejects a bad checksum before tar, execution or PATH publication", {
  skip: process.platform === "win32" ? "Linux installer is tested in Docker" : false,
}, (t) => {
  const directory = workspace(t);
  const mockBin = join(directory, "mock-bin");
  mkdirSync(mockBin);
  const curl = join(mockBin, "curl");
  writeFileSync(curl, '#!/bin/bash\nwhile (($#)); do\n  if [[ "$1" == --output ]]; then printf "corrupt archive" >"$2"; exit 0; fi\n  shift\ndone\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(mockBin, "tar"), '#!/bin/bash\ntouch "$RUNNER_TEMP/tar-called"\nexit 0\n', { mode: 0o755 });
  const githubPath = join(directory, "github-path");
  writeFileSync(githubPath, "");
  const result = spawnSync("bash", [join(root, "scripts/ci/install-gitleaks.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_PATH: githubPath },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum.*(match|FAILED)/i);
  assert.throws(() => readFileSync(join(directory, "tar-called")), /ENOENT/);
  assert.equal(readFileSync(githubPath, "utf8"), "");
});
