#!/usr/bin/env bash
set -euo pipefail

# No compose.env, account file, Docker socket or writable host mount is exposed.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
slots="${1:-2}"
if [[ $# -gt 1 || ! "$slots" =~ ^(2|4)$ ]]; then
  echo 'Usage: bash scripts/piston-capacity.sh [2|4] (label only; does not change slots)' >&2
  exit 2
fi
image='grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34'
log="$(mktemp)"
trap 'rm -f -- "$log"' EXIT
if ! docker image inspect "$image" >/dev/null 2>&1; then
  if ! docker pull --quiet "$image" >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    exit 1
  fi
fi
set +e
docker run --rm --pull never --network learncoding_piston \
  --read-only --user 12345:12345 --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 256m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --mount "type=bind,src=$root/load/piston-capacity.js,dst=/load/piston-capacity.js,readonly" \
  --mount "type=bind,src=$root/infra/piston/image-inputs.lock.json,dst=/load/runtime-lock.json,readonly" \
  --workdir /load --env "CAPACITY_SLOTS=$slots" \
  "$image" run --quiet --no-usage-report --new-machine-readable-summary=false /load/piston-capacity.js >"$log" 2>&1
status=$?
set -e
if grep -q '^Piston capacity |' "$log"; then
  sed -n '/^Piston capacity |/,$p' "$log"
elif [[ $status -ne 0 ]]; then
  tail -n 30 "$log" >&2
else
  echo 'Capacity run produced no summary.' >&2
  exit 1
fi
exit "$status"
