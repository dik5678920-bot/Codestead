# PR #85: restricted migrator correction — evidence approval

Evidence Phase 2 retires the historical rebinding tool. Its table rows were removed; the original approval inventory remains in Git history.

This is the complete additional evidence delta compared with committed head c82cde6. No commit or push has been made for this correction.

Migration SQL SHA-256: `e9b4acffdb2813bd55baba8415af965f6a1e55c27f6abeb4baa3c4758491919d` → `a8bc8bb47d8da80858fcd16d0a2de6b4bbd6b06f22c5380fd4a879fe2ac36a3c`.

Ledger identity: `174fea1500e62ff0824624beb2e6a20147d2931f494ee7fd03db86685949eca9` → `8baecb4eedbb6f55a41b685438f9329197431d72580645c8c01a6017d7cfeeb6`; count, index, timestamp, and migration tag are unchanged. Runtime inventory, physical-column provenance, and backup/restore digest projections were regenerated. No historical migration SQL changed.

| Existing evidence | JSON field | Old | New |
| --- | --- | --- | --- |
| docs/evidence/backup-status-outbox-2026-07-12.json | `/sourceHashes/0/sha256` | `4a41eacd95beebab9cb7ac035b776f30b70710a6706bebe482d9f013829241fe` | `1fdc86e957a5523da851faa63fecc05e9b9c339931224282c4b53a1d05cafd49` |
| docs/evidence/backup-status-outbox-2026-07-12.json | `/sourceHashes/9/sha256` | `c6196ca09009a192534fb99b53ffb59fac453e8b652c36f05dfb08cc9e64260e` | `b472f3384219f0490423b043e2078fd5d5afedd2480cb65837a9c79525fbfef2` |
| docs/evidence/backup-status-outbox-2026-07-12.json | `/artifactBindingRefresh/changes/0/sha256` | `4a41eacd95beebab9cb7ac035b776f30b70710a6706bebe482d9f013829241fe` | `1fdc86e957a5523da851faa63fecc05e9b9c339931224282c4b53a1d05cafd49` |
| docs/evidence/backup-status-outbox-2026-07-12.json | `/artifactBindingRefresh/changes/2/sha256` | `c6196ca09009a192534fb99b53ffb59fac453e8b652c36f05dfb08cc9e64260e` | `b472f3384219f0490423b043e2078fd5d5afedd2480cb65837a9c79525fbfef2` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/migration/sqlSha256` | `e9b4acffdb2813bd55baba8415af965f6a1e55c27f6abeb4baa3c4758491919d` | `a8bc8bb47d8da80858fcd16d0a2de6b4bbd6b06f22c5380fd4a879fe2ac36a3c` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/migration/newLedgerSha256` | `174fea1500e62ff0824624beb2e6a20147d2931f494ee7fd03db86685949eca9` | `8baecb4eedbb6f55a41b685438f9329197431d72580645c8c01a6017d7cfeeb6` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/evidenceChanges/0/sha256` | `4a41eacd95beebab9cb7ac035b776f30b70710a6706bebe482d9f013829241fe` | `1fdc86e957a5523da851faa63fecc05e9b9c339931224282c4b53a1d05cafd49` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/evidenceChanges/2/sha256` | `c6196ca09009a192534fb99b53ffb59fac453e8b652c36f05dfb08cc9e64260e` | `b472f3384219f0490423b043e2078fd5d5afedd2480cb65837a9c79525fbfef2` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/docs~1evidence~1backup-status-outbox-2026-07-12.json` | `342764d17d36f5e3d96ce3c5476c62c59b0ab848feaffe791674d8dc00011fdc` | `8ad1361dbb36494165e5ea6aba7ac43f5582bfdb67a68fbdeb82457f0d6fc269` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/drizzle~10070_credential_validation_preference.sql` | `e9b4acffdb2813bd55baba8415af965f6a1e55c27f6abeb4baa3c4758491919d` | `a8bc8bb47d8da80858fcd16d0a2de6b4bbd6b06f22c5380fd4a879fe2ac36a3c` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/infra~1tests~1recovery-evidence-verifier.test.sh` | `24f4642fb1f78a2dcd56bb987a674ed393f54561affd569fd3945bb0a2f820c5` | `55718a4d326cedb14bec8028ab4a7a954b4203062c96b075ef9ceba29a82e084` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/infra~1tests~1restore-drill-reminder.test.sh` | `92996ccacf49db494249c268c62cf311522084924516cda9940212be66678df5` | `2e04284ae5f37c93e869a585488fc073ad8c409c0be355e2148e4026fbb5fa18` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/integration~1credential-preference-migration.integration.test.ts` | `5f89db49892720542dec39f33e98e1b220a5c9620b808ef09c8b2433bc66c040` | `a9b7382068c7ff13fb160c7f397e30cf03cf31615c3b7f532f0a6c394e51c3b1` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/scripts~1backup~1common.sh` | `4a41eacd95beebab9cb7ac035b776f30b70710a6706bebe482d9f013829241fe` | `1fdc86e957a5523da851faa63fecc05e9b9c339931224282c4b53a1d05cafd49` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/artifactSha256/scripts~1lib~1reviewed-migration-ledger.mjs` | `c6196ca09009a192534fb99b53ffb59fac453e8b652c36f05dfb08cc9e64260e` | `b472f3384219f0490423b043e2078fd5d5afedd2480cb65837a9c79525fbfef2` |
| docs/evidence/ai-provider-settings-2026-10-01.json | `/ciPinFollowup/changes/0/sha256` | `342764d17d36f5e3d96ce3c5476c62c59b0ab848feaffe791674d8dc00011fdc` | `8ad1361dbb36494165e5ea6aba7ac43f5582bfdb67a68fbdeb82457f0d6fc269` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/evidenceChanges/1/sha256` | `342764d17d36f5e3d96ce3c5476c62c59b0ab848feaffe791674d8dc00011fdc` | `8ad1361dbb36494165e5ea6aba7ac43f5582bfdb67a68fbdeb82457f0d6fc269` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/docs~1evidence~1ai-provider-settings-2026-10-01.json` | `daa03aebe5d845faebb40b5dd240467ce6d41881bfe40576e6f038c0ca7b940e` | `df702adbf280c91fcf36b067ae5258e394536cd4a9ea179e2486f04b74d5fab2` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/docs~1evidence~1backup-status-outbox-2026-07-12.json` | `342764d17d36f5e3d96ce3c5476c62c59b0ab848feaffe791674d8dc00011fdc` | `8ad1361dbb36494165e5ea6aba7ac43f5582bfdb67a68fbdeb82457f0d6fc269` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/docs~1reviewed-migration-inventory-pins.md` | `c0d99fe71aa793d292ef4dc05ab12a57d9338cb471c2500aaeb12831d2358f31` | `cfccee3116a90b6e3e2bf262b77a92b43b7c88b14e2d3d8b888a58e9a2aebfda` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/drizzle~1meta~10070_public_column_attnums.json` | `ccb570feacc782971c12564d4eaeec176a9b6cc4fd746cea21fd3d93d252e4c0` | `445e46c714041c037d7474a39d940cf065e92951ba6c2bbd0f2b2fdc73bb2e75` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/scripts~1bootstrap-database-runtime-capabilities.test.mjs` | `32573d89581f17ac661b0907ff75123c40f5140feafb0be08afc67bd891dcee0` | `b2c598f870b2402ebd35043adfa6d96b9a97712e2b747d0eff6d1c87ef713257` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/scripts~1database-runtime-capabilities.mjs` | `e2512d97a65cb36cb20eb7835172180659c73a5c46499cd78a78d66a7b10af28` | `8b7b6c332a640403c9f7c1c040d86423a2377221e43ca08b3bf0f26b66cb8864` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/scripts~1database-runtime-capabilities.test.mjs` | `499d4ca3af55ac6fe5045ddb6044df764eefc17a68c6a37cb834d313ff8415d0` | `7ef8f59844909ea4231434e8d40b7c71beca8353d9cfed4bcb6ddff33de23980` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/scripts~1sync-reviewed-database-inventory.mjs` | `deefd37b3c62fee9a880fd6e651f5762c197c7241e31305f65392a1ef1dfb0c0` | `4433c8403e62321fcf46fc866399d75d6a272738961893b14f44351fc4325621` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | `/artifactSha256/scripts~1verify-database-runtime-capabilities.test.mjs` | `e209271ad3c54fdae33410d6bf4609463a7318e1335a4a18af803ccf3483dfb9` | `d98606edf5334208c4fc610c87f9686f9223f6ba785b3a6f6a746b9b6f5db030` |

