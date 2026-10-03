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

Every change below goes through `/etc/learncoding/compose.env` and then
`infra/ops/redeploy-nuc.sh <git-sha>` with the currently deployed commit (the NUC
has no `learncoding-compose.service`). Re-running it with the deployed sha
rebuilds the same reproducible app images, restarts the app, workers and (when
the profile lists it) `piston`, and waits for `/health/ready`. The runtime
validator accepts `COMPOSE_PROFILES` of exactly empty, `uploads`, `piston`, or
`uploads,piston`, requires a digest-pinned
`PISTON_IMAGE` when `piston` is listed, and rejects `CODE_RUNNER_PROVIDER=piston`
without the profile. The app is always attached to the internal `piston`
network and reads `PISTON_URL=http://piston:2000` from `compose.yaml`.

1. Check that Docker uses the containerd image store. Only that store gives a
   local build a `RepoDigests` entry, which `PISTON_IMAGE` must pin. The output
   must include `io.containerd.snapshotter.v1`; if it does not, stop here.

   ```bash
   docker info --format '{{json .DriverStatus}}'
   ```

2. Build from the deployed checkout. The image bakes in checksum-verified
   language packages, so the running container never needs the network.

   ```bash
   cd /opt/learncoding
   node infra/piston/prepare.mjs
   node infra/piston/build.mjs codestead-piston:$(git rev-parse --short HEAD)
   docker image inspect --format '{{json .RepoDigests}}' codestead-piston:$(git -C /opt/learncoding rev-parse --short HEAD)
   ```

   The second command must print one `codestead-piston@sha256:<64 hex>` entry.
   New exam forms pin whatever digest `PISTON_IMAGE` names, so set it to exactly
   this value. Publication fails closed if `PISTON_IMAGE` is unset or not
   digest-pinned. Rebuilding with a different Docker/BuildKit version can change
   the digest. Existing Piston-pinned attempts then reject the new image, so
   rebuild only between exam windows.

3. Edit `/etc/learncoding/compose.env`: set `PISTON_IMAGE` to that exact
   `codestead-piston@sha256:<64 hex>` value, add the token (`COMPOSE_PROFILES=piston`,
   or `uploads,piston` when uploads are on), and keep `CODE_RUNNER_PROVIDER=legacy`.
   Then redeploy the running commit, which now also starts `piston`:

   ```bash
   sudo bash /opt/learncoding/infra/ops/redeploy-nuc.sh --no-scan "$(git -C /opt/learncoding rev-parse HEAD)"
   ```

4. Kata cannot run Docker healthchecks (no exec into the guest), so check the
   API from a throwaway container on the `piston` network. Within about a
   minute it should print `{"run":{...,"stdout":"42
",...`.

   ```bash
   docker run --rm --network learncoding_piston alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 wget -qO- --header content-type:application/json --post-data '{"language":"python","version":"3.14.8","files":[{"content":"print(6*7)"}]}' http://piston:2000/api/v2/execute
   ```

5. Flag flip (owner approval): set `CODE_RUNNER_PROVIDER=piston` in
   `/etc/learncoding/compose.env` and run the same `redeploy-nuc.sh` command
   again so the app is recreated with it. Practice, exam code and grading corrections all
   select Piston. **Do not flip the flag until the PR4b publication migration is ready:**
   legacy-pinned exam forms reject Piston runtime/image evidence, with no fallback.
   Finish active legacy-pinned attempts first; their snapshots must stay immutable.
   See [the image build and PR4b handoff](../../infra/piston/README.md).

`docker exec` into a Kata container is not supported by this Kata release.
Debug with `docker logs learncoding-piston-1` instead. Later deploys with
`infra/ops/redeploy-nuc.sh` restart `piston` with the app while the profile is
listed; they never build or pull it, so rebuild (steps 2-3) to change it.

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

1. Back to the legacy runner: set `CODE_RUNNER_PROVIDER=legacy` and run
   rerun `redeploy-nuc.sh` with the deployed sha. This alone is a full rollback for
   learners; Piston keeps running but receives no requests.
2. To also stop Piston: remove the `piston` token from `COMPOSE_PROFILES` (leave
   `PISTON_IMAGE` or clear it), redeploy as above, then remove the container:

   ```bash
   docker compose -p learncoding --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile piston rm -sf piston
   ```

To remove Kata entirely: delete `/usr/local/bin/containerd-shim-kata-v2`,
`/etc/kata-containers` and `/opt/kata`.
