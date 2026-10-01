# Evidence Phase 2: stop cross-pin churn

Status: **proposal, plan only, nothing implemented**. Phase 1 (#65) removed `generatedAt` and other volatile fields from the deterministic generators. Phase 2 deals with the other source of churn: hashes of *mutable* files inside *historical* evidence records.

## Problem

`npm run evidence:verify` (`scripts/lib/evidence-integrity.ts`) checks every declared hash against the bytes at **HEAD**. Several point-in-time records pin files that keep changing:

| Record | HEAD-relative pins | Mutable targets |
|---|---|---|
| `backup-status-outbox-2026-07-12` | ~31 | `.github/workflows/ci.yml`, `infra/tests/backup-ci-registration.test.mjs`, `src/lib/db/schema.ts`, `drizzle/meta/_journal.json`, backup scripts and tests |
| `ai-provider-settings-2026-10-01` | ~9 | source and tests, plus `backup-status-outbox` |
| `ai-provider-settings-ci-pins-2026-10-01` | ~3 | tests, plus `backup-status-outbox` |
| `ai-provider-settings-migrator-schema-2026-10-01` | ~20, plus 34 previous/current digests in a change log | source, plus the three files above |
| `ai-provider-settings-ci-followup-2026-10-01` | ~15, plus 16 change-log digests | source, plus the three ai-provider files |
| `exm-003-006-008-reliability`, `project-revisions-verification`, `provider-outage-fallback-verification`, `run-008-official-runner-fairness` | 14 / 5 / 2 / 1 | application source |

A PR that touches `ci.yml` (all CI work does) therefore makes `backup-status-outbox` stale. Fixing it changes that file's bytes, which makes the four ai-provider files stale, and fixing those changes them again. #85, #88, #89 and #90 each needed 4–26 owner-approved hash changes plus a conflict resolution on every rebase. None of these re-pins re-ran the proof the record describes.

## Key observation: a re-pinned hash guarantees nothing new

A historical record proves "this check passed **on these bytes**". Moving the pin to new bytes without re-running the check does not extend the proof. It only makes the record claim something nobody verified. The real guarantee that current code still satisfies the contract comes from tests that run on every PR:

- the `infra/tests/*registration*` / `*-ci-contract*` exact projections;
- the role and migration-ledger tests;
- `architecture:check`;
- the reviewed migration ledger in `scripts/lib/reviewed-migration-ledger.mjs`.

So HEAD-relative pins of mutable files in historical records give a false sense of assurance and cost an approval per PR.

## What stays byte-exact (real guarantees, no change)

- **Pins to immutable artifacts.** `release-quality-gate` → runtime evidence, SBOMs, Trivy reports, image inventories. `final-container-image-inventory` → SBOMs. `playwright-matrix-verification`. These change only when a release artifact is deliberately regenerated, which deserves owner approval.
- **Deterministic generator evidence** from Phase 1: `--check` stays byte-exact.
- **Migration identity.** `sqlSha256` / ledger SHA in `reviewed-migration-ledger.mjs` and its registration tests. Runtime image digests, the DSA runtime pins, and the Trivy archive pin.

## Proposal

1. **Commit-anchored source pins.** A historical record gains `sourceCommit: <40-hex>`, the commit its proof ran against. Its path pins are then checked against `git show <sourceCommit>:<path>`, with the same LF canonicalization as today, instead of HEAD. The verifier must also check that:
   - the commit exists and is an ancestor of HEAD (`git merge-base --is-ancestor`); the repo merges with merge commits, so PR commits survive;
   - each recorded hash matches that commit's blob.

   Tampering with a hash, or anchoring to an unknown or non-ancestor commit, fails closed. A shallow clone fails closed with a clear message. The guarantee is unchanged, "these bytes are what was proven", and the record never goes stale.
2. **No evidence → evidence pins between historical records.** Remove the `ai-provider-settings*` → `backup-status-outbox` and ai-provider ↔ ai-provider pins. Each record anchors its own `sourceCommit`. Git already shows that the files existed together.
3. **Delete the in-file change logs.** Remove `ciFollowupRefresh`, `addedEvidenceMetadata[].changes`, `evidenceBindingChanges` and the `previousDigest`/`currentDigest` arrays, plus `scripts/refresh-ai-provider-evidence-bindings.mjs`. They record re-pins, which (see above) add no proof, and git history keeps them.
4. **Currency checks are tests, not pins.** Where a record needs "the current CI still runs this check", that belongs in a registration test, as today, not in a hash of `ci.yml`.
5. **Guard against regression.** The verifier rejects a mutable path pin (outside `docs/evidence/**` artifacts) in a record that has no `sourceCommit`. It also fails closed on every unknown declared pin path, in both anchored and unanchored records; an unrecognized path must never be silently skipped. New records can't reintroduce HEAD-relative pins or bypass verification through unknown paths.

Result: a normal PR that touches `ci.yml`, tests or source needs **zero** evidence hash changes. Approvals are left for real artifact regenerations.

## Migration: small independent PRs

Each PR is test-first and keeps `evidence:verify` green at every step.

1. **Verifier: `sourceCommit` support** (no evidence changes). Tests in `scripts/lib/evidence-integrity.test.ts`:
   - an anchored record with matching blobs passes;
   - a tampered hash gives `STALE_HASH`;
   - an unknown or non-ancestor commit fails;
   - a missing commit object (shallow clone) fails with a "fetch history" message;
   - CRLF is canonicalized.

   CI: the job running `evidence:verify` uses `fetch-depth: 0`, or fetches the anchored commits. The `backup-ci-registration` projection is updated.
2. **Anchor `backup-status-outbox`** (the root of the cascade): add `sourceCommit` and keep its hashes as they are. Pick the commit where they are all true (see the open question below).
3. **Anchor the four `ai-provider-settings*` records.** Drop their cross-pins and change logs, and delete the refresh script and its references.
4. **Anchor the remaining historical records**: exm-003, project-revisions, provider-outage, run-008.
5. **Guard:** the verifier rejects new unanchored mutable-path pins, with a test-first allowlist of immutable artifact roots. **Required in this PR:** reject every unknown declared pin path outside the recognized root-file allowlist and repository roots, regardless of whether the record has `sourceCommit`. Apply this to every supported pin representation; retain all existing commit, hash, traversal, and immutable-artifact checks. Distinguish non-pin metadata explicitly instead of silently ignoring an unknown declared pin. This is the PR that makes the policy permanent.

   Required regression: create a real Git fixture repository containing the root-level file `unlisted-evidence-input.ts`, commit it, and declare this pin in an evidence record:

   ```ts
   sourceHashes: [{
     path: "unlisted-evidence-input.ts",
     sha256: "0".repeat(64),
   }]
   ```

   Run the fixture both with a valid ancestor `sourceCommit` and without `sourceCommit`. The counterexample found during PR 2 currently returns **zero issues and zero hashes checked** in both modes because `repositoryPath` returns `null` and the checker silently returns. PR 5 must make this regression pass by rejecting the declared path:

   ```ts
   const report = await verifyEvidenceIntegrity({ root, markdownRoots: [] });
   expect(report.issues).toContainEqual(expect.objectContaining({
     detail: expect.stringContaining("unlisted-evidence-input.ts"),
   }));
   ```

   Repeat both modes with the correct SHA-256 of the same fixture blob: an unknown path must still be rejected even when its digest matches. The CLI must exit unsuccessfully for these records. Recognized paths with valid pins must continue to pass. This broader path guard is deferred to PR 5 and is not implemented in PR 2.

PRs 2–4 are independent of each other once PR 1 lands. Each one removes HEAD dependence from one cluster.

## What still needs owner approval

- **Each conversion PR (2–4)**, once. These are one-time evidence diffs (`sourceCommit` added, cross-pins and logs removed), listed old→new as now.
- **The verifier and guard PRs (1, 5)**, because they change evidence checks. The tests must show nothing that fails today passes afterwards.
- **Permanently:** any change to immutable-artifact pins (`release-quality-gate`, image inventory, SBOM/Trivy, runtime images), the migration ledger, the Trivy archive pin, and deterministic generator evidence regeneration.
- **No longer:** routine re-pins of `ci.yml`, tests or source inside historical records. Those cases stop existing.

## Open questions for the owner

- **Anchor choice.** Many current hashes were re-pinned without re-running the proof. The options are:
  - (a) anchor at the commit where the *current* values are true, which is honest about what is pinned now but is not the original proof commit;
  - (b) recover the *original* values from the change logs and anchor at the original proof commit, which is more faithful but more work and needs history archaeology.

  I recommend (a) plus a one-line `note` per record stating it, because (b) only helps if someone re-audits those runs.
- **History in CI.** `fetch-depth: 0` costs a few seconds. The alternative is fetching only the anchored SHAs.
