# Piston code runner: Phase A spike results and plan

Status: Phase A spike done on 2026-10-01 (local Docker Desktop, Windows host, WSL2 kernel, cgroup v2).
Decision needed before Phase B: **Piston needs a privileged container.** See "Blocker" below.

## What was tested

- Piston image `ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a`
  (the newest published build, created 2025-02-08). Runtimes from the official package repo:
  gcc 10.2.0 (c, c++), java 15.0.2, python 3.12.0.
- Our runner: `DockerJobExecutor` from `services/runner` called directly (no HTTP/HMAC/queue overhead),
  using runtime images built from `services/runner/runtime/Dockerfile` with the pins in `images.env`
  (GCC 14.2.0, Java 21.0.12, Python 3.14.7). Limits for both: 256 MB memory, 1 CPU, 32 pids (ours) /
  64 processes (Piston default), 5 s job wall time (ours) / 3 s run + 10 s compile (Piston).
- Same seven programs per language: hello world, CPU loop, stdin echo, compile error, infinite loop,
  memory bomb, and fork bomb (a thread bomb for Java). Hello and echo ran 10 times; the rest ran twice.

## Benchmark (milliseconds, end-to-end client latency)

`first` is the first call in the series. Our runner is always cold: it starts a fresh container for
compile and another for run. Piston started from a restarted container answered Python in 258 ms
and Java in 479 ms, so its cold start is close to warm.

| Lang | Program | Ours first / p50 / p95 | Piston first / p50 / p95 | Ours result | Piston result |
|---|---|---|---|---|---|
| C | hello | 1127 / 877 / 1290 | 146 / 93 / 146 | ACCEPTED, exit 0 | OK, exit 0 |
| C | cpu loop | 1037 | 210 / 221 | ACCEPTED | OK |
| C | stdin echo | 857 / 907 / 1147 | 122 / 83 / 122 | ACCEPTED | OK |
| C | compile error | 432 / 504 | 67 | COMPILE_ERROR | compile stage code 1 |
| C | infinite loop | 5244 / 5467 | 3296 | TIMEOUT | status TO (wall clock) |
| C | memory bomb | 958 / 984 | 206 / 226 | MEMORY_LIMIT, 137 | code 137, status null |
| C | fork bomb | 888 / 931 | 132 | contained (exit 4) | contained, status OL (output cap) |
| C++ | hello | 1356 / 1360 / 1406 | 263 / 232 / 274 | ACCEPTED | OK |
| C++ | cpu loop | 2417 | 321 / 379 | ACCEPTED | OK |
| C++ | stdin echo | 1451 / 1421 / 1638 | 296 / 251 / 521 | ACCEPTED | OK |
| C++ | compile error | 439 | 76 | COMPILE_ERROR | compile stage code 1 |
| C++ | infinite loop | 5243 | 3191 / 3202 | TIMEOUT | TO |
| C++ | memory bomb | 1330 | 308 | MEMORY_LIMIT | code 137 |
| C++ | fork bomb | 943 | 136 | contained | contained |
| Java | hello | 1599 / 1838 / 1920 | 312 / 288 / 563 | ACCEPTED | OK |
| Java | cpu loop | 1956 | 456 / 558 | ACCEPTED | OK |
| Java | stdin echo | 1809 / 1863 / 1948 | 280 / 286 / 404 | ACCEPTED | OK |
| Java | compile error | 851 | 282 | COMPILE_ERROR | **run stage RE, code 1** (no compile stage) |
| Java | infinite loop | 5241 / 5248 | 2718 / 2814 | TIMEOUT | TO |
| Java | memory bomb | 1854 / 1872 | 452 | RUNTIME_ERROR (OutOfMemoryError, exit 1) | code 137 |
| Java | thread bomb | 2043 | 379 / 434 | contained | contained |
| Python | hello | 1187 / 1702 / 2132 | 82 / 36 / 91 | ACCEPTED | OK |
| Python | cpu loop | 4070 / 4363 | 1822 / 2121 | ACCEPTED | OK |
| Python | stdin echo | 1561 / 1125 / 1621 | 56 / 18 / 56 | ACCEPTED | OK |
| Python | syntax error | 585 | 36 | COMPILE_ERROR | run stage RE, code 1 |
| Python | infinite loop | 5337 | 3113 | TIMEOUT | TO |
| Python | memory bomb | 1169 | 149 | MEMORY_LIMIT, 137 | code 137 |
| Python | fork bomb | 1160 | 70 | contained (29 forks) | contained (62 forks) |

