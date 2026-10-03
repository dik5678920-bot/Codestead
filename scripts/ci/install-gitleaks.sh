#!/usr/bin/env bash
# Reviewed v8.30.1 release; pin from the upstream gitleaks_8.30.1_checksums.txt.
# Verify the archive before extraction, following install-trivy.sh. Updating the
# version requires reviewing the release and replacing this checked-in hash.
set -Eeuo pipefail

readonly GITLEAKS_VERSION="8.30.1"
readonly GITLEAKS_ARCHIVE="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
readonly GITLEAKS_ARCHIVE_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
readonly GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ARCHIVE}"

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "install-gitleaks: only linux/amd64 runners are reviewed" >&2
  exit 1
}
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

work="$(mktemp -d "$RUNNER_TEMP/gitleaks-install.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
install_dir="$RUNNER_TEMP/gitleaks-bin"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 5 --retry-all-errors --retry-delay 3 --max-time 300 \
  --output "$work/$GITLEAKS_ARCHIVE" "$GITLEAKS_URL"
printf '%s  %s\n' "$GITLEAKS_ARCHIVE_SHA256" "$work/$GITLEAKS_ARCHIVE" | sha256sum --check --strict --quiet

mkdir -p "$install_dir"
tar --extract --gzip --file "$work/$GITLEAKS_ARCHIVE" --directory "$install_dir" --no-same-owner gitleaks
chmod 0755 "$install_dir/gitleaks"
[[ "$("$install_dir/gitleaks" version)" == "$GITLEAKS_VERSION" ]] || {
  echo "install-gitleaks: installed binary does not report ${GITLEAKS_VERSION}" >&2
  exit 1
}
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