Each of the three existing evidence records adds `/schemaQualificationRefresh`: absent → a scope annotation and the exact replaced field values. These annotations preserve prior digests; earlier test results and dates are unchanged. The added metadata is recorded in full in the new JSON record.

New evidence: `docs/evidence/ai-provider-settings-migrator-schema-2026-10-01.json` (absent → actual restricted-migrator release-cycle proof, 7/7 PostgreSQL tests in two files, 145 role-boundary tests, checks/limits, generator commands, every existing evidence field change above, and these source bindings).

| New artifact binding | Old | New SHA-256 |
| --- | --- | --- |
| docs/evidence/ai-provider-settings-2026-10-01.json | absent | `df702adbf280c91fcf36b067ae5258e394536cd4a9ea179e2486f04b74d5fab2` |
| docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json | absent | `69e1bceb6a7f1a3a3fa93e30246b7a6832f2f9cb6679b2ce354d174982ebd0f9` |
| docs/evidence/backup-status-outbox-2026-07-12.json | absent | `8ad1361dbb36494165e5ea6aba7ac43f5582bfdb67a68fbdeb82457f0d6fc269` |
| docs/reviewed-migration-inventory-pins.md | absent | `cfccee3116a90b6e3e2bf262b77a92b43b7c88b14e2d3d8b888a58e9a2aebfda` |
| drizzle/0070_credential_validation_preference.sql | absent | `a8bc8bb47d8da80858fcd16d0a2de6b4bbd6b06f22c5380fd4a879fe2ac36a3c` |
| drizzle/meta/0070_public_column_attnums.json | absent | `445e46c714041c037d7474a39d940cf065e92951ba6c2bbd0f2b2fdc73bb2e75` |
| infra/tests/recovery-evidence-verifier.test.sh | absent | `55718a4d326cedb14bec8028ab4a7a954b4203062c96b075ef9ceba29a82e084` |
| infra/tests/restore-drill-reminder.test.sh | absent | `2e04284ae5f37c93e869a585488fc073ad8c409c0be355e2148e4026fbb5fa18` |
| integration/credential-preference-migration.integration.test.ts | absent | `a9b7382068c7ff13fb160c7f397e30cf03cf31615c3b7f532f0a6c394e51c3b1` |
| scripts/backup/common.sh | absent | `1fdc86e957a5523da851faa63fecc05e9b9c339931224282c4b53a1d05cafd49` |
| scripts/bootstrap-database-runtime-capabilities.test.mjs | absent | `b2c598f870b2402ebd35043adfa6d96b9a97712e2b747d0eff6d1c87ef713257` |
| scripts/database-runtime-capabilities.mjs | absent | `8b7b6c332a640403c9f7c1c040d86423a2377221e43ca08b3bf0f26b66cb8864` |
| scripts/database-runtime-capabilities.test.mjs | absent | `7ef8f59844909ea4231434e8d40b7c71beca8353d9cfed4bcb6ddff33de23980` |
| scripts/lib/reviewed-migration-ledger.mjs | absent | `b472f3384219f0490423b043e2078fd5d5afedd2480cb65837a9c79525fbfef2` |
| scripts/sync-reviewed-database-inventory.mjs | absent | `4433c8403e62321fcf46fc866399d75d6a272738961893b14f44351fc4325621` |
| scripts/sync-reviewed-migration-hashes.mjs | absent | `72c1e0d4c369587c3ef568030ad92abcba620fe4c47ce6a76675edc98187520a` |
| scripts/verify-database-runtime-capabilities.test.mjs | absent | `d98606edf5334208c4fc610c87f9686f9223f6ba785b3a6f6a746b9b6f5db030` |

New review document: `docs/evidence/ai-provider-settings-migrator-schema-review-2026-10-01.md` (absent → this inventory). Historical review documents retain their originally approved values.

The actual repository harness applied migrations 0000–0070 through the migrator role, reconciled and verified role boundaries, then repeated migration/reconciliation/verification for a second release. The isolated legacy-row test also executes the corrected SQL with search_path restricted to pg_catalog. This replaces the missing restricted-role proof; it does not claim a full integration suite, a new full Vitest run, or a production deployment.

Awaiting the requested operator OK before committing and force-pushing with lease to PR #85.
