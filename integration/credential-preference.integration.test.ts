import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { clearOtherCredentialPreferences } from "@/lib/ai/credential-preference";
import { db, pool } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

const USER = "credential-preference-proof";
const OTHER = "credential-preference-other";
const NIM = "72000000-0000-4000-8000-000000000001";
const GOOGLE = "72000000-0000-4000-8000-000000000002";

beforeEach(async () => {
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Credential preference tests require the disposable integration database.");
  }
  await pool.query('delete from provider_credential where user_id in ($1,$2)', [USER, OTHER]);
  await pool.query('delete from "user" where id in ($1,$2)', [USER, OTHER]);
  for (const id of [USER, OTHER]) {
    await pool.query(`insert into "user" (id,public_id,name,email) values ($1,$2,'Synthetic learner',$3)`, [id, randomUUID(), `${id}@integration.invalid`]);
  }
  await pool.query(`insert into provider_credential
    (id,user_id,provider,label,ciphertext,wrapped_data_key,wrap_iv,data_iv,auth_tag,last_four,status,is_preferred)
    values ($1,$3,'nvidia_nim','NIM','cipher','wrapped','wrap','data','tag','1234','pending_validation',true),
           ($2,$3,'google','Gemini','cipher','wrapped','wrap','data','tag','5678','pending_validation',false)`, [NIM, GOOGLE, USER]);
});

afterAll(async () => { await pool.end(); });

async function prefer(id: string) {
  return db.transaction(async (tx) => {
    await lockUserAuthority(tx, USER);
    await clearOtherCredentialPreferences(tx, USER, id);
    await tx.update(providerCredential).set({ isPreferred: true }).where(and(eq(providerCredential.id, id), eq(providerCredential.userId, USER)));
  });
}

describe("one preferred credential per user in real PostgreSQL", () => {
  it("switches preference across providers without touching encrypted material or pending status", async () => {
    await prefer(GOOGLE);
    const rows = (await pool.query('select id,is_preferred,status,ciphertext from provider_credential where user_id=$1 order by id', [USER])).rows;
    expect(rows).toEqual([
      { id: NIM, is_preferred: false, status: "pending_validation", ciphertext: "cipher" },
      { id: GOOGLE, is_preferred: true, status: "pending_validation", ciphertext: "cipher" },
    ]);
  });

  it("serializes concurrent preference changes across providers", async () => {
    await Promise.all([prefer(GOOGLE), prefer(NIM), prefer(GOOGLE)]);
    const result = await pool.query('select count(*)::int as count from provider_credential where user_id=$1 and is_preferred', [USER]);
    expect(result.rows[0].count).toBe(1);
  });

  it("serializes concurrent preferred additions with preference changes", async () => {
    const add = (provider: "google" | "nvidia_nim") => db.transaction(async (tx) => {
      const id = randomUUID();
      await lockUserAuthority(tx, USER);
      await clearOtherCredentialPreferences(tx, USER, id);
      await tx.insert(providerCredential).values({ id, userId: USER, provider, label: "New key", ciphertext: "cipher", wrappedDataKey: "wrapped", wrapIv: "wrap", dataIv: "data", authTag: "tag", lastFour: "abcd", status: "unreachable", isPreferred: true });
    });
    await Promise.all([add("google"), add("nvidia_nim"), prefer(GOOGLE)]);
    expect((await pool.query('select count(*)::int as count from provider_credential where user_id=$1 and is_preferred', [USER])).rows[0].count).toBe(1);
  });

  it("rejects a duplicate preference at the database boundary", async () => {
    await expect(pool.query('update provider_credential set is_preferred=true where id=$1', [GOOGLE])).rejects.toMatchObject({ code: "23505", constraint: "credential_one_preferred_per_user_idx" });
  });

  it("rolls back the previous preference when the new mutation fails", async () => {
    await expect(db.transaction(async (tx) => {
      await lockUserAuthority(tx, USER);
      await clearOtherCredentialPreferences(tx, USER, GOOGLE);
      throw new Error("synthetic mutation failure");
    })).rejects.toThrow("synthetic mutation failure");
    expect((await pool.query('select is_preferred from provider_credential where id=$1', [NIM])).rows[0].is_preferred).toBe(true);
  });

  it("allows independent learners to each prefer one key", async () => {
    await pool.query(`insert into provider_credential
      (id,user_id,provider,label,ciphertext,wrapped_data_key,wrap_iv,data_iv,auth_tag,last_four,status,is_preferred)
      values ($1,$2,'google','Other key','cipher','wrapped','wrap','data','tag','1234','unreachable',true)`, [randomUUID(), OTHER]);
    await prefer(GOOGLE);
    expect((await pool.query('select count(*)::int as count from provider_credential where is_preferred and user_id in ($1,$2)', [USER, OTHER])).rows[0].count).toBe(2);
  });
});
