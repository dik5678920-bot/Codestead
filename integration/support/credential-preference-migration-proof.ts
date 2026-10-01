import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// Called only inside the validated helper's identity-checked owner session.
export async function proveCredentialPreferenceMigration(client: PoolClient): Promise<void> {
    const schema = `credential_proof_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`create schema ${schema}; set search_path to ${schema}`);
      await client.query(`create type credential_status as enum ('pending_validation','active','invalid','rate_limited','disabled','revoked');
        create table provider_credential (id uuid primary key,user_id text not null,provider text not null,
          status credential_status not null,is_preferred boolean not null,ciphertext text not null,
          updated_at timestamptz not null,created_at timestamptz not null);
        insert into provider_credential values
          ('73000000-0000-4000-8000-000000000001','one','nvidia_nim','pending_validation',true,'unchanged-nim','2026-07-12','2026-07-12'),
          ('73000000-0000-4000-8000-000000000002','one','google','pending_validation',true,'unchanged-google','2026-07-13','2026-07-12'),
          ('73000000-0000-4000-8000-000000000003','one','openai','active',true,'unchanged-openai','2026-07-13','2026-07-12'),
          ('73000000-0000-4000-8000-000000000004','other','google','disabled',true,'unchanged-other','2026-07-12','2026-07-12');`);
      const before = (await client.query('select id,status,ciphertext from provider_credential order by id')).rows;
      const sql = (await readFile(new URL("../../drizzle/0070_credential_validation_preference.sql", import.meta.url), "utf8")).replaceAll('"public".', `"${schema}".`);
      await client.query('begin');
      await client.query('set local search_path to pg_catalog');
      await client.query(sql);
      await client.query('commit');
      assert.deepEqual((await client.query('select id,status,ciphertext from provider_credential order by id')).rows, before);
      const preferred = (await client.query('select id from provider_credential where is_preferred order by id')).rows;
      assert.deepEqual(preferred.map((row) => row.id), [
        "73000000-0000-4000-8000-000000000003",
        "73000000-0000-4000-8000-000000000004",
      ]);
      await assert.rejects(client.query('update provider_credential set is_preferred=true where id=$1', [before[0].id]), { code: "23505" });
      await client.query("update provider_credential set status='unreachable' where id=$1", [before[0].id]);
    } finally {
      await client.query('rollback');
      await client.query('set search_path to public');
      await client.query(`drop schema if exists ${schema} cascade`);
    }
}
