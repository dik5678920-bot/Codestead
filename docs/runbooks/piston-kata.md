# Piston on Kata Containers (NUC)

Piston runs learner code. It must run under the Kata Containers runtime, which
gives the container its own micro-VM and kernel. The capabilities and cgroup
remount the Piston service needs apply only to that guest kernel. Never start
the `piston` service with the default `runc` runtime, and never add
`privileged: true`.

Plan and measurements: [docs/plans/piston-runner.md](../plans/piston-runner.md).

## Requirements

- Intel VT-x enabled in the NUC BIOS, so `/dev/kvm` exists.
- Docker Engine as installed. Do not change the engine version; Kata plugs in
  through containerd's shim interface and needs no daemon change.
- About 1.5 GB of RAM for the micro-VM. The host RSS measured on a KVM runner
  was ~450 MB idle and ~880 MB under two concurrent jobs.

## Install Kata 4.2.0 (one time)

Run on the NUC as root.

```bash
test -c /dev/kvm && echo "KVM ok"
```

```bash
curl -fsSL -o /var/tmp/kata-static-4.2.0-amd64.tar.zst https://github.com/kata-containers/kata-containers/releases/download/4.2.0/kata-static-4.2.0-amd64.tar.zst
```

```bash
echo "b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8  /var/tmp/kata-static-4.2.0-amd64.tar.zst" | sha256sum -c -
```

Extracting needs `zstd` (`apt-get install zstd` if it is missing). This
creates `/opt/kata` only.

```bash
zstd -dc /var/tmp/kata-static-4.2.0-amd64.tar.zst | tar -x -C / && rm /var/tmp/kata-static-4.2.0-amd64.tar.zst
```

```bash
ln -sf /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
```

Size the micro-VM. Kata reads `/etc/kata-containers/runtime-rs/configuration.toml`
before its shipped default, so a copy there survives Kata upgrades. 1024 MB was
measured as too small: Piston never finished starting.

```bash
install -d /etc/kata-containers/runtime-rs && cp "$(readlink -f /opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml)" /etc/kata-containers/runtime-rs/configuration.toml
```

```bash
sed -i -E 's/^(\s*default_memory\s*=).*/\1 1536/' /etc/kata-containers/runtime-rs/configuration.toml && grep -E '^\s*default_memory' /etc/kata-containers/runtime-rs/configuration.toml
```

Smoke test. The kernel printed must differ from the host's `uname -r`.

```bash
docker run --rm --runtime io.containerd.kata.v2 alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 uname -r
```

## Build and start Piston

The image bakes in its language packages (checksum-verified at build time), so
the running container never needs the network. Build from the deployed
checkout:

```bash
docker build -t codestead-piston:$(git -C /opt/learncoding rev-parse --short HEAD) /opt/learncoding/infra/piston
```

Set `PISTON_IMAGE=codestead-piston:<that tag>` in `/etc/learncoding/compose.env`,
add `piston` to `COMPOSE_PROFILES`, then start only that service:

```bash
docker compose -p learncoding --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile piston up -d --no-deps piston
```

It should report `healthy` within about a minute.

```bash
docker inspect -f '{{.State.Health.Status}}' learncoding-piston-1
```

`docker exec` into a Kata container is not supported by this Kata release.
Debug with `docker logs learncoding-piston-1` instead.

## What protects the host

- Kata micro-VM: own kernel, own memory, only basic devices. A learner probe saw
  kernel 6.18 on a 6.17 host, the VM's 1.45 GB of memory, and only
  null/zero/random/tty/pts devices.
- isolate, inside the VM: each job runs as its own uid with no capabilities, no
  network, a read-only root, and memory/time/process/output limits.
- Compose: the `piston` network is `internal`, so nothing in it can reach the
  internet or the homelab LAN. No ports are published, and there are no host
  mounts or secrets.

## Rollback

Stop the service. The app keeps using the legacy runner until
`CODE_RUNNER_PROVIDER=piston` is set.

```bash
docker compose -p learncoding --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile piston rm -sf piston
```

To remove Kata entirely: delete `/usr/local/bin/containerd-shim-kata-v2`,
`/etc/kata-containers` and `/opt/kata`.