Every stdout matched between the two runners. Piston is about 5-20x faster for short programs
because it has no container start per job. Timeouts are bounded by each runner's configured limit.

## Isolation

Probe run as a Python submission inside Piston (isolate sandbox):

- uid/gid 60003, effective capabilities `0000000000000000`.
- Network: connect to 1.1.1.1 gave `ENETUNREACH`; DNS failed. The sandbox has its own empty network namespace.
- Filesystem: `/`, `/etc` and `/piston/packages` are not writable. Only `/tmp` and `/box` (the per-job
  directory) are writable. Root contains only bin, box, dev, etc, lib, lib64, piston/packages, proc,
  tmp and usr. No host mounts are visible.
- PID namespace: 2 processes visible. RLIMIT_NPROC 64. Environment has only PATH/HOME-type variables.
- Limits: wall/CPU time, output size (1024 chars by default) and process count are enforced.
  **Memory is unlimited by default** (`PISTON_RUN_MEMORY_LIMIT=-1`); it must be set.
  `PISTON_MAX_CONCURRENT_JOBS` defaults to 64, which is too high for one NUC.

### Blocker: the outer container must be privileged

Piston's isolate sandbox creates cgroup v2 groups, so the API container needs write access to the
cgroup tree. Without `--privileged` it fails at startup with
`mkdir: cannot create directory 'isolate/': Read-only file system`. These were tried and all failed:
`--cap-add SYS_ADMIN --cgroupns private`, the same plus `seccomp=unconfined` and `apparmor=unconfined`,
`--cap-add ALL`, and a writable tmpfs over `/sys/fs/cgroup` (which gave "Cgroup v2 not found").
The container also runs as root with a writable root filesystem.

Honest comparison with our runner:

| | Our runner (services/runner) | Piston |
|---|---|---|
| Per-submission boundary | Fresh unprivileged container: cap-drop ALL, no-new-privileges, uid 65532, read-only root, `--network none`, pids/mem/cpu/fsize limits | isolate: namespaces + cgroup v2, uid 60003, no caps, no network, read-only root |
| Service process | Needs the Docker socket (root-equivalent), so it is meant for a dedicated runner VM; Bubblewrap containment on the VM guest | **Privileged root container**. An isolate escape lands in a privileged container, which is effectively host root |
| Shared NUC without a VM | Not safe either (Docker socket access) | Not safe: an isolate escape = NUC root |
| Languages | GCC 14.2 (C23), G++ 14.2 (C++20), Java 21, Python 3.14, Node 22 | Official repo: gcc 10.2, java 15, python 3.12. Newer versions need our own package builds |
| Latency | ~0.9-1.9 s per run | ~0.05-0.5 s per run |

Both runners need a VM boundary to be safe on the shared NUC. Piston's own inner sandbox is as good
as ours; the difference is that Piston's outer container is privileged, so it must not run directly
on the NUC next to the 31 other containers and the Codestead database.

## Interface mapping and gaps

Ours: `POST /v1/jobs` (HMAC-v2 signed, idempotency key, async queue, `GET /v1/jobs/:id`) with
`RunnerJobRequest` -> `RunnerResult` (`status`, `compile`, `run`, `tests[]`, `totals`, `imageDigest`).
Callers: `src/app/api/code/run/route.ts`, `src/app/api/exams/_lib/service.ts`,
`src/lib/assessment-corrections/*`, through `src/lib/runner/client.ts` and `practice-dispatch.ts`.

