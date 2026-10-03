# Gitleaks comparison gate (OSS audit D13)

CI installs **Gitleaks 8.30.1** from the upstream Linux x64 release archive.
`install-gitleaks.sh` pins its SHA-256 from the
[release checksum file](https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt),
verifies before extraction, checks the binary's reported version, and adds its
private runner-temp directory to PATH. No floating installer action or license
token is needed. Updates require reviewing both release and archive hash.

Every PR runs `scan-gitleaks.sh` in the existing required `quick` gate after a
full-depth checkout. CI supplies the immutable base/head SHAs as environment
variables. Gitleaks scans the commit patches in `base..head`, so adding a secret
and deleting it in a later PR commit still fails. An empty range succeeds.
Missing commits, shallow clones, malformed SHAs, scanner errors, and findings
fail the gate; no `continue-on-error` or baseline hides failures.

**Initial history audit:** when the PR base has no `.gitleaks.toml`, the same
script additionally scans every ancestor of the PR head, including deleted
files. This bootstraps history in the introducing PR. Rerunning that PR repeats
the audit until the config is merged; later PRs scan only their range. It does
not scan unrelated unmerged local branches, nor add a new scheduled scan.
Push/nightly/manual jobs retain the existing scanner; Gitleaks additions run
only for PR events.

`.gitleaks.toml` extends all built-in rules. Each commented fixture exception
requires a matching rule, an anchored exact path, and either an exact synthetic
value or a named source-hash field. Historical removed fixtures remain covered
so the initial history audit can finish. Credential-shaped fixture literals are
spelled as exact regex hex escapes; this does not broaden their match. Both
encoded and decoded forms of two synthetic canaries are listed because
Gitleaks detects both. There are no whole-directory/commit exceptions or
disabled rules. New values in these files still fail. Inline `gitleaks:allow`
comments are ignored and root `.gitleaksignore` files are rejected: this version
loads the root file even when another ignore path is explicitly supplied.

All logs use `--redact=100`; CI uploads no raw findings report. Do not paste
unredacted credentials into configs, tests, logs, commits, or PR discussions.
For a new finding, inspect it privately and establish whether it is synthetic.
A real credential must be revoked and handled as an incident, never allowlisted.

To reproduce with the reviewed binary on PATH, from the repository root:

```bash
node --test scripts/ci/gitleaks.test.mjs
GITLEAKS_BASE_SHA=$(git rev-parse origin/main) \
GITLEAKS_HEAD_SHA=$(git rev-parse HEAD) bash scripts/ci/scan-gitleaks.sh
# Explicit full reachable history review; fully redacted output:
gitleaks git --config .gitleaks.toml --redact=100 --no-banner \
  --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --log-opts=HEAD .
```

`scripts/scan-secrets.ts` and `npm run security:secrets` remain unchanged and
still run in CI. Compare their output with this format/entropy/history detector
before considering removal. A passing scan does not prove all secrets absent.
