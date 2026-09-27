#!/usr/bin/env bash
# Stubbed test for infra/observability/glitchtip/setup-glitchtip.sh: no Docker,
# no root, no network. Proves secrets are generated once with tight modes and
# never printed, the dry run changes nothing, and compose is only ever driven
# for the isolated `glitchtip` project.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/infra/observability/glitchtip/setup-glitchtip.sh"
compose_file="$repo_root/infra/observability/glitchtip/compose.yaml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

docker_log="$work/docker.log"
cat >"$work/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$docker_log"
exit 0
STUB
chmod +x "$work/docker"

export DOCKER_BIN="$work/docker"
export GLITCHTIP_SKIP_ROOT_CHECK=1
export GLITCHTIP_ETC_DIR="$work/etc-glitchtip"

# --- unknown arguments are rejected ------------------------------------------

if bash "$script" --bogus >/dev/null 2>&1; then
  fail "script accepted an unknown argument"
fi

# --- dry run creates nothing and calls no docker ------------------------------

dry_output="$(bash "$script" --dry-run 2>&1)" || fail "dry run failed:
$dry_output"
[[ ! -e "$GLITCHTIP_ETC_DIR" ]] || fail "dry run created $GLITCHTIP_ETC_DIR"
[[ ! -e "$docker_log" ]] || fail "dry run invoked docker"
grep -qF "dry-run: $DOCKER_BIN compose --project-name glitchtip --file $compose_file up --detach --wait" <<<"$dry_output" \
  || fail "dry run did not show the compose up it would run"
grep -qF "contents not shown" <<<"$dry_output" || fail "dry run did not announce secret creation"

# --- real run (stubbed docker) --------------------------------------------------

first_output="$(bash "$script" 2>&1)" || fail "first run failed:
$first_output"

[[ "$(stat -c %a "$GLITCHTIP_ETC_DIR")" == "700" ]] || fail "etc dir is not 0700"
[[ "$(stat -c %a "$GLITCHTIP_ETC_DIR/glitchtip.env")" == "600" ]] || fail "env file is not 0600"
[[ "$(stat -c %a "$GLITCHTIP_ETC_DIR/postgres_password")" == "644" ]] || fail "password file mode unexpected"

password="$(cat "$GLITCHTIP_ETC_DIR/postgres_password")"
secret_key="$(sed -n 's/^SECRET_KEY=//p' "$GLITCHTIP_ETC_DIR/glitchtip.env")"
((${#password} >= 40)) || fail "database password is too short"
((${#secret_key} >= 50)) || fail "SECRET_KEY is too short"
grep -qxF "DATABASE_URL=postgres://glitchtip:$password@postgres:5432/glitchtip" "$GLITCHTIP_ETC_DIR/glitchtip.env" \
  || fail "DATABASE_URL does not use the generated password"
if grep -qF "$password" <<<"$first_output" || grep -qF "$secret_key" <<<"$first_output"; then
  fail "a secret was printed"
fi

grep -qE "createsuperuser" <<<"$first_output" || fail "next steps omit createsuperuser"
grep -qF "service: http://127.0.0.1:8210" <<<"$first_output" || fail "next steps omit the ingress line"

# Every docker call targets only the glitchtip project and its compose file.
while IFS= read -r call; do
  [[ "$call" == "compose --project-name glitchtip --file $compose_file "* ]] \
    || fail "unexpected docker call: $call"
done <"$docker_log"
grep -qE "^compose .* up --detach --wait" "$docker_log" || fail "compose up was not run"

# --- second run keeps existing secrets -----------------------------------------

second_output="$(bash "$script" 2>&1)" || fail "second run failed:
$second_output"
[[ "$(cat "$GLITCHTIP_ETC_DIR/postgres_password")" == "$password" ]] || fail "password was regenerated"
grep -qF "not regenerating" <<<"$second_output" || fail "second run did not keep secrets"

# --- a half-present secret pair is refused ----------------------------------------

rm "$GLITCHTIP_ETC_DIR/glitchtip.env"
if bash "$script" >/dev/null 2>&1; then
  fail "script accepted a half-present secret pair"
fi

# --- compose file stays isolated ---------------------------------------------------

grep -qE '^name: glitchtip$' "$compose_file" || fail "compose project name is not glitchtip"
grep -qE '"127\.0\.0\.1:\$\{GLITCHTIP_HOST_PORT:-8210\}:8000"' "$compose_file" \
  || fail "web is not bound to loopback only"
if grep -qE 'external: *true|network_mode|privileged|/var/run/docker.sock' "$compose_file"; then
  fail "compose file reaches outside its own stack"
fi
image_count="$(grep -cE '^\s*image: ' "$compose_file")"
pinned_count="$(grep -cE '^\s*image: [^ ]+@sha256:[0-9a-f]{64}$' "$compose_file")"
[[ "$image_count" == "$pinned_count" ]] || fail "every image must be pinned by digest"

echo "glitchtip setup test: PASS"