Piston: synchronous `POST /api/v2/execute` with `{language, version, files[], stdin, args,
compile_timeout, run_timeout, compile_memory_limit, run_memory_limit}` -> `{compile?, run}`, each
`{stdout, stderr, code, signal, status, message, memory, cpu_time, wall_time}`.

| Need | Gap | Fix in the adapter |
|---|---|---|
| Auth | Piston has none | Internal network only; app-side adapter is the only caller |
| COMPILE mode | No compile-only call | Run with a no-op main or ignore the run stage; for C/C++ use the compile result |
| TEST mode with hidden tests | One stdin per call | Adapter loops over tests (one call per test, compile each time), compares output app-side; expected output never leaves the app |
| Java/Python compile errors | Reported as run-stage RE, code 1 | Classify by stderr (`error:` from javac, `SyntaxError`) or add a compile step to our own Java package |
| MEMORY_LIMIT vs RUNTIME_ERROR | Memory kill is code 137 with status null | Map 137 + `memory` near the limit to MEMORY_LIMIT |
| OUTPUT_LIMIT | status `OL` | Map directly |
| TIMEOUT | status `TO` | Map directly |
| Idempotency/async jobs/recovery | Synchronous only | Adapter returns the job result directly; practice/exam code needs a synchronous path behind the flag |
| `imageDigest`/runtime provenance | Only `language`/`version` | Record the Piston image digest + package version from config |
| Error bodies | Malformed JSON returns a Node stack trace | Never expose Piston responses to the browser; adapter sends fixed JSON |
| Language versions | gcc 10.2, java 15, python 3.12 | Custom package builds (Piston `packages/` format) for GCC 14, Java 21, Python 3.14, baked into our image |

## Target architecture (if approved)

- Piston runs in a small dedicated VM on the NUC (the existing `infra/runner-vm` plan), not as a
  privileged container on the NUC host. Packages are baked into the image at build time; the VM has no
  egress and no route to the homelab LAN.
- The app reaches Piston only through a server-side adapter behind `/api/code/run` (existing route),
  with session auth, per-user rate limits, and source/stdin/test size caps. The browser never calls Piston.
- Piston env: `PISTON_RUN_MEMORY_LIMIT=268435456`, `PISTON_COMPILE_MEMORY_LIMIT=536870912`,
  `PISTON_MAX_CONCURRENT_JOBS=4`, `PISTON_OUTPUT_MAX_SIZE=65536`, `PISTON_DISABLE_NETWORKING=true`,
  `PISTON_MAX_PROCESS_COUNT=32`.
- The `RunnerClient` interface stays; a `PistonRunnerClient` implements it and is selected by
  `CODE_RUNNER_PROVIDER=legacy|piston` (default `legacy`).

## Migration (small PRs, each behind the flag)

1. Piston VM/compose definition with pinned digest, baked packages, limits, no egress, and an infra
   test that the sandbox has no network.
2. `PistonRunnerClient` adapter + status mapping + unit tests from the table above (no callers changed).
3. Wire `/api/code/run` (practice RUN/COMPILE) to the provider flag.
4. Wire exam TEST runs and assessment corrections to the flag.
5. Custom Piston packages for GCC 14, Java 21 and Python 3.14 so results match lessons.
6. After a week on `piston` with no regressions: delete `services/runner`, `infra/runner*`, the runtime
   image release tooling, and their evidence files.

Rollback: set `CODE_RUNNER_PROVIDER=legacy` and restart the app. Nothing is deleted until step 6.

## Options for the blocker (owner decision)

1. **Piston in a dedicated VM on the NUC** (recommended). Privileged mode stays inside the VM. Same
   boundary the current runner already expects; costs about 2 GB RAM and one VM to maintain.
2. **Piston privileged directly on the NUC.** Fastest, but an isolate escape is NUC root. Not recommended.
3. **Keep our runner and add a warm container pool.** No privileged mode, but it is more custom code,
   which goes against the open-source preference.
