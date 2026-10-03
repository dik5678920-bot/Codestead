#!/usr/bin/env bash
# Hermetic tests for the restic -> R2 backup scripts. docker is replaced by a
# stub that records every invocation, so no container, network, or R2 access is
# needed. Run: bash infra/tests/restic-backup.test.sh
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="$repo_root/scripts/backup"
systemd="$repo_root/infra/systemd"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  echo "restic-backup-test-failed: $*" >&2
  exit 1
}

secret_password='test-restic-password-0123456789abcdef'
secret_key_id='TESTKEYID0123456789'
secret_key='test-secret-access-key-abcdefghijklmnop'

# --- docker stub -------------------------------------------------------------
mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -u
log="$STUB_DIR/docker.log"
printf '%s\n' "$*" >>"$log"
# Record what the restic container would see, without logging values.
if [[ "$*" == *"restic/restic:"* ]]; then
  for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [[ -n "${!name:-}" ]] || { echo "missing env $name" >>"$STUB_DIR/errors"; }
  done
fi
args=" $* "
fail_on="${STUB_FAIL:-}"
case "$args" in
  *" pg_dump "*|*"exec pg_dump "*)
    [[ "$fail_on" == dump ]] && exit 1
    [[ "$fail_on" == empty-dump ]] && exit 0
    printf 'PGDMP-fake-dump'
    ;;
  *" pg_restore --list"*)
    cat >/dev/null
    [[ "$fail_on" == toc ]] && exit 1
    ;;
  *" backup --quiet "*)
    [[ "$fail_on" == backup ]] && exit 1
    ;;
  *" forget "*)
    [[ "$fail_on" == forget ]] && exit 1
    ;;
  *" check --quiet --read-data-subset"*)
    [[ "$fail_on" == data-check ]] && exit 1
    ;;
  *" check --quiet "*)
    [[ "$fail_on" == check ]] && exit 1
    ;;
  *" dump --host "*)
    printf 'PGDMP-fake-dump'
    ;;
  *" backup-status-reporter "*)
    echo "$args" | grep -o 'BACKUP_REPORT_OUTCOME=[a-z]*' >>"$STUB_DIR/reports"
    echo queued
    ;;
  *" run -d "*)
    echo container-id
    ;;
  *" pg_isready "*) ;;
  *" createdb "*) ;;
  *" pg_restore --username"*)
    cat >/dev/null
    [[ "$fail_on" == restore ]] && exit 1
    ;;
  *"drizzle.__drizzle_migrations"*)
    [[ "$fail_on" == sanity ]] && { echo 0; exit 0; }
    echo 71
    ;;
  *"information_schema.tables"*)
    echo 120
    ;;
  *" rm -f "*) echo removed >>"$STUB_DIR/removed" ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"
cat >"$work/bin/logger" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_DIR/logger.log"
STUB
chmod +x "$work/bin/logger"
cat >"$work/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/bin/sleep"

new_case() {
  case_dir="$work/case-$1"
  rm -rf -- "$case_dir"
  mkdir -p "$case_dir/state" "$case_dir/cache" "$case_dir/data/app-data/objects" "$case_dir/repo"
  touch "$case_dir/repo/compose.yaml"
  printf 'POSTGRES_IMAGE=postgres:17-bookworm@sha256:%s\n' "$(printf 'a%.0s' {1..64})" >"$case_dir/compose.env"
  cat >"$case_dir/alert-hook" <<HOOK
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$case_dir/alerts"
HOOK
  chmod +x "$case_dir/alert-hook"
  cat >"$case_dir/backup.env" <<ENV
REPO_ROOT=$case_dir/repo
COMPOSE_ENV_FILE=$case_dir/compose.env
LEARN_DATA_ROOT=$case_dir/data
BACKUP_LOCK_FILE=$case_dir/backup.lock
ALERT_HOOK=$case_dir/alert-hook
RESTIC_STATE_DIR=$case_dir/state
RESTIC_CACHE_DIR=$case_dir/cache
RESTIC_METRICS_TEXTFILE_DIR=$case_dir
RESTIC_REPOSITORY=s3:https://0123abcd.r2.cloudflarestorage.com/codestead-backups/restic
RESTIC_PASSWORD=$secret_password
AWS_ACCESS_KEY_ID=$secret_key_id
AWS_SECRET_ACCESS_KEY=$secret_key
ENV
  chmod 0600 "$case_dir/backup.env"
}

