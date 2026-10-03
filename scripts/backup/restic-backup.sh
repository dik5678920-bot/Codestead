#!/usr/bin/env bash
# Nightly off-site backup: PostgreSQL custom dump + uploaded objects -> restic
# repository on Cloudflare R2, then retention (7 daily, 4 weekly, 6 monthly)
# with prune, then a structural repository check.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/restic-common.sh
source "$script_dir/restic-common.sh"

restic_load_config
restic_prepare_dirs

run_key="$(date -u +%Y%m%dT%H%M%SZ)"
stage=""
finished=0

on_exit() {
  local status=$?
  [[ -n "$stage" ]] && rm -rf -- "$stage"
  if ((status != 0 || !finished)); then
    restic_alert critical restic_backup_failed "off-site backup failed; inspect journalctl -u learncoding-restic-backup.service"
    restic_report_status failure "$run_key"
    restic_write_metrics || true
  fi
  exit "$status"
}
trap on_exit EXIT

# Share the existing backup lock: the mail outbox cutover holds it as a
# database-writer fence, so this run waits rather than dumping mid-cutover.
exec 9>"$BACKUP_LOCK_FILE"
flock -w 3600 9 || restic_die "timed out waiting for the backup lock"

stage="$(mktemp -d -- "$RESTIC_STAGE_ROOT/learncoding-restic.XXXXXX")"
chmod 0700 -- "$stage"

restic_log "restic backup phase=dump"
restic_compose exec -T postgres sh -ceu \
  'exec pg_dump --host=/run/learncoding-postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  >"$stage/database.dump" \
  || restic_die "pg_dump failed"
[[ -s "$stage/database.dump" ]] || restic_die "pg_dump produced an empty dump"
# A truncated custom-format dump fails to list; never upload one.
restic_compose exec -T postgres pg_restore --list <"$stage/database.dump" >/dev/null \
  || restic_die "database dump failed its table-of-contents check"

backup_paths=("$RESTIC_DUMP_PATH")
mounts=(-v "$stage:/stage:ro")
uploads="$LEARN_DATA_ROOT/app-data/objects"
if [[ -d "$uploads" && ! -L "$uploads" ]]; then
  mounts+=(-v "$uploads:$RESTIC_UPLOADS_PATH:ro")
  backup_paths+=("$RESTIC_UPLOADS_PATH")
else
  restic_log "restic backup uploads directory absent; backing up the database only"
fi

restic_log "restic backup phase=upload"
restic_run "${mounts[@]}" -- backup --quiet \
  --host "$RESTIC_SNAPSHOT_HOST" --tag "$RESTIC_SNAPSHOT_TAG" \
  "${backup_paths[@]}" \
  || restic_die "restic backup failed"
rm -rf -- "$stage"
stage=""

restic_log "restic backup phase=retention"
restic_run -- forget --quiet --prune \
  --host "$RESTIC_SNAPSHOT_HOST" --tag "$RESTIC_SNAPSHOT_TAG" \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 6 \
  || restic_die "restic forget/prune failed"

restic_log "restic backup phase=check"
restic_run -- check --quiet || restic_die "restic check failed"

restic_mark last-backup-success
restic_write_metrics
finished=1
restic_report_status success "$run_key"
restic_log "restic backup complete"
