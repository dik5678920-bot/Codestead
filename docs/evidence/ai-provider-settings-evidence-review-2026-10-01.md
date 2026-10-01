# AI provider settings evidence review

This inventory records every evidence change submitted for the requested pre-commit operator review.

Validation is synchronous; Enable previously queued no job and left a pending status. The live connectivity observation was provided by the operator and is recorded separately from local tests. Existing stored keys can use Validate without re-entry. Server-side step-up MFA code is unchanged.

Verification: 214 unit/component tests, 16 authentication-boundary tests, and 7 focused real PostgreSQL tests passed on Node 24.19.0 / native PostgreSQL 18. Typecheck, lint, ledger, Node backup/restore contracts, API authorization, import boundaries, and WSL shell fixture gates passed. Full production build and full release checks were not run.

## Reviewed migration and projections

- Migration corpus: 70 entries through `0069` -> 71 entries through `0070_credential_validation_preference`.
- New journal timestamp: `1790851350433`.
- SQL: absent -> `drizzle/0070_credential_validation_preference.sql`, SHA-256 `e9b4acffdb2813bd55baba8415af965f6a1e55c27f6abeb4baa3c4758491919d`.
- Schema snapshot: absent -> `drizzle/meta/0070_snapshot.json`.
- Ledger digest: `20b480c7dd694d6e8e243704f14aeb05aa42fda4c5b7e863f6c357bf095a2551` -> `174fea1500e62ff0824624beb2e6a20147d2931f494ee7fd03db86685949eca9`.
- Backup/restore pins and fixture assertions: count 70 -> 71, tail index 69 -> 70, tail timestamp 1785009372253 -> 1790851350433, and tag/digest -> the new reviewed tail/digest. Only those projections change.

## Existing evidence: every old -> new binding

| Evidence file | Artifact / field | Old SHA-256 | New SHA-256 |
| --- | --- | --- | --- |
| `docs/evidence/backup-status-outbox-2026-07-12.json` | `scripts/backup/common.sh` | `78d5dd6f317e2b54b468efa08a9eef39a310484f7274bb744e5e79b79eafa01c` | `4a41eacd95beebab9cb7ac035b776f30b70710a6706bebe482d9f013829241fe` |
| `docs/evidence/backup-status-outbox-2026-07-12.json` | `drizzle/meta/_journal.json` | `f62f2d8ce0640aa88eab712de40e463fcb27d7c3f78197e56a248612f2309080` | `24338841f3566bc53b0c3bcdd6afef060b1ff79471246ffc165d5ee21dc727e2` |
| `docs/evidence/backup-status-outbox-2026-07-12.json` | `scripts/lib/reviewed-migration-ledger.mjs` | `ea6edf83dd8ee770013a4be83b6bd9806b08f63e083d449926b6423bd648acd3` | `c6196ca09009a192534fb99b53ffb59fac453e8b652c36f05dfb08cc9e64260e` |
| `docs/evidence/backup-status-outbox-2026-07-12.json` | `infra/tests/backup-ci-registration.test.mjs` | `8ff5095a2a6385a9f5a42498af21490c98f29c000f02bb86c4feb50d58cbbeac` | `05cfa6a409c161f30c87ac869a85de2eab0015555faf0c258d734e4ddb5d57bc` |
| `docs/evidence/api-authorization-matrix-2026-07-12.json` | `.rows[87].operationSourceSha256` | `618dfcbbe184fc7bb7b2c2b72daa45b965b07143518344fb262078a0d39bec3e` | `e60d4638baf6631e2a60500bab2ab1648819ff782c562cad718f72624bce0054` |
| `docs/evidence/api-authorization-matrix-2026-07-12.json` | `.rows[89].operationSourceSha256` | `adfa24d2e096bf99f801da0f67e5d10510e9d0fabb4b3265aebbdd086f5d9a16` | `d3e355c2c94193ad7cd637760adc71c5e7af490b8651f2eae88828a82d50db30` |
| `docs/evidence/provider-outage-fallback-verification-2026-07-12.json` | `drizzle/meta/_journal.json` | `f62f2d8ce0640aa88eab712de40e463fcb27d7c3f78197e56a248612f2309080` | `24338841f3566bc53b0c3bcdd6afef060b1ff79471246ffc165d5ee21dc727e2` |
| `docs/evidence/provider-outage-fallback-verification-2026-07-12.json` | `src/lib/db/schema.ts` | `e9bf049f9bc3ea51c6184913fbb8a089664bd88efd986d62833e097ba06dd82c` | `3a8ff39ee033be76170a126769e04f40d1b01dbb573f0ef35cc7638af1a681e4` |
| `docs/evidence/run-008-official-runner-fairness-2026-07-12.json` | `src/lib/db/schema.ts` | `e9bf049f9bc3ea51c6184913fbb8a089664bd88efd986d62833e097ba06dd82c` | `3a8ff39ee033be76170a126769e04f40d1b01dbb573f0ef35cc7638af1a681e4` |

The three historical verification records also gain an `artifactBindingRefresh` annotation with the original hashes and a reference to the new record. Their original dates, results, scopes, and test counts stay unchanged. The API authorization matrix retains all 161 operations and the same access rules; only PATCH/POST credential source hashes change.

## New evidence

- Absent -> [ai-provider-settings-2026-10-01.json](ai-provider-settings-2026-10-01.json): regression results, corrected diagnosis, migration/digest identity, current source bindings, and explicit verification limits.
- Absent -> this Markdown review: the complete approval inventory.

The focused PostgreSQL tests used representative credential/user tables and the actual migration. They prove migration repair and preference concurrency; they do not claim the historical full PostgreSQL 17 release-cycle gates were rerun.

After evidence approval: commit the reviewed changes, open one PR without a Co-Authored-By trailer, and stop. No deployment is part of this change.