run_script() {
  local script="$1"
  shift
  env -i PATH="$work/bin:/usr/bin:/bin" HOME="$work" STUB_DIR="$case_dir" \
    BACKUP_CONFIG_FILE="$case_dir/backup.env" "$@" \
    bash "$scripts/$script" >"$case_dir/out" 2>&1
}

assert_no_secrets() {
  local file
  for file in "$case_dir"/out "$case_dir"/docker.log "$case_dir"/alerts "$case_dir"/logger.log; do
    [[ -f "$file" ]] || continue
    if grep -Fq -e "$secret_password" -e "$secret_key_id" -e "$secret_key" "$file"; then
      fail "$1: a secret value appeared in $(basename "$file")"
    fi
  done
  [[ ! -f "$case_dir/errors" ]] || fail "$1: restic container lacked credentials: $(cat "$case_dir/errors")"
}

# --- backup: success -----------------------------------------------------------
new_case backup-ok
run_script restic-backup.sh || { cat "$case_dir/out" >&2; fail "backup-ok exited nonzero"; }
grep -q ' pg_dump ' "$case_dir/docker.log" || fail "backup-ok did not dump the database"
grep -q 'pg_restore --list' "$case_dir/docker.log" || fail "backup-ok did not verify the dump"
grep -q -- '-v .*/case-backup-ok/data/app-data/objects:/uploads:ro' "$case_dir/docker.log" \
  || fail "backup-ok did not mount uploads read-only"
grep -q 'backup --quiet --host codestead --tag codestead /stage/database.dump /uploads' "$case_dir/docker.log" \
  || fail "backup-ok did not back up the dump and uploads"
grep -q 'forget --quiet --prune --host codestead --tag codestead --keep-daily 7 --keep-weekly 4 --keep-monthly 6' "$case_dir/docker.log" \
  || fail "backup-ok retention policy drifted"
grep -q 'restic/restic:0.19.1@sha256:[0-9a-f]\{64\} check --quiet$' "$case_dir/docker.log" \
  || fail "backup-ok did not run restic check"
order="$(grep -o -e ' pg_dump ' -e 'backup --quiet' -e 'forget --quiet' -e ' check --quiet' "$case_dir/docker.log" | tr -d ' ' | tr '\n' ,)"
[[ "$order" == "pg_dump,backup--quiet,forget--quiet,check--quiet," ]] || fail "backup-ok phase order was $order"
[[ -s "$case_dir/state/last-backup-success" ]] || fail "backup-ok did not record success"
grep -q 'codestead_backup_last_success_timestamp_seconds [1-9]' "$case_dir/codestead_backup.prom" \
  || fail "backup-ok did not export the success metric"
grep -qx 'BACKUP_REPORT_OUTCOME=success' "$case_dir/reports" || fail "backup-ok did not report success"
[[ -z "$(find "$case_dir/state" -maxdepth 1 -name 'learncoding-restic.*')" ]] || fail "backup-ok left staging behind"
[[ ! -f "$case_dir/alerts" ]] || fail "backup-ok raised an alert"
assert_no_secrets backup-ok
for flag in '--cap-drop ALL' '--read-only' '--security-opt no-new-privileges' '-e RESTIC_PASSWORD ' '--hostname codestead'; do
  grep -q -- "$flag" "$case_dir/docker.log" || fail "backup-ok restic container missing $flag"
done

# --- backup: no uploads directory -> database only ------------------------------
new_case backup-no-uploads
rmdir "$case_dir/data/app-data/objects"
run_script restic-backup.sh || fail "backup-no-uploads exited nonzero"
grep -q 'backup --quiet --host codestead --tag codestead /stage/database.dump$' "$case_dir/docker.log" \
  || fail "backup-no-uploads should back up the database only"

# --- backup: failures never record success and always alert/report -------------
for failure in dump empty-dump toc backup forget check; do
  new_case "backup-fail-$failure"
  if run_script restic-backup.sh STUB_FAIL="$failure"; then
    fail "backup-fail-$failure exited zero"
  fi
  [[ ! -e "$case_dir/state/last-backup-success" ]] || fail "backup-fail-$failure recorded success"
  grep -q 'restic_backup_failed' "$case_dir/alerts" || fail "backup-fail-$failure did not alert"
  grep -qx 'BACKUP_REPORT_OUTCOME=failure' "$case_dir/reports" || fail "backup-fail-$failure did not report failure"
  [[ -z "$(find "$case_dir/state" -maxdepth 1 -name 'learncoding-restic.*')" ]] || fail "backup-fail-$failure left staging behind"
  assert_no_secrets "backup-fail-$failure"
