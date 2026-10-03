# Expiring development audit exception

The operator requested a single-advisory development exception only after
proving `braces` is absent from production dependencies and shipped images.
The [reviewed advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
reports stack-exhaustion denial of service in braces through 3.0.3 and no
patched release. The exception expires **2026-10-17 at 00:00 UTC**.

Production remains a strict, unfiltered
`npm audit --omit=dev --audit-level=moderate` gate. The separate development
gate invokes `npm audit --include=dev --audit-level=low --json` and fails on
every other advisory, including low/info findings. It recursively resolves
npm's propagated package findings to their advisory leaves; package names are
never independently allowlisted. All affected installation paths must be
classified `dev: true` in the dependency lock. Mixed production/development
paths, unknown causes, cycles, incomplete reports, registry failures and an
expired exception fail closed. A clean audit continues to pass after expiry.
The existing independent runner-package high-severity audit, known-advisory
checks and image/security scanning gates remain intact.

## Production proof (2026-10-03)

Fresh worktree and own dependency install from main
`27015b8116a21191d0a4f820e8364de635e0519d`; no dependency manifests or Dockerfiles
were changed. The production audit passed. The requested dependency command:

```text
npm ls braces --omit=dev
codestead@0.1.0
└── (empty)
```

`npm explain braces` reports `braces@3.0.3 dev`, through
`eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch`.
The full audit's five high-severity package findings resolve to this one GHSA.

Fresh Docker Desktop builds used the unchanged root Dockerfile, targets
`runtime` (app) and `regrade-worker` (the shared production worker base plus
assessment scripts), with main's source revision label. Recursive package
manifest inspection, including nested/symlinked packages and any global Node
packages, found no `braces` or `eslint-config-next`; neither is resolvable from
`/app`. The final images strip npm, so filesystem/module inspection was used
instead of invoking a package manager inside shipped images.

| Image | Local image config digest | Package manifests inspected | braces / eslint-config-next |
| --- | --- | --- | --- |
| App (`runtime`) | `sha256:2f86e2a65a6c4894e920e31966d11a3befe97f3f6af212dfacbb3e989771976d` | 89 | absent / absent |
| Worker (`regrade-worker`) | `sha256:c8ee02bcf6e0ba1719e76e187b1dd730def8fd92faa694f489d3109ed54d3dda` | 643 | absent / absent |

These identify the local validation builds, not deployed image attestations.
Image scans still apply normally in CI. The exception is narrowly limited to
the dev dependency audit and does not waive an image vulnerability finding.
