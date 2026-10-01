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
  was about 400 MB idle and 750-900 MB under load (tuned config).

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

Tune the micro-VM. Keep the settings in a copy under `/etc` so a Kata upgrade
does not overwrite them. The values were measured on a KVM runner (see the plan's
tuning table):

- `default_memory = 1536`: a ceiling, not a reservation. 1024 MB was too small
  for Piston to start.
- `default_vcpus = 2`, `default_maxvcpus = 4`: idle vCPUs cost the host nothing.
- `virtio_fs_cache = "always"` and 4 virtiofsd threads: the image is read-only,
  so caching it in the guest is safe. Together with the vCPUs this halved Java
  and cut Python/JavaScript by about 40%.
- `reclaim_guest_freed_memory = true`: balloon free-page reporting. No RSS drop
  was measured within 30 s, but it lets the host take back memory a long idle
  guest has freed.

```bash
install -d /etc/kata-containers/runtime-rs && cp "$(readlink -f /opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml)" /etc/kata-containers/runtime-rs/configuration.toml
```

```bash
sed -i -E -e 's/^(\s*default_memory\s*=).*/\1 1536/' -e 's/^(\s*default_vcpus\s*=).*/\1 2/' -e 's/^(\s*default_maxvcpus\s*=).*/\1 4/' -e 's/^(\s*virtio_fs_cache\s*=).*/\1 "always"/' -e 's/^(\s*virtio_fs_extra_args\s*=).*/\1 ["--thread-pool-size=4", "-o", "announce_submounts"]/' -e 's/^(\s*reclaim_guest_freed_memory\s*=).*/\1 true/' /etc/kata-containers/runtime-rs/configuration.toml
```

```bash
grep -E '^\s*(default_memory|default_vcpus|default_maxvcpus|virtio_fs_cache|virtio_fs_extra_args|reclaim_guest_freed_memory)\s*=' /etc/kata-containers/runtime-rs/configuration.toml
```

Smoke test. The kernel printed must differ from the host's `uname -r`, and
`nproc` must print `2`. A `1` means Kata did not read the `/etc` copy; in that
case apply the same `sed` to
`/opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml`.

```bash
docker run --rm --runtime io.containerd.kata.v2 alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 sh -c 'uname -r; nproc'
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

Kata cannot run Docker healthchecks (no exec into the guest), so check the API
from a throwaway container on the `piston` network. Within about a minute it
should print `{"run":{...,"stdout":"42\n",...`.

```bash
docker run --rm --network learncoding_piston alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 wget -qO- --header content-type:application/json --post-data '{"language":"python","version":"3.12.0","files":[{"content":"print(6*7)"}]}' http://piston:2000/api/v2/execute
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
