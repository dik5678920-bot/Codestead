#!/usr/bin/env bash
# One-command GlitchTip bring-up on the homelab NUC. Run as root:
#
#   sudo bash infra/observability/glitchtip/setup-glitchtip.sh [--dry-run]
#
# Idempotent. Creates /etc/glitchtip (root 0700) with generated secrets the
# first time (never printed, never overwritten), starts the isolated
# `glitchtip` compose project (migrations run as a one-shot service before web
# and worker start), waits until web is healthy, then prints the owner's next
# steps. It never touches other containers, networks, volumes, the Docker
# engine, port 80, or /etc/cloudflared.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${GLITCHTIP_COMPOSE_FILE:-$script_dir/compose.yaml}"
etc_dir="${GLITCHTIP_ETC_DIR:-/etc/glitchtip}"
docker_bin="${DOCKER_BIN:-docker}"
host_port="${GLITCHTIP_HOST_PORT:-8210}"
public_host="${GLITCHTIP_PUBLIC_HOST:-errors.shivanshmishra.in}"
health_timeout_seconds="${GLITCHTIP_HEALTH_TIMEOUT_SECONDS:-300}"
dry_run=false

usage() {
  echo "usage: sudo bash $0 [--dry-run]" >&2
}

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    -h | --help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

log() { printf '[glitchtip] %s\n' "$*"; }
die() { printf '[glitchtip] ERROR: %s\n' "$*" >&2; exit 1; }

run() {
  if "$dry_run"; then
    printf '[glitchtip] dry-run: %s\n' "$*"
  else
    "$@"
  fi
}

compose() {
  run "$docker_bin" compose --project-name glitchtip --file "$compose_file" "$@"
}

if [[ "${GLITCHTIP_SKIP_ROOT_CHECK:-}" != "1" && "$(id -u)" -ne 0 ]]; then
  die "run with sudo: it writes root-only secrets under $etc_dir"
fi
[[ -f "$compose_file" ]] || die "compose file not found: $compose_file"
[[ "$host_port" =~ ^[0-9]+$ ]] || die "GLITCHTIP_HOST_PORT must be numeric"

# Random, URL-safe secret material; read from the kernel CSPRNG only.
random_secret() {
  head -c "$1" /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-"$2"
}

write_secret_file() {
  local path="$1" mode="$2" content="$3"
  if "$dry_run"; then
    printf '[glitchtip] dry-run: would create %s (mode %s, contents not shown)\n' "$path" "$mode"
    return
  fi
  (umask 077 && printf '%s' "$content" >"$path")
  chmod "$mode" "$path"
}

# --- secrets -----------------------------------------------------------------

if [[ -d "$etc_dir" ]]; then
  log "$etc_dir exists; keeping its secrets"
else
  run install -d -m 0700 "$etc_dir"
fi
run chmod 0700 "$etc_dir"

password_file="$etc_dir/postgres_password"
env_file="$etc_dir/glitchtip.env"

if [[ -s "$password_file" && -s "$env_file" ]]; then
  log "secrets already present; not regenerating"
elif [[ -e "$password_file" || -e "$env_file" ]]; then
  die "only one of $password_file / $env_file exists; refusing to guess. Restore or remove both."
else
  db_password="$(random_secret 48 48)"
  secret_key="$(random_secret 96 64)"
  # The directory is root 0700, so the password file itself may be 0644:
  # the postgres entrypoint reads the bind-mounted secret as uid 999.
  write_secret_file "$password_file" 0644 "$db_password"
  write_secret_file "$env_file" 0600 "SECRET_KEY=$secret_key
DATABASE_URL=postgres://glitchtip:$db_password@postgres:5432/glitchtip
"
  unset db_password secret_key
  log "generated SECRET_KEY and database password in $etc_dir (not shown)"
fi

# --- start -------------------------------------------------------------------

export GLITCHTIP_HOST_PORT="$host_port"
log "pulling pinned images"
compose pull --quiet
log "starting (migrations run first as the one-shot 'migrate' service)"
compose up --detach --wait --wait-timeout "$health_timeout_seconds"

if ! "$dry_run"; then
  # --wait already requires every service healthy; confirm the published
  # loopback port answers too, since that is what cloudflared will use.
  deadline=$((SECONDS + 60))
  until "$docker_bin" compose --project-name glitchtip --file "$compose_file" \
      exec -T web python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/_health/', timeout=4)" \
      >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "web did not become healthy; see: docker compose -p glitchtip logs web"
    sleep 3
  done
fi
log "GlitchTip is healthy on http://127.0.0.1:$host_port"

cat <<EOF

Next steps (owner):

1. Create the first administrator. You will be asked for an email and to type
   your own password (registration is closed, so this is the only way in):

     sudo docker compose -p glitchtip -f $compose_file exec web ./manage.py createsuperuser

2. Open http://localhost:$host_port on the NUC (for example through
   'ssh -L $host_port:localhost:$host_port homelab'), sign in, then:
     a. Create an organization (e.g. "Codestead").
     b. Create a project for the server + workers (platform: Node.js) and a
        second one for the browser (platform: JavaScript).
     c. Open each project's Settings > Client Keys (DSN) and copy the DSN.

3. Put the DSNs in /etc/learncoding/compose.env, replacing the public host with
   the internal one, so reports travel only over the internal
   glitchtip-ingest network (no internet egress):

     SENTRY_DSN=http://<server-key>@glitchtip-web:8000/<server-project-id>
     SENTRY_BROWSER_DSN=http://<browser-key>@glitchtip-web:8000/<browser-project-id>
     SENTRY_RELEASE=<deployed git SHA>

   then redeploy Codestead so the app and workers pick them up. GlitchTip must
   be running first: Codestead joins its glitchtip-ingest network.

4. Optional public UI (needs owner approval before the shared cloudflared is
   touched). The ingress rule to add ABOVE the catch-all in
   /etc/cloudflared/config.yml would be:

     - hostname: $public_host
       service: http://localhost:$host_port
EOF
