# Codestead Piston image

This builds the amd64 image for the existing Kata service. It does not deploy,
change the NUC, flip `CODE_RUNNER_PROVIDER`, or rewrite published exam forms.

`image-inputs.lock.json` pins the Debian trixie base manifest, a fixed Debian
snapshot, upstream Piston/isolate commits, and SHA-256 for **every** downloaded
archive: all Debian dependencies, Temurin, python-build-standalone, Node, and
Piston's npm dependencies (including its two Git dependencies). Debian packages
were resolved from signed snapshot metadata; the reviewed lock captures their
exact bytes. `api-package-lock.json` points exclusively at these local archives
and also checks SHA-512. No install-time Git clone or dependency resolution occurs.

## Build and test on a disposable Docker Desktop/CI VM

Run from the repository root with Docker and Node 22 available:

```sh
npm ci
node --test infra/piston/prepare.test.mjs
node infra/piston/prepare.mjs
docker buildx build --load --network=none --platform linux/amd64 --provenance=false \
  --metadata-file infra/piston/build-metadata.json -t codestead-piston:pr5 infra/piston
node infra/piston/test-image.mjs codestead-piston:pr5
```

The fetcher fails on missing or incorrect SHA-256 values. The Dockerfile checks
the same archive hashes again, installs only local `.deb` files and runs npm
offline. The build creates a compiler-warmed AppCDS archive, then validates it
with `-Xshare:on` for both javac and a hello program. Runtime wrappers use
`-Xshare:auto` so a learner's classpath may execute normally without sharing.
C/C++ headers remain in the image because submissions compile at runtime.

The smoke command uses an ephemeral privileged container **inside the disposable
Docker Desktop/CI VM**, with private cgroups and a random localhost port. It
removes that container even on failure. This is a local execution test, not a
new Kata qualification. Production `compose.yaml`, Kata capabilities and the
network boundary remain unchanged; never run this smoke command on the NUC.
The `Piston image` workflow repeats the offline build and live tests on PRs.
Commands and CI emit logs only on failure.

## Runtime contract and PR4b

The wrappers compile C23, C++20 and Java before running. Java uses the legacy
bounded JVM heap/metaspace/code-cache settings, so a heap allocation failure is
`RUNTIME_ERROR` (exit 1); a cgroup memory kill is still `MEMORY_LIMIT` (137).
Python and JavaScript retain the adapter's separate syntax checks. Node disallows
native addons and prototype mutation; Python runs isolated without bytecode.

Temurin `21.0.12.1+1` is represented by Piston's semver package key `21.0.12`;
the **full** tool identity appears in the result label and download lock. Both
the app adapter inventory and live API inventory are tested against these pins.

The smoke command writes ignored `image-result.json`: actual image manifest and
config digests, runtime labels, API inventory, build-input hashes and test result.
CI uploads that record plus BuildKit metadata; it does not publish an image.
`pr4b-runtime-handoff.json` records the locally tested build. A rebuilt image can
have a different manifest (including AppCDS/build timestamps); PR4b must use the
actual deployed build's verified digest, not treat this local record as a registry
release or copy its digest onto a different image.

Legacy-pinned exam snapshots still fail closed on Piston. PR4b needs reviewed
publication/tooling changes and new forms pinned to these exact runtime labels
and the verified image digest. Existing attempt snapshots stay immutable.
No exam pin, evidence record, scoring rule or validator is weakened here.
