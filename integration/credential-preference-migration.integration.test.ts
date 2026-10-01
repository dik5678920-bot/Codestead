import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

let pool: Pool | undefined;

afterAll(async () => { await pool?.end(); });

describe("credential preference migration on legacy rows", () => {
  it("repairs duplicate preferences deterministically without changing stored keys or validation outcomes", async () => {
    const ownerUrl = process.env.DATABASE_OWNER_URL;
    if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(ownerUrl ?? "")) {
      throw new Error("Migration proof requires the disposable integration database.");
    }
    pool = new Pool({ connectionString: ownerUrl, max: 1 });
    const schema = `credential_proof_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
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
      const sql = (await readFile("drizzle/0070_credential_validation_preference.sql", "utf8")).replaceAll('"public".', `"${schema}".`);
      await client.query('begin');
      await client.query('set local search_path to pg_catalog');
      await client.query(sql);
      await client.query('commit');
      expect((await client.query('select id,status,ciphertext from provider_credential order by id')).rows).toEqual(before);
      const preferred = (await client.query('select id from provider_credential where is_preferred order by id')).rows;
      expect(preferred.map((row) => row.id)).toEqual([
        "73000000-0000-4000-8000-000000000003",
        "73000000-0000-4000-8000-000000000004",
      ]);
      await expect(client.query('update provider_credential set is_preferred=true where id=$1', [before[0].id])).rejects.toMatchObject({ code: "23505" });
      await client.query("update provider_credential set status='unreachable' where id=$1", [before[0].id]);
    } finally {
      await client.query('rollback');
      await client.query('set search_path to public');
      await client.query(`drop schema if exists ${schema} cascade`);
      client.release();
    }
  });
});
