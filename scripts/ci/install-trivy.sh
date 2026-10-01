#!/usr/bin/env bash
# Installs the reviewed Trivy release for CI image scanning.
#
# The application image evidence requires exactly Trivy 0.69.3
# (scripts/app-images/manage-application-images.mjs). v0.69.3 is an immutable
# GitHub release published before the March 2026 Trivy supply-chain incident
# (GHSA-69fq-xp46-6x23) and is listed there as not affected.
#
# This replaces aquasecurity/setup-trivy, whose install script first resolves
# the tag through an unauthenticated GitHub lookup that can fail ("unable to
# find 'v0.69.3'") on shared runners. The archive is fetched directly from the
# immutable release and must match the SHA-256 pinned below before anything is
# extracted. The pin equals the official trivy_0.69.3_checksums.txt entry,
# whose sigstore bundle was verified (cosign verify-blob, GitHub Actions OIDC,
# aquasecurity/trivy release workflow) when the pin was reviewed.
set -Eeuo pipefail

readonly TRIVY_VERSION="0.69.3"
readonly TRIVY_ARCHIVE="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
readonly TRIVY_ARCHIVE_SHA256="1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75"
readonly TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ARCHIVE}"

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "install-trivy: only linux/amd64 runners are reviewed" >&2
  exit 1
}
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

work="$(mktemp -d "$RUNNER_TEMP/trivy-install.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
install_dir="$RUNNER_TEMP/trivy-bin"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 5 --retry-all-errors --retry-delay 3 --max-time 300 \
  --output "$work/$TRIVY_ARCHIVE" "$TRIVY_URL"
printf '%s  %s\n' "$TRIVY_ARCHIVE_SHA256" "$work/$TRIVY_ARCHIVE" | sha256sum --check --strict --quiet

mkdir -p "$install_dir"
tar --extract --gzip --file "$work/$TRIVY_ARCHIVE" --directory "$install_dir" --no-same-owner trivy
chmod 0755 "$install_dir/trivy"
[[ "$("$install_dir/trivy" --version | head -n 1)" == "Version: ${TRIVY_VERSION}" ]] || {
  echo "install-trivy: installed binary does not report Trivy ${TRIVY_VERSION}" >&2
  exit 1
}
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
