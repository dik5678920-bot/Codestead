# AI provider CI follow-up evidence review

Evidence Phase 2 retires the historical rebinding tool. Its table rows were removed; the original approval inventory remains in Git history.

Rebased on `3a1638ca823eb21fb2c3297df1b3f98f1c82a2b0`. No commits or push pending approval.

All four requested checks pass. The disposable migration harness also passes 20 tests and both release cycles. Owner scanner unchanged. Browser failure was an obsolete hidden-button assertion; server-side durable MFA enforcement and existing session-lifetime policy are unchanged. Password concealment passes locally without changing its spec.

## Existing evidence changes

Eight current binding updates; three metadata additions. Historical results and schema-qualification records remain intact.

| Evidence | Field | Old | New |
| --- | --- | --- | --- |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/docs~1evidence~1api-authorization-matrix-2026-07-12.json` | `25e499dec80e020d60e9a05a9a9c1536484a6238be5de6938ea71ed327840e07` | `dddb32ecd9ece9201fb5f109afb51790b8ceec6460c6f37ed7aa724a70751238` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/docs~1evidence~1run-008-official-runner-fairness-2026-07-12.json` | `7f2aa6fc3f086fc425cd12f2df84d28bb8bb54500fdabc289f5ef47e6401fccf` | `f53e4656463dc9759bb3cf8d4153d074358d5e350174b29a2b98fe42705e91b6` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/integration~1credential-preference-migration.integration.test.ts` | `a9b7382068c7ff13fb160c7f397e30cf03cf31615c3b7f532f0a6c394e51c3b1` | `ceab46370093b4b69bd2682511b88d5fc97705e483a0de918eb82fd868cadc32` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/docs~1evidence~1ai-provider-settings-2026-10-01.json` | `df702adbf280c91fcf36b067ae5258e394536cd4a9ea179e2486f04b74d5fab2` | `8a2ad8e42089ce714d23cbcb9c7743adef452a14655ca0a7a68917ea78e3c11c` |
| docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json | `/artifactSha256/docs~1evidence~1ai-provider-settings-2026-10-01.json` | `df702adbf280c91fcf36b067ae5258e394536cd4a9ea179e2486f04b74d5fab2` | `8a2ad8e42089ce714d23cbcb9c7743adef452a14655ca0a7a68917ea78e3c11c` |
| docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json | `/artifactSha256/docs~1evidence~1ai-provider-settings-ci-pins-2026-10-01.json` | `69e1bceb6a7f1a3a3fa93e30246b7a6832f2f9cb6679b2ce354d174982ebd0f9` | `2ea6f3150af02aaf127c1f420875828ef25c282f1e41d195f38f8b81a90a8c30` |
| docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json | `/artifactSha256/integration~1credential-preference-migration.integration.test.ts` | `a9b7382068c7ff13fb160c7f397e30cf03cf31615c3b7f532f0a6c394e51c3b1` | `ceab46370093b4b69bd2682511b88d5fc97705e483a0de918eb82fd868cadc32` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/ciFollowupRefresh` | absent | scope and changed-field digest inventory |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/ciFollowupRefresh` | absent | scope and changed-field digest inventory |
| docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json | `/ciFollowupRefresh` | absent | scope and changed-field digest inventory |

## New artifacts and bindings

| Artifact | Old | New |
| --- | --- | --- |
| docs/evidence/ai-provider-settings-ci-followup-2026-10-01.json | absent | `37965a1efc24f8c05f888516d09f77b27f9fca34474e8d895e7ca179fe21883f` — new focused verification record |
| docs/evidence/ai-provider-settings-ci-followup-review-2026-10-01.md | absent | this review and complete old→new inventory |
| New record binding: docs/evidence/ai-provider-settings-2026-10-01.json | absent | `8a2ad8e42089ce714d23cbcb9c7743adef452a14655ca0a7a68917ea78e3c11c` |
| New record binding: docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | absent | `2ea6f3150af02aaf127c1f420875828ef25c282f1e41d195f38f8b81a90a8c30` |
| New record binding: docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json | absent | `522c6f15930f35303ed2ffc731072916010d46fe9f017c89bef3ec88294ac46a` |
| New record binding: e2e/assurance.spec.ts | absent | `cd96a09185e4222495c52ffe7e34031ed51ead1e1c05144e99de537f85427985` |
| New record binding: e2e/access.spec.ts | absent | `d7026f69cb0faf066b39e89b8184434b4c58e521b21a2b9fd6861f1444cb5c75` |
| New record binding: infra/tests/mail-guarded-delivery-0069.impl.mjs | absent | `77b54c928cc6360bb4a613f122b80696d0be1984111d789482f1dea9cfa0bd54` |
| New record binding: infra/tests/mail-guarded-delivery-0069-harness.test.mjs | absent | `d88c7e25322870cbfb1cda63b775cc3f40334f45dc52468799afe1360a49db3f` |
| New record binding: integration/credential-preference-migration.integration.test.ts | absent | `ceab46370093b4b69bd2682511b88d5fc97705e483a0de918eb82fd868cadc32` |
| New record binding: integration/support/credential-preference-migration-proof.ts | absent | `dad457f393f97b71c9b2105c0649df2a49a83a98bd9a020c6782f386992fb1ba` |
| New record binding: integration/support/with-validated-owner-fault-injection.ts | absent | `8e2732e4ff6171758a1701c76225ddf574203fdb43b5c6ad6b78f4690c04c84e` |
| New record binding: scripts/__tests__/validated-owner-fault-injection.test.ts | absent | `5c353b5d371135ea9030b709736527821b6c86d8186bf0cd262eac1806cedf74` |
| New record binding: src/lib/security/recent-mfa.ts | absent | `7b7fdebba042cf43467975860630d6606a351f27eeca9a554c4c10b0dc6f8064` |
| New record binding: src/lib/security/privileged-access.ts | absent | `19178909fb882c34536208bee280807930cab4eaf2ebb76ef7c1e1aef15c44fa` |
| New record binding: src/app/api/security/fresh-mfa/route.ts | absent | `5c2c5a0adc32a1e7557128665b788139eaff1a7b77b26552a226c81bf1e223d5` |

## Checks and limits

- `npm run evidence:verify`: pass.
- `npm run test -- scripts/__tests__/validated-owner-fault-injection.test.ts src/lib/security/__tests__/recent-mfa.test.ts src/lib/security/__tests__/credential-mutation-boundaries.test.ts`: pass (82 tests).
- `npm run test:e2e -- e2e/assurance.spec.ts e2e/access.spec.ts --project=chromium`: pass (11 tests).
- `POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-guarded-delivery-0069:pg17`: pass.
- `npm run test:integration -- integration/postgres.integration.test.ts integration/credential-preference-migration.integration.test.ts`: pass (20 tests).
- `node --test infra/tests/mail-guarded-delivery-0069-harness.test.mjs`: pass (13 tests).
- `tsc --noEmit`: pass.
- `eslint on changed source files`: pass.

Focused checks only. Full Vitest, all integration files, all browser projects and production build were not rerun. Prior historical test results remain unchanged. No CI result is asserted.
