#!/usr/bin/env bash
# Operator wrapper: run any restic command against the R2 repository with the
# pinned image and the root-only credentials, e.g.
#   sudo bash /opt/learncoding/scripts/backup/restic.sh init
#   sudo bash /opt/learncoding/scripts/backup/restic.sh snapshots
# Set RESTIC_RESTORE_TARGET to an empty host directory to mount it at /restore.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/restic-common.sh
source "$script_dir/restic-common.sh"

(($#)) || restic_die "usage: restic.sh <restic arguments>"
restic_load_config
restic_prepare_dirs

extra=()
if [[ -n "${RESTIC_RESTORE_TARGET:-}" ]]; then
  [[ "$RESTIC_RESTORE_TARGET" = /* && -d "$RESTIC_RESTORE_TARGET" && ! -L "$RESTIC_RESTORE_TARGET" ]] \
    || restic_die "RESTIC_RESTORE_TARGET must be an existing absolute directory"
  # Restoring preserves file ownership and modes, which needs these capabilities.
  extra+=(-v "$RESTIC_RESTORE_TARGET:/restore" --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE)
fi
restic_run "${extra[@]}" -- "$@"
