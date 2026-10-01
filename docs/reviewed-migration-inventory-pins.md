# Reviewed migration pins: 0070 and the next migration

PR #85 adds `0070_credential_validation_preference`. Its first CI run exposed
reviewed-current pins outside the migration ledger. This inventory records the
contracts advanced for 0070 and is the checklist for agent1's 0071 work.

The historical introduction is `d4bc135` (0069 mail authority), completed by
`7eeafd7` and `c5a9c6a`. Commit `894f1ee` subsequently introduced the closed-world
database capability inventory at 0069, physical column manifest, runtime
adapters, and operations-image bindings. Those newer contracts also need to
track the reviewed migration tail.

| Pin / consumer | 0069 | 0070 |
| --- | --- | --- |
| Journal and reviewed ledger | 70 entries, index 69 | 71 entries, index 70 |
| Reviewed tail | `0069_mail_outbox_guarded_delivery_authority` | `0070_credential_validation_preference` |
| Ledger digest | `20b480c7dd694d6e8e243704f14aeb05aa42fda4c5b7e863f6c357bf095a2551` | `8baecb4eedbb6f55a41b685438f9329197431d72580645c8c01a6017d7cfeeb6` |
| Capability journal-tag digest | `4b3163fd24c181107a891b42de1095f5137b366f8fb5429a2845753146adba08` | `f29657c9a020854098688b3c9edab9c018b3ac51066f844bd06198d69eca84a2` |
| Capability snapshot input | `drizzle/meta/0069_snapshot.json` | `drizzle/meta/0070_snapshot.json` |
| Physical column artifact | `drizzle/meta/0069_public_column_attnums.json` | `drizzle/meta/0070_public_column_attnums.json` |
| Physical manifest semantic digest | `b64e0934d046eb1cc4b1609ffbaf309cccdc2fa12fd4154ace19c9f63a0859af` | `4b9871085224de975a34cee6201687ce9a5d25b4d9cf7cbbad4c68caf06bff3b` |
| Available capability phase/export | `CURRENT_0069`, `0069-current`, `CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES` | `CURRENT_0070`, `0070-current`, `CURRENT_0070_DATABASE_RUNTIME_CAPABILITIES` |
| Capability contract/required migration | `codestead-database-runtime-capabilities-0069-current-v1`, 0069 SQL | `codestead-database-runtime-capabilities-0070-current-v1`, 0070 SQL |
| Enum label count | 78 | 79 (`credential_status.unreachable` added) |
| Enum fingerprint | `38eaed74f67a47298214fb8995b4fea131fd4ec794897ed724da11ffeaf21eb7` | `bd8a502fb97c9b362316bb48f88d150a2e15090ba4cbe27db46e643a54ff7c00` |
| Runtime adapters, fixtures, declarations, independent digest tests | 0069 current contract | 0070 current contract and recomputed policy/type fingerprints |
| Restore verifier and decoy-module contract test | count 70 / index 69 / 0069 tail | count 71 / index 70 / 0070 tail |
| Operations Dockerfile metadata copies | 0069 snapshot and attnums | 0070 snapshot and attnums |
| Static image and ledger-registration assertions | 0069 metadata | 0070 metadata |
| Historical guarded-delivery journal assertions | 0069 required last | exact entries 68 and 69 required present; later reviewed entries allowed |
| Backup/restore report projections (already in first fix) | count/tail/index/digest through 0069 | count/tail/index/digest through 0070 |

`node scripts/sync-reviewed-database-inventory.mjs --apply` advances the current
runtime inventory, metadata copies, adapter references, independent digest
tests, and restore contract from the reviewed ledger. Follow it with `--check`.
The script verifies the reviewed SQL/journal before applying anything and only
carries forward the independently reviewed 0069 physical column positions for
an enum/index extension with an identical column inventory. It refuses column
or routine migrations; 0071 changes of that kind need independent catalog replay
and review, not an invented attnum manifest or a blind hash refresh.

For an operator-reviewed correction to the latest SQL migration, first run
`node scripts/sync-reviewed-migration-hashes.mjs --apply`, then the inventory
apply/check commands. The hash tool uses the ledger's canonical digest function,
updates the latest SQL hash and backup/restore digest projections, and refuses
changes to historical migrations. Review the SQL correction before rebinding it.
Historical source bindings are anchored at each record's `sourceCommit`;
`npm run evidence:verify` checks the recorded Git blobs. Re-pinning current
source without rerunning the historical checks does not extend their proof.
Evidence conversions and immutable-artifact changes require operator approval.

For the next migration, also advance the Drizzle snapshot/journal, reviewed SQL
hash and ledger digest, `scripts/backup/common.sh`, and the backup/restore test
projections. The latter updates were already in PR #85 before this CI repair.
Refresh evidence bindings using each owning apply tool where one exists, list
all old→new values, and obtain the operator's approval before committing them.

The concrete consumer checklist is:

- `scripts/database-runtime-capabilities.mjs`, its `.d.mts` declaration, and
  `scripts/database-runtime-capabilities.test.mjs`: current phase, inventory,
  provenance, tail/file identity, journal/count/enum pins, and type fingerprints.
- `scripts/bootstrap-database-runtime-capabilities.mjs` and its tests,
  `scripts/verify-database-runtime-capabilities.mjs` and its tests,
  `scripts/lib/database-runtime-capability-test-fixture.mjs`, and
  `scripts/__tests__/backup-reporter-role-contract.test.ts`: current policy
  imports, phase references, and full policy fingerprints.
- `scripts/verify-restored-backup.ts`, `scripts/verify-restored-backup.test.ts`,
  `scripts/verify-restored-backup-authority.test.ts`, and
  `scripts/backup/restore-drill-isolated.sh`: exact restored ledger identity,
  count, decoy-module assertions, and diagnostic copy.
- `Dockerfile`, `infra/tests/database-least-privilege-static.test.mjs`,
  `infra/tests/validate-static.mjs`, and
  `infra/tests/reviewed-migration-ledger-registration.test.mjs`: operations image
  metadata and current runtime imports.
- `src/lib/notifications/__tests__/outbox-guarded-delivery-authority-0069.test.ts`
  and `infra/tests/mail-guarded-delivery-0069-registration.test.mjs`: historical
  presence assertions, not a requirement that 0069 remain last.
- `drizzle/meta/_journal.json`, the next snapshot, and
  `scripts/lib/reviewed-migration-ledger.mjs`: SQL hash, exact entry timestamp,
  count, tail, and full ledger digest. Their contract tests advance together.
- `scripts/backup/common.sh`, `infra/tests/backup-ci-registration.test.mjs`,
  `infra/tests/backup-production-e2e.test.sh`,
  `infra/tests/recovery-evidence-verifier.test.sh`, and
  `infra/tests/restore-drill-reminder.test.sh`: report count/index/tag/digest
  projections. These were already advanced by the initial 0070 fix.

The 0069 mail routines, trigger definitions, rollback capability, historical
snapshot lineage, and unavailable identity-split capability placeholders are
historical feature contracts. 0070 adds no new mail or identity authority; those
contracts retain their own migration identity. The existing unavailable
`0070-expand-prepare` / `0071-contracted` placeholders describe a separate
unimplemented identity-split proposal and do not authorize either feature.

Required local gates after advancing these pins:

```sh
npm run test:database-role-boundaries
node --test infra/tests/database-least-privilege-static.test.mjs
npx vitest run scripts/ src/lib/notifications/ --maxWorkers=2
node scripts/sync-reviewed-database-inventory.mjs --check
npm run test:migration-ledger
npm run typecheck
npm run lint
npm run evidence:verify
```
