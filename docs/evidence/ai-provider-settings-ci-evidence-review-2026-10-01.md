# PR #85 CI pin repair: evidence approval

The initial evidence was approved and committed. This is the complete additional old→new inventory submitted before committing or pushing the CI repair.

| Evidence file | Binding | Old SHA-256 | New SHA-256 |
| --- | --- | --- | --- |
| docs/evidence/backup-status-outbox-2026-07-12.json | scripts/__tests__/backup-reporter-role-contract.test.ts | `1011a93b7e0c8b07492d445870de1eea07f41ee153d755cd9653720b9cb75cca` | `9c9dca0c0fb9929e3807a916276cdda09e7405b9e96c52a6c4f497fa80604e47` |
| docs/evidence/ai-provider-settings-2026-10-01.json | docs/evidence/backup-status-outbox-2026-07-12.json | `c7b65b5e3a32830a8978565131104b98a118f4e645a0c0db2f3112fdf765e840` | `244c228a0828dc613c25ac197a063f27996d1d13fd2caf0ab63f8c73ee5facfe` |
| docs/evidence/ai-provider-settings-2026-10-01.json | infra/tests/reviewed-migration-ledger-registration.test.mjs | `c1a2ab7c0e9d8e50fbc0e21d59bfad1b5d0033ee359438cff124816aa32b6aaf` | `ad39dd85c0e55dd04cbf0b219905c1eb3cc631d6cf1d1b6e21de1f88842eebec` |

Both existing JSON files add `ciPinFollowup` metadata: absent → date, limited source-binding scope, new review-record path, and the binding changes above. Original tests, results, dates, and previous evidence history are preserved.

New evidence record: `docs/evidence/ai-provider-settings-ci-pins-2026-10-01.json` (absent → 145 passing database-role tests in 10 lanes, 12 passing least-privilege static tests, 2078 passing Vitest tests / 10 skips / 0 failures across 169 files, generated pin inventory, explicit verification limits, and these artifact bindings).

| New evidence artifact binding | Old | New SHA-256 |
| --- | --- | --- |
| Dockerfile | absent | `891fb214ac486fb484ebcaae1587046e6a397e63a12e2d1b044734809b54ff79` |
| docs/evidence/ai-provider-settings-2026-10-01.json | absent | `c73995029ee42887538c985d863eb3ffc86b62a8d36aaf604a92e1374aefdb32` |
| docs/evidence/backup-status-outbox-2026-07-12.json | absent | `244c228a0828dc613c25ac197a063f27996d1d13fd2caf0ab63f8c73ee5facfe` |
| docs/reviewed-migration-inventory-pins.md | absent | `c0d99fe71aa793d292ef4dc05ab12a57d9338cb471c2500aaeb12831d2358f31` |
| drizzle/meta/0070_public_column_attnums.json | absent | `ccb570feacc782971c12564d4eaeec176a9b6cc4fd746cea21fd3d93d252e4c0` |
| infra/tests/database-least-privilege-static.test.mjs | absent | `b309b1692aa7c2e705db2f4c1c85e2423d00c795bb9292ff76e6ccfb6232513c` |
| infra/tests/mail-guarded-delivery-0069-registration.test.mjs | absent | `d85a864fa06e9405d61a0c1d56171043b2df0a3e3e7a94ea27fa9a3cdc0b5df5` |
| infra/tests/reviewed-migration-ledger-registration.test.mjs | absent | `ad39dd85c0e55dd04cbf0b219905c1eb3cc631d6cf1d1b6e21de1f88842eebec` |
| infra/tests/validate-static.mjs | absent | `692cb2215569c8d47116426ed2b7bee7bbf0940972554d1dbbb565970db691fa` |
| scripts/__tests__/backup-reporter-role-contract.test.ts | absent | `9c9dca0c0fb9929e3807a916276cdda09e7405b9e96c52a6c4f497fa80604e47` |
| scripts/backup/restore-drill-isolated.sh | absent | `82fab97f993001a43f47cff08b291857eac896390c760a5c2cfd4338f2d60013` |
| scripts/bootstrap-database-runtime-capabilities.mjs | absent | `a170e8a4a14ee4971972e7152b4be5755eb4209dbb575181a1eceff4cf279913` |
| scripts/bootstrap-database-runtime-capabilities.test.mjs | absent | `32573d89581f17ac661b0907ff75123c40f5140feafb0be08afc67bd891dcee0` |
| scripts/database-runtime-capabilities.d.mts | absent | `a71dd8a0fab60f27fa900311b41538a00486467e979c99fc2b19cb51312595ba` |
| scripts/database-runtime-capabilities.mjs | absent | `e2512d97a65cb36cb20eb7835172180659c73a5c46499cd78a78d66a7b10af28` |
| scripts/database-runtime-capabilities.test.mjs | absent | `499d4ca3af55ac6fe5045ddb6044df764eefc17a68c6a37cb834d313ff8415d0` |
| scripts/lib/database-runtime-capability-test-fixture.mjs | absent | `792d872f9d01207e8e8abc70c593ee6a5377dfab050964a224c37a15d1073cde` |
| scripts/sync-reviewed-database-inventory.mjs | absent | `deefd37b3c62fee9a880fd6e651f5762c197c7241e31305f65392a1ef1dfb0c0` |
| scripts/verify-database-runtime-capabilities.mjs | absent | `dbc8fd678bed502a33ee9bfb64b0ade2561f9393ba2d2edec3e5e9aef6b27c77` |
| scripts/verify-database-runtime-capabilities.test.mjs | absent | `e209271ad3c54fdae33410d6bf4609463a7318e1335a4a18af803ccf3483dfb9` |
| scripts/verify-restored-backup-authority.test.ts | absent | `01dbaa67c8c4e448fe7d377649c97ba099a04b4417b9b15d202719def26e5e8f` |
| scripts/verify-restored-backup.test.ts | absent | `62e954041712d4e4fa3ea018059f295401321a740b3320012b814e36c91d54ab` |
| scripts/verify-restored-backup.ts | absent | `fc4d276c4b289912df3755d88d8a4713977fc5e9fee5018b34124d64d3ffe154` |
| src/lib/notifications/__tests__/outbox-guarded-delivery-authority-0069.test.ts | absent | `4dace4685c4add222fc1760ce14fdc60b4bc5367452d565cc9a02a4048e933a7` |

New approval document: `docs/evidence/ai-provider-settings-ci-evidence-review-2026-10-01.md` (absent → this inventory). No historical PostgreSQL run, production topology run, full build, or deployment is claimed. The earlier migration SQL, journal, ledger identity, and initially approved nine evidence changes are unchanged.

The pin checklist for agent1 is [reviewed-migration-inventory-pins.md](../reviewed-migration-inventory-pins.md). After operator approval, commit the repair and evidence separately, push to PR #85, and stop.