done
for failure in dump empty-dump toc; do
  if grep -q 'backup --quiet' "$work/case-backup-fail-$failure/docker.log"; then
    fail "backup-fail-$failure uploaded a bad dump"
  fi
done

# --- config validation -----------------------------------------------------------
new_case config-mode
chmod 0644 "$case_dir/backup.env"
run_script restic-backup.sh && fail "config-mode accepted a world-readable config"
grep -q 'mode 0600' "$case_dir/out" || fail "config-mode gave the wrong reason"
[[ ! -f "$case_dir/docker.log" ]] || fail "config-mode ran docker"

new_case config-placeholder
sed -i 's/^RESTIC_PASSWORD=.*/RESTIC_PASSWORD=REPLACE_WITH_RESTIC_REPOSITORY_PASSWORD/' "$case_dir/backup.env"
run_script restic-backup.sh && fail "config-placeholder accepted a placeholder"

new_case config-repo
sed -i 's#^RESTIC_REPOSITORY=.*#RESTIC_REPOSITORY=/local/path#' "$case_dir/backup.env"
run_script restic-backup.sh && fail "config-repo accepted a non-s3 repository"

new_case config-short-password
sed -i 's/^RESTIC_PASSWORD=.*/RESTIC_PASSWORD=short/' "$case_dir/backup.env"
run_script restic-backup.sh && fail "config-short-password accepted a short password"

new_case config-symlink
mv "$case_dir/backup.env" "$case_dir/real.env"
ln -s "$case_dir/real.env" "$case_dir/backup.env"
run_script restic-backup.sh && fail "config-symlink accepted a symlinked config"

# --- freshness -------------------------------------------------------------------
now="$(date -u +%s)"
new_case fresh
echo "$((now - 3600))" >"$case_dir/state/last-backup-success"
echo "$((now - 86400))" >"$case_dir/state/last-restore-test-success"
run_script restic-freshness.sh || { cat "$case_dir/out" >&2; fail "fresh state failed the freshness check"; }
[[ ! -f "$case_dir/alerts" ]] || fail "fresh state alerted"
grep -q "codestead_backup_last_success_timestamp_seconds $((now - 3600))" "$case_dir/codestead_backup.prom" \
  || fail "fresh state did not export the backup metric"

new_case stale
echo "$((now - 37 * 3600))" >"$case_dir/state/last-backup-success"
echo "$((now - 86400))" >"$case_dir/state/last-restore-test-success"
run_script restic-freshness.sh && fail "a 37h-old backup passed the freshness check"
grep -q 'restic_backup_stale' "$case_dir/alerts" || fail "stale backup did not alert"
grep -qx 'BACKUP_REPORT_OUTCOME=failure' "$case_dir/reports" || fail "stale backup did not report"
grep -q "BACKUP_REPORT_RUN_KEY=$(date -u +%Y%m%d)T000000Z" "$case_dir/docker.log" \
  || fail "stale report must use the per-day idempotency key"

new_case edge-35h
echo "$((now - 35 * 3600))" >"$case_dir/state/last-backup-success"
echo "$((now - 86400))" >"$case_dir/state/last-restore-test-success"
run_script restic-freshness.sh || fail "a 35h-old backup must still pass"

new_case never
run_script restic-freshness.sh && fail "missing backup state passed the freshness check"
grep -q 'age=never' "$case_dir/alerts" || fail "missing state alert lacks age=never"

new_case restore-stale
echo "$((now - 3600))" >"$case_dir/state/last-backup-success"
echo "$((now - 41 * 86400))" >"$case_dir/state/last-restore-test-success"
run_script restic-freshness.sh && fail "a 41-day-old restore test passed"
grep -q 'restic_restore_test_stale' "$case_dir/alerts" || fail "stale restore test did not alert"

new_case garbage-mark
echo 'not-a-number' >"$case_dir/state/last-backup-success"
echo "$((now - 86400))" >"$case_dir/state/last-restore-test-success"
run_script restic-freshness.sh && fail "a corrupt state file passed the freshness check"

# --- restore test ----------------------------------------------------------------
new_case restore-ok
run_script restic-restore-test.sh || { cat "$case_dir/out" >&2; fail "restore-ok exited nonzero"; }
grep -q 'check --quiet --read-data-subset=10%' "$case_dir/docker.log" || fail "restore-ok did not read pack data"
grep -q 'dump --host codestead --tag codestead latest /stage/database.dump' "$case_dir/docker.log" \
  || fail "restore-ok did not dump the latest snapshot"
