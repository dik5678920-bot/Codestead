# Piston idle stop (design note, not implemented)

Part of the Piston migration ([piston-runner.md](piston-runner.md)). Default: Piston stays warm. This
note describes an optional flag that stops it when nobody is running code. No code exists yet.

## Why

The Kata micro-VM holds about 400 MB of host RAM idle (750-900 MB right after load). On a NUC that also
runs ~30 other services, giving that back overnight is worth it if the first run afterwards may take
longer. Cold start (container up → first successful run) measured ~3.1 s on a KVM runner.

## Flag

- `PISTON_IDLE_STOP_MINUTES`: unset or `0` = always on (default). `N` = stop Piston after N minutes
  with no runs. Suggested value: 30.

## Who starts and stops it

The app has no Docker access and must not get any: the Docker socket is root-equivalent. A tiny
host-side helper owns the lifecycle instead:

- A systemd timer on the NUC runs every minute. If the app's last-run marker is older than N
  minutes and Piston is running, it runs `docker compose ... stop piston`.
- Wake-up: the app's Piston client gets `PISTON_UNREACHABLE` / `RUNNER_OFFLINE`. It then writes a
  "wake requested" marker and returns the existing `offline` response, which the UI already shows as
  "runner starting, retry". A systemd path unit watching that marker runs `docker compose ... start
  piston`. The learner's retry ~3-5 s later succeeds.
- Markers live in a dedicated, app-writable directory bind-mounted read-only into nothing else. They
  hold no data beyond a timestamp.

No automatic fallback to the legacy runner while Piston starts. That stays fail-closed, as in PR2.

## Open questions

- Should the UI retry automatically after a `wake requested` response instead of asking the learner?
- Do exam sessions keep Piston pinned on for their whole window? Probably yes: start it when an exam
  opens and never idle-stop during one.
