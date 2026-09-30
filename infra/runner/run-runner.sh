#!/bin/sh
set -eu

secret_file="${RUNNER_SHARED_SECRET_FILE:-}"
if [ -z "$secret_file" ] || [ -L "$secret_file" ] || [ ! -f "$secret_file" ] || [ ! -r "$secret_file" ] || [ ! -s "$secret_file" ]; then
  echo "fatal: RUNNER_SHARED_SECRET_FILE must be a readable, non-empty regular file (not a symlink)" >&2
  exit 66
fi
# The reviewed handoff installs the secret as root:<runner group> mode 0440, so
# the runner can read it but never rewrite it and no other account can read it.
if [ "$(stat -c '%u:%g:%a' -- "$secret_file")" != "0:$(id -g):440" ]; then
  echo "fatal: RUNNER_SHARED_SECRET_FILE must be owned by root and the runner group with mode 0440" >&2
  exit 66
fi
RUNNER_SHARED_SECRET=$(cat -- "$secret_file")
export RUNNER_SHARED_SECRET
unset RUNNER_SHARED_SECRET_FILE

if [ "${#RUNNER_SHARED_SECRET}" -lt 32 ]; then
  echo "fatal: runner shared secret must contain at least 32 characters" >&2
  exit 64
fi
if [ "${RUNNER_MAX_CONCURRENCY:-2}" != "2" ]; then
  echo "fatal: this deployment permits exactly two runner jobs" >&2
  exit 64
fi
if [ "${RUNNER_MAX_QUEUE_DEPTH:-}" != "100" ]; then
  echo "fatal: RUNNER_MAX_QUEUE_DEPTH must be the reviewed value 100" >&2
  exit 64
fi

state_root="${RUNNER_STATE_ROOT:-/var/lib/learncoding-runner}"
case "$state_root" in
  /*) ;;
  *)
    echo "fatal: RUNNER_STATE_ROOT must be an absolute path" >&2
    exit 64
    ;;
esac
if [ -L "$state_root" ]; then
  echo "fatal: RUNNER_STATE_ROOT must not be a symlink" >&2
  exit 73
fi
mkdir -p -m 0700 -- "$state_root"
if [ ! -d "$state_root" ] || [ "$(stat -c '%a' -- "$state_root")" != "700" ]; then
  echo "fatal: RUNNER_STATE_ROOT must be a mode-0700 directory" >&2
  exit 73
fi
if [ "$(stat -c '%u' -- "$state_root")" != "$(id -u)" ]; then
  echo "fatal: RUNNER_STATE_ROOT must be owned by the runner user" >&2
  exit 73
fi
export RUNNER_STATE_ROOT="$state_root"

process_lock="$state_root/.runner-process.lock"
if [ -L "$process_lock" ] || { [ -e "$process_lock" ] && [ ! -f "$process_lock" ]; }; then
  echo "fatal: runner process lock path is unsafe" >&2
  exit 73
fi
exec 9>>"$process_lock"
chmod 0600 -- "$process_lock"
if ! /usr/bin/flock --exclusive --nonblock 9; then
  echo "fatal: another runner process already holds RUNNER_STATE_ROOT" >&2
  exit 75
fi
RUNNER_PROCESS_LOCK_HELD=1
RUNNER_PROCESS_LOCK_FD=9
export RUNNER_PROCESS_LOCK_HELD RUNNER_PROCESS_LOCK_FD

temp_root="${RUNNER_TEMP_ROOT:-/var/lib/learncoding-runner/tmp}"
case "$temp_root" in
  /*) ;;
  *)
    echo "fatal: RUNNER_TEMP_ROOT must be an absolute path" >&2
    exit 64
    ;;
esac
if [ -L "$temp_root" ]; then
  echo "fatal: RUNNER_TEMP_ROOT must not be a symlink" >&2
  exit 73
fi
mkdir -p -m 0700 -- "$temp_root"
if [ ! -d "$temp_root" ] || [ "$(stat -c '%a' -- "$temp_root")" != "700" ]; then
  echo "fatal: RUNNER_TEMP_ROOT must be a mode-0700 directory" >&2
  exit 73
fi
if [ "$(stat -c '%u' -- "$temp_root")" != "$(id -u)" ]; then
  echo "fatal: RUNNER_TEMP_ROOT must be owned by the runner user" >&2
  exit 73
fi
export RUNNER_TEMP_ROOT="$temp_root"

docker_binary="${RUNNER_DOCKER_BINARY:-/usr/bin/docker}"
stale_containers="$("$docker_binary" ps --all --quiet --filter label=io.learncoding.runner.job=true)" || {
  echo "fatal: could not enumerate stale runner containers" >&2
  exit 69
}
for container_id in $stale_containers; do
  case "$container_id" in
    ''|*[!0-9a-f]*)
      echo "fatal: Docker returned an invalid stale container id" >&2
      exit 70
      ;;
  esac
  "$docker_binary" rm --force "$container_id" >/dev/null || {
    echo "fatal: could not remove stale runner container $container_id" >&2
    exit 70
  }
done

exec /usr/bin/node /opt/learncoding/services/runner/dist/index.js