grep -q 'run -d --name learncoding-restore-test-[0-9]*-[0-9]* --network none --tmpfs /var/lib/postgresql/data' "$case_dir/docker.log" \
  || fail "restore-ok throwaway postgres must have no network and tmpfs data"
grep -q "postgres:17-bookworm@sha256:" "$case_dir/docker.log" || fail "restore-ok did not use the pinned postgres image"
grep -q 'pg_restore --username=postgres --dbname=restore_test --no-owner --no-acl --exit-on-error' "$case_dir/docker.log" \
  || fail "restore-ok did not restore with --exit-on-error"
grep -q 'removed' "$case_dir/removed" || fail "restore-ok did not remove the throwaway container"
[[ -s "$case_dir/state/last-restore-test-success" ]] || fail "restore-ok did not record success"
grep -q 'migrations=71 public_tables=120' "$case_dir/out" || fail "restore-ok did not report sanity counts"
if grep -q -e ' compose ' "$case_dir/docker.log"; then
  fail "restore test must never touch the live compose project"
fi
assert_no_secrets restore-ok

for failure in data-check restore sanity; do
  new_case "restore-fail-$failure"
  run_script restic-restore-test.sh STUB_FAIL="$failure" && fail "restore-fail-$failure exited zero"
  [[ ! -e "$case_dir/state/last-restore-test-success" ]] || fail "restore-fail-$failure recorded success"
  grep -q 'restic_restore_test_failed' "$case_dir/alerts" || fail "restore-fail-$failure did not alert"
  [[ -z "$(find "$case_dir/state" -maxdepth 1 -name 'learncoding-restic-restore.*')" ]] \
    || fail "restore-fail-$failure left its work directory"
done
grep -q 'removed' "$work/case-restore-fail-sanity/removed" || fail "failed restore test did not remove the container"

new_case restore-unpinned
echo 'POSTGRES_IMAGE=postgres:17' >"$case_dir/compose.env"
run_script restic-restore-test.sh && fail "restore test accepted an unpinned postgres image"

# --- static contracts --------------------------------------------------------------
require_exact() {
  local file="$1" line="$2"
  [[ "$(tr -d '\r' <"$file" | grep -Fxc -- "$line")" -eq 1 ]] || fail "$(basename "$file") must contain exactly: $line"
}
require_exact "$scripts/restic-common.sh" 'readonly RESTIC_VERSION=0.19.1'
require_exact "$scripts/restic-common.sh" 'readonly RESTIC_IMAGE="restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510"'
require_exact "$scripts/restic-common.sh" '# f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c'
if grep -n 'set -x\|xtrace' "$scripts"/restic*.sh; then
  fail "restic scripts must never enable xtrace (it would print secrets)"
fi

for unit in backup freshness restore-test; do
  service="$systemd/learncoding-restic-$unit.service"
  timer="$systemd/learncoding-restic-$unit.timer"
  [[ -f "$service" && -f "$timer" ]] || fail "missing learncoding-restic-$unit units"
  require_exact "$service" "ExecStart=/usr/bin/bash /opt/learncoding/scripts/backup/restic-$unit.sh"
  require_exact "$service" 'OnFailure=learncoding-alert@%n.service'
  require_exact "$service" 'User=root'
  require_exact "$service" 'Type=oneshot'
  require_exact "$service" 'UMask=0077'
  require_exact "$service" 'Documentation=/opt/learncoding/docs/runbooks/backups-r2.md'
  require_exact "$timer" 'Persistent=true'
  require_exact "$timer" "Unit=learncoding-restic-$unit.service"
  if grep -q 'mnt/learncoding-backups' "$service"; then
    fail "learncoding-restic-$unit.service must not require the absent local backup drive"
  fi
done
require_exact "$systemd/learncoding-restic-backup.timer" 'OnCalendar=*-*-* 03:30:00 UTC'
require_exact "$systemd/learncoding-restic-freshness.timer" 'OnUnitActiveSec=1h'
require_exact "$systemd/learncoding-restic-restore-test.timer" 'OnCalendar=*-*-01 05:00:00 UTC'

example="$repo_root/infra/env/backup.env.example"
for key in RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  tr -d '\r' <"$example" | grep -Eq "^$key=REPLACE_[A-Z0-9_]+$" || fail "backup.env.example $key must be a REPLACE_ placeholder"
done
require_exact "$example" 'RESTIC_MAX_BACKUP_AGE_HOURS=36'
[[ -f "$repo_root/docs/runbooks/backups-r2.md" ]] || fail "missing docs/runbooks/backups-r2.md"

echo "restic backup tests passed"
