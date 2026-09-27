# `curriculum-runtime` CI job: diagnosis

Status: diagnosis only, no code changed. Evidence: run 36334830092 (main @ `bf9ad2d`), job 108663587686.

## What fails
- The only failed step is **step 24, `npm run web:executable:verify`**
  (`tsx scripts/verify-web-executable-tranche.ts --check`).
- Everything before it passes in the same job: runtime build/inspect/test/scan/record,
  `curriculum:runtime-pins:check`, `dsa:parity:verify`, and the
  `c-cpp`, `java-python` and `ai-code` `executable:verify` steps.
- The `if: failure()` step then regenerated the evidence and uploaded it as the
  artifact **`executable-evidence-regenerated`** (id 10936104654, expires 2026-10-11).

## Root cause (most likely, not yet confirmed byte-for-byte)
`--check` goes through `scripts/lib/deterministic-evidence.ts`. That rebuilds the full evidence JSON
with the stored `generatedAt` and requires it to be **byte-identical** to
`docs/evidence/web-executable-runtime-2026-07-12.json`. Otherwise it throws
`Stale evidence artifact …` (or it fails earlier on a failed browser/runner case).

The structural inputs have not changed since `85b8126` ("adopt CI web runtime evidence for pinned
image"). Since then no commit touches `package-lock.json`, `services/runner`, `content/` or the
verify script, and the structure-only check reproduces locally apart from the host Node version.
So the drift must be in a **field observed at runtime** that only the full verify records:
- the JavaScript runtime image digests (`manifestDigest`, `configDigest`, image IDs),
- the Chromium `executableHash`, browser version or revision,
- per-case `status`, `failure` or `consoleErrors` from the Playwright/axe browser cases.

The web tranche is the only one that records browser output (Chromium + axe + console errors). The
three other tranches, which share the same image pipeline, pass. That makes a browser-side field the
prime suspect. `e3d073d` already had to drop wall-clock durations from this evidence for the same
kind of reason.

**Deterministic?** It fails on every recent main run, so it is deterministic for the current
runner image and inputs. Whether it is also *environment-sensitive* (for example, it drifts again
when the Playwright CDN build or GitHub's ubuntu-24.04 image updates) depends on which field it is.

## Why not confirmed
The job log API returns only the last 5,000 lines, which are Docker-daemon teardown noise. The
artifact download URL (blob storage) is blocked from this sandbox. Docker is not available here,
so the full verify cannot be reproduced locally.

## Next step (5 minutes, with gh access)
```sh
gh run download 36334830092 -n executable-evidence-regenerated -D /tmp/regen
diff <(jq -S . docs/evidence/web-executable-runtime-2026-07-12.json) \
     <(jq -S . /tmp/regen/web-executable-runtime-2026-07-12.json)
```
Or look for `Stale evidence artifact` / `status": "failed"` in step 24 of the web UI log.

## Minimal fix, by diff outcome
1. **Only stable runtime fields changed** (for example, the image digest after a pinned base
   rebuild): adopt the CI-regenerated file as `85b8126` did, and refresh the evidence file's sha256
   in `release-quality-gate-2026-07-12.json`.
2. **A volatile field changed** (a console-error text, an executable hash that varies across runner
   images): exclude that field from the deterministic evidence, as `e3d073d` did for durations.
   Keep it in the uploaded diagnostics only.
3. **A browser case really failed**: fix the content item or the verifier. That is a content bug,
   not an evidence refresh.

## Files the fix would touch, and whether they are evidence-pinned
| File | Case | Pinned in `docs/evidence/*.json`? |
|---|---|---|
| `docs/evidence/web-executable-runtime-2026-07-12.json` | 1, 2 | **Yes**: sha256 in `release-quality-gate-2026-07-12.json` |
| `docs/evidence/release-quality-gate-2026-07-12.json` | 1, 2 | It is the pin (`revalidatedAt` + sha256) |
| `scripts/verify-web-executable-tranche.ts` | 2 | **Yes**: listed in `release-quality-gate-2026-07-12.json` |
| `scripts/lib/deterministic-evidence.ts` | (not expected) | **Yes**: same file |
| `docs/evidence/web-executable-structure-2026-07-12.json` | 2, if a field is shared | Check the gate file |

So every variant touches evidence pins. Under the standing rule, whoever applies the fix must have
explicit owner approval to refresh evidence. No regeneration was done here.
It does not overlap with the `application` or `production-topology` jobs.
