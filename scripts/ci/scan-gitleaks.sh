#!/usr/bin/env bash
# CI supplies immutable PR SHAs through env, never interpolated shell code.
set -Eeuo pipefail
: "${GITLEAKS_BASE_SHA:?GITLEAKS_BASE_SHA is required}"
: "${GITLEAKS_HEAD_SHA:?GITLEAKS_HEAD_SHA is required}"
[[ "$GITLEAKS_BASE_SHA" =~ ^[0-9a-f]{40}$ && "$GITLEAKS_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "scan-gitleaks: expected full commit SHAs" >&2
  exit 1
}
[[ "$(gitleaks version)" == 8.30.1 ]] || {
  echo "scan-gitleaks: expected reviewed Gitleaks 8.30.1" >&2
  exit 1
}
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || {
  echo "scan-gitleaks: full checkout history is required" >&2
  exit 1
}
git cat-file -e "${GITLEAKS_BASE_SHA}^{commit}"
git cat-file -e "${GITLEAKS_HEAD_SHA}^{commit}"
[[ ! -e .gitleaksignore && ! -L .gitleaksignore ]] || {
  # v8.30.1 also loads the source root's file even with an explicit ignore path.
  echo "scan-gitleaks: .gitleaksignore is not permitted; review narrow config entries" >&2
  exit 1
}

# Ignore inline suppressions and fingerprint files; only reviewed config entries
# may suppress findings. Keep all logs fully redacted; no raw report artifact.
flags=(--config .gitleaks.toml --redact=100 --no-banner
  --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null)
echo "Gitleaks: scan PR commit diff"
gitleaks git "${flags[@]}" --log-opts="${GITLEAKS_BASE_SHA}..${GITLEAKS_HEAD_SHA}" .

# Bootstrap once: this introducing PR's base has no config. Once merged, future
# PRs use only the range above. Reruns before merge deliberately repeat the audit.
if ! git cat-file -e "${GITLEAKS_BASE_SHA}:.gitleaks.toml" 2>/dev/null; then
  echo "Gitleaks: initial full history audit (all ancestors of the PR head)"
  gitleaks git "${flags[@]}" --log-opts="$GITLEAKS_HEAD_SHA" .
fi
