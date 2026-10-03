# Piston PR4b hash review

Base: `27015b8116a21191d0a4f820e8364de635e0519d` (latest origin/main when the
fresh `piston-pr4b-publication` worktree was created). Own `npm ci` completed.

The API authorization inventory was regenerated with its owning command,
`npm run security:api-surface:apply`. Its only semantic change is the exam
service source binding below. Endpoint counts, authorization rules, ownership
anchors and all other declared hashes are unchanged. No historical evidence,
PR5 handoff hash, image input hash or immutable attempt snapshot was re-pinned.

| Changed value | Old SHA256 | New SHA256 |
| --- | --- | --- |
| API inventory: exam service `sourceSha256` | `d467863e93a5f05c4b2525ce60aefcda58937c09dae706a568a4e3c3bf8caa78` | `d0bae20cb71fd44c5fd23dcb93adb92b1f477dabf260614f83c48df1c2f84b08` |
| API inventory file SHA256 (review bookkeeping) | `c447704992d792a64ddd580dcea28f36c0e3d27a2f010e49d4b2b0e924e566c6` | `a41423a134b061e8b10f481de8a6c9440392e0b5dc92f07ed498db518520cb7e` |

The reviewed runtime-only publication revision is
`infra/piston/pr4b-publication-pins.json`. The Piston labels and manifest are
taken from the unchanged PR5 handoff. New independently reviewed publication
forms use those pins when the Piston rollout is selected; immutable legacy
attempts, their recovery, corrections and equivalent retake/recheck lineages
retain legacy pins and dispatch to legacy. Both providers must remain available
while their stored lineages need execution. No schema migration is required;
0070 and all latest-migration pins remain unchanged.

Validation: own dependency install; focused exam/publication/correction/runner
suite (652 passed, 20 live-image tests skipped); 121 final
publication/submission/correction parity and recovery tests;
13 authorization decision tests; typecheck; lint; architecture; reviewed
migration ledger; PR5 handoff guards; API surface; evidence integrity; diff
whitespace check. Logs are emitted only on failure.

The operator approved these exact evidence values on 2026-10-03, conditional on
proving both provider-gated publication cases and confirming that CI runs the
20 live-image tests. Both conditions are satisfied: the provider matrix covers
all five languages (legacy grading needs no Piston configuration), and the
path-triggered Piston image workflow invokes the live tests with an actual
Docker endpoint. The single PR includes the pin revision, snapshot/provider
routing, tests, plan update and this evidence regeneration.
