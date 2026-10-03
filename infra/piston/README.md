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
node infra/piston/build.mjs codestead-piston:pr5
node infra/piston/test-image.mjs codestead-piston:pr5
```

The build is reproducible. `build.mjs` sets `SOURCE_DATE_EPOCH` to the locked
Debian snapshot time (`sourceDateEpoch` in the lock) and rewrites every layer
timestamp to it. It also builds AppCDS as a static dump of a sorted class list.
The same builder gets the same manifest digest for the same commit. CI builds
twice (the second with `--no-cache`), and `verify-digest.mjs` fails unless both
digests match. Different BuildKit versions (Docker Desktop, the CI runner, the
NUC) can still produce different digests. Exam forms therefore pin the digest of
the deployed, digest-pinned `PISTON_IMAGE`, derived at runtime, and never a
committed digest. A Windows checkout with CRLF line endings also changes the
digest.

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
`pr4b-runtime-handoff.json` records the reference build's live-test result,
runtime labels and build-input hashes. Its digest is a record, not a pin. If an
input changes, rebuild, rerun the live tests and update the handoff.

Legacy-pinned exam snapshots still fail closed on Piston. PR4b needs reviewed
publication/tooling changes and new forms pinned to these exact runtime labels
and the deployed image's digest (`PISTON_IMAGE`). Existing attempt snapshots stay immutable.
No exam pin, evidence record, scoring rule or validator is weakened here.
