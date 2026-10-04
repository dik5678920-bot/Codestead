import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db, pool } from "@/lib/db/client";
import { auditEvent, providerPolicy } from "@/lib/db/schema";
import { adminModelsStore } from "@/lib/ai/admin-models-store";
import { sealCredential } from "@/lib/security/credential-vault";
import { platformVaultOwner } from "@/lib/ai/admin-models-service";
import * as auditWriter from "@/lib/security/audit-writer";
const provider = "custom_openai_compatible" as const;
const actor = `admin-models-${randomUUID()}`;
const master = Buffer.alloc(32, 7);
beforeAll(async () => {
 if (process.env.INTEGRATION_TEST !== "1" || new URL(process.env.DATABASE_URL ?? "").hostname !== "127.0.0.1" || new URL(process.env.DATABASE_URL ?? "").pathname !== "/learncoding_integration") throw new Error("Disposable integration harness required.");
 await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [actor,"Admin models integration",`${actor}@example.invalid`]);
});
beforeEach(async () => { vi.restoreAllMocks(); await db.delete(providerPolicy).where(eq(providerPolicy.provider,provider)); });
afterAll(async () => { vi.restoreAllMocks(); await db.delete(providerPolicy).where(eq(providerPolicy.provider,provider)); await pool.end(); });
async function configure(version = 0) {
 const id = (await adminModelsStore.connection(provider))?.id ?? randomUUID();
 const envelope = sealCredential("integration-platform-key", { userId: platformVaultOwner, credentialId: id, provider, keyVersion: 1 },master);
 await adminModelsStore.configure(actor,{ id,provider,baseUrl:"https://gateway.example.com/v1",platformCredential:envelope,version });
 return envelope;
}
it("stores an encrypted connection separately and publishes one shared model for tutoring and validation",async () => {
 const envelope = await configure();
 await adminModelsStore.save(actor,{ provider,model:"vendor/model",priority:2,baseUrl:"https://gateway.example.com/v1",version:1,verified:true,reportedModel:"vendor/resolved" });
 const rows = await db.select().from(providerPolicy).where(eq(providerPolicy.provider,provider));
 const connection = rows.find(row => row.operation === "provider_configuration")!;
 expect(connection.platformCredential).toEqual(envelope); expect(connection.configurationVersion).toBe(1);
 const serving = rows.filter(row => row.operation !== "provider_configuration");
 expect(serving).toHaveLength(2);
 for (const row of serving) { expect(row).toMatchObject({ model:"vendor/model",priority:2,enabled:true,platformCredential:null,verificationStatus:"verified",verifiedReportedModel:"vendor/resolved" }); expect(row.verifiedAt).toBeInstanceOf(Date); }
 const events = await db.select().from(auditEvent).where(eq(auditEvent.actorUserId,actor));
 expect(events.map(event => event.action)).toContain("ai_models.configure"); expect(events.map(event => event.action)).toContain("ai_models.save");
 expect(JSON.stringify(events)).not.toContain("integration-platform-key"); expect(JSON.stringify(events)).not.toContain(envelope.ciphertext);
});
it("changes a default atomically, disables older models and invalidates verification when the connection changes",async () => {
 await configure();
 await adminModelsStore.save(actor,{ provider,model:"old-model",priority:9,baseUrl:"https://gateway.example.com/v1",version:1,verified:true });
 await adminModelsStore.save(actor,{ provider,model:"new-model",priority:1,baseUrl:"https://gateway.example.com/v1",version:1,verified:false });
 let rows = await db.select().from(providerPolicy).where(and(eq(providerPolicy.provider,provider),inArray(providerPolicy.operation,["tutor","credential_validation"])));
 expect(rows.filter(row => row.enabled).map(row => row.model)).toEqual(["new-model","new-model"]);
 await configure(1);
 rows = await db.select().from(providerPolicy).where(and(eq(providerPolicy.provider,provider),inArray(providerPolicy.operation,["tutor","credential_validation"])));
 for (const row of rows) expect(row).toMatchObject({ verificationStatus:"untested",verifiedAt:null,verifiedReportedModel:null,configurationVersion:2 });
});
it("serializes concurrent connection edits and rejects the stale writer",async () => {
 const result = await Promise.allSettled([configure(),configure()]);
 expect(result.filter(result => result.status === "fulfilled")).toHaveLength(1);
 expect(result.filter(result => result.status === "rejected")[0]).toMatchObject({ reason:{ code:"POLICY",status:409 } });
 expect((await adminModelsStore.connection(provider))?.configurationVersion).toBe(1);
});
it("rolls back policy changes if their audit append fails",async () => {
 await configure();
 vi.spyOn(auditWriter,"writeAuditEventInTransaction").mockRejectedValueOnce(new Error("synthetic audit failure"));
 await expect(adminModelsStore.save(actor,{ provider,model:"must-rollback",priority:1,baseUrl:"https://gateway.example.com/v1",version:1,verified:false })).rejects.toThrow();
 expect((await adminModelsStore.list()).filter(row => row.provider === provider && row.operation === "tutor")).toEqual([]);
});
it("database constraints forbid plaintext serving-row envelopes, unsafe URLs and forged verification state",async () => {
 for (const change of [{ operation:"tutor",platformCredential:{ plaintext:"never" } },{ baseUrl:"http://private.example" },{ verificationStatus:"verified" },{ configurationVersion:-1 }]) {
  await expect(db.insert(providerPolicy).values({ provider,operation:"tutor",model:"constraint-fixture",priority:1,...change } as typeof providerPolicy.$inferInsert)).rejects.toMatchObject({ cause: { code: "23514" } });
 }
});


it("the physical PostgreSQL column order matches the reviewed 0072 attnum manifest",async () => {
 const manifest = JSON.parse(await readFile("drizzle/meta/0072_public_column_attnums.json","utf8"));
 const expected = manifest.tables.find((table: { identity:string }) => table.identity === "public.provider_policy").columns;
 const actual = await pool.query("SELECT attname AS name, attnum FROM pg_attribute WHERE attrelid='public.provider_policy'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum");
 expect(actual.rows).toEqual(expected.map((column: { name:string;attnum:number }) => ({ name:column.name,attnum:column.attnum })));
});
