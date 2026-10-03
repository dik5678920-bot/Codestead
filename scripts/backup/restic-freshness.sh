#!/usr/bin/env bash
# Hourly freshness check for the restic -> R2 backups. Fails (and alerts) when
# the last successful backup is older than RESTIC_MAX_BACKUP_AGE_HOURS (36) or
# the last successful monthly restore test is older than
# RESTIC_MAX_RESTORE_TEST_AGE_DAYS (40). Reads local state only; never touches R2.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/restic-common.sh
source "$script_dir/restic-common.sh"

restic_load_config
restic_prepare_dirs
restic_write_metrics

now="$(date -u +%s)"
status=0

if last_backup="$(restic_read_mark last-backup-success)"; then
  age_hours=$(((now - last_backup) / 3600))
else
  age_hours=""
fi
if [[ -z "$age_hours" ]] || ((age_hours > RESTIC_MAX_BACKUP_AGE_HOURS)); then
  restic_alert critical restic_backup_stale \
    "no successful off-site backup within ${RESTIC_MAX_BACKUP_AGE_HOURS}h (age=${age_hours:-never}h)"
  # One administrator email per UTC day at most: the reporter is idempotent on
  # the run key, and this key is fixed for the day.
  restic_report_status failure "$(date -u +%Y%m%d)T000000Z"
  status=1
fi

if last_restore="$(restic_read_mark last-restore-test-success)"; then
  restore_days=$(((now - last_restore) / 86400))
else
  restore_days=""
fi
if [[ -z "$restore_days" ]] || ((restore_days > RESTIC_MAX_RESTORE_TEST_AGE_DAYS)); then
  restic_alert warning restic_restore_test_stale \
    "no successful restore test within ${RESTIC_MAX_RESTORE_TEST_AGE_DAYS}d (age=${restore_days:-never}d)"
  status=1
fi

exit "$status"
