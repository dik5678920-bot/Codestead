import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ assertion: vi.fn(), authorization: vi.fn() }));
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: async () => ({ challenge: "register", rp: { name: "Codestead", id: "localhost" }, user: { id: "handle", name: "Owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] }),
  generateAuthenticationOptions: async () => ({ challenge: "assert", rpId: "localhost" }),
  verifyRegistrationResponse: async () => ({ verified: true, registrationInfo: { userVerified: true, credential: { id: "fixture-credential", publicKey: new Uint8Array([1, 2, 3]), counter: 0 }, aaguid: "", credentialDeviceType: "singleDevice", credentialBackedUp: false } }),
  verifyAuthenticationResponse: mocks.assertion,
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.authorization }));

import { db, pool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { createPasskeyPlugin, completePasskeyCeremony } from "@/lib/security/passkey-plugin";
import { passkeyStepUpOptions, verifyPasskeyStepUp } from "@/lib/security/passkeys";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { DELETE } from "@/app/api/security/passkeys/[id]/route";
import { validatedDisposableOwnerDatabaseTarget } from "../scripts/lib/disposable-integration-environment";

describe("passkey PostgreSQL ceremonies, ownership, freshness and audit", () => {
  let ownerPool: Pool;
  let provisional = false;
  beforeAll(async () => {
    const target = validatedDisposableOwnerDatabaseTarget(process.env);
    ownerPool = new Pool({ connectionString: target.databaseOwnerUrl, max: 1 });
    const existing = await ownerPool.query("SELECT to_regclass('public.passkey') AS relation");
    if (!existing.rows[0].relation) {
      // Reserved 0075 is replayed provisionally after 0073 until 0074 lands.
      // Do not register a skipped ledger entry or bless provisional hashes.
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        const migration = await readFile("drizzle/0075_passkeys.sql", "utf8");
        for (const sql of migration.split("--> statement-breakpoint")) if (sql.trim()) await client.query(sql);
        await client.query("COMMIT");
        provisional = true;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  });
  afterAll(async () => {
    if (provisional) await ownerPool.query('DROP TABLE "public"."passkey"');
    await ownerPool?.end();
    await pool.end();
  });

  it("registers/signs in, stamps UV MFA, rejects cross-user/deactivated keys, and deletes only with fresh MFA", async () => {
    const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
    const auth = betterAuth({ baseURL: origin, secret: process.env.BETTER_AUTH_SECRET!, database: drizzleAdapter(db, { provider: "pg", schema }),
      emailAndPassword: { enabled: true }, advanced: { database: { generateId: () => randomUUID() } },
      plugins: [createPasskeyPlugin()], hooks: { after: createAuthMiddleware(completePasskeyCeremony) }, rateLimit: { enabled: false } });
    const cookie = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const signup = await auth.api.signUpEmail({ body: { email: `${randomUUID()}@passkeys.integration.invalid`, name: "Passkey Owner", password: "integration-test-password" }, asResponse: true });
    expect(signup.status).toBe(200);
    const account = (await signup.json()).user;
    await db.update(schema.user).set({ status: "active", emailVerified: true, twoFactorEnabled: true, mustChangePassword: false, role: "admin" }).where(eq(schema.user.id, account.id));
    const options = await auth.api.generatePasskeyRegistrationOptions({ headers: { cookie: cookie(signup), origin }, asResponse: true });
    const registered = await auth.api.verifyPasskeyRegistration({ headers: { cookie: cookie(signup) + "; " + cookie(options), origin }, body: { response: { id: "fixture-credential", response: { transports: [] } }, name: "Laptop" }, asResponse: true });
    expect(registered.status).toBe(200);
    const [key] = await db.select().from(schema.passkey).where(eq(schema.passkey.userId, account.id));
    expect(key.name).toBe("Laptop");
    await auth.api.signOut({ headers: { cookie: cookie(signup), origin } });
    const assertion = { id: key.credentialID, rawId: key.credentialID, type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: "mock", authenticatorData: "mock", signature: "mock" } };
    mocks.assertion.mockResolvedValue({ verified: true, authenticationInfo: { userVerified: true, newCounter: 1 } });
    const authenticateOptions = await auth.api.generatePasskeyAuthenticationOptions({ asResponse: true });
    const signedIn = await auth.api.verifyPasskeyAuthentication({ headers: { cookie: cookie(authenticateOptions), origin }, body: { response: assertion }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const [current] = await db.select().from(schema.session).where(eq(schema.session.userId, account.id));
    expect(current.mfaVerifiedAt).toBeInstanceOf(Date);
    const stepUp = await passkeyStepUpOptions(account.id, current.id);
    const fresh = await verifyPasskeyStepUp(account.id, current.id, stepUp.id, assertion);
    expect(fresh).toBeInstanceOf(Date);
    expect(authorizePrivilegedAction({ actorRole: "admin", mfaVerifiedAt: fresh, reason: "Confirm reviewed credential operation", action: "credential.reveal" }).allowed).toBe(true);
    await expect(verifyPasskeyStepUp(account.id, current.id, stepUp.id, assertion)).rejects.toThrow("Challenge expired or already used");
    const crossUser = await passkeyStepUpOptions(account.id, current.id);
    await expect(verifyPasskeyStepUp("other-user", current.id, crossUser.id, assertion)).rejects.toThrow("Challenge does not belong");
    const withoutUv = await passkeyStepUpOptions(account.id, current.id);
    mocks.assertion.mockResolvedValueOnce({ verified: true, authenticationInfo: { userVerified: false, newCounter: 2 } });
    await expect(verifyPasskeyStepUp(account.id, current.id, withoutUv.id, assertion)).rejects.toThrow("User verification is required");
    mocks.authorization.mockResolvedValue({ session: { user: { id: "other-user" }, session: { id: "other-session" } } });
    const request = () => new NextRequest(`${origin}/api/security/passkeys/${key.id}`, { method: "DELETE" });
    const context = { params: Promise.resolve({ id: key.id }) };
    expect((await DELETE(request(), context)).status).toBe(404);
    mocks.authorization.mockResolvedValue({ session: { user: { id: account.id }, session: { id: current.id } } });
    await db.update(schema.session).set({ mfaVerifiedAt: new Date(Date.now() - 301_000) }).where(eq(schema.session.id, current.id));
    expect((await DELETE(request(), context)).status).toBe(403);
    await ownerPool.query('UPDATE "public"."passkey" SET "disabled_at" = now() WHERE "id" = $1', [key.id]);
    await db.delete(schema.session).where(eq(schema.session.id, current.id));
    const disabledOptions = await auth.api.generatePasskeyAuthenticationOptions({ asResponse: true });
    expect((await auth.api.verifyPasskeyAuthentication({ headers: { cookie: cookie(disabledOptions), origin }, body: { response: assertion }, asResponse: true })).status).toBe(401);
    await ownerPool.query('UPDATE "public"."passkey" SET "disabled_at" = NULL WHERE "id" = $1', [key.id]);
    await db.insert(schema.session).values({ id: current.id, token: randomUUID(), userId: account.id, expiresAt: new Date(Date.now() + 3600_000), mfaVerifiedAt: new Date() });
    expect((await DELETE(request(), context)).status).toBe(200);
    expect(await db.select().from(schema.passkey).where(eq(schema.passkey.id, key.id))).toHaveLength(0);
    const events = await db.select({ action: schema.auditEvent.action }).from(schema.auditEvent).where(and(eq(schema.auditEvent.actorUserId, account.id), eq(schema.auditEvent.outcome, "success")));
    expect(events.map(({ action }) => action)).toEqual(expect.arrayContaining(["passkey.add", "passkey.use", "passkey.remove"]));
    const attnums = await ownerPool.query("SELECT attname, attnum FROM pg_attribute WHERE attrelid = 'public.passkey'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum");
    await writeFile(process.env.PASSKEY_REPLAY_REPORT ?? "test-results/passkeys-replay.json", JSON.stringify(attnums.rows, null, 2) + "\n");
    const privileges = await ownerPool.query("SELECT has_table_privilege('learncoding_app','public.passkey','SELECT') AS read, has_table_privilege('learncoding_app','public.passkey','INSERT') AS insert, has_table_privilege('learncoding_app','public.passkey','DELETE') AS delete, has_column_privilege('learncoding_app','public.passkey','counter','UPDATE') AS counter, has_column_privilege('learncoding_app','public.passkey','public_key','UPDATE') AS key, has_table_privilege('learncoding_worker','public.passkey','SELECT') AS worker");
    expect(privileges.rows[0]).toEqual({ read: true, insert: true, delete: true, counter: true, key: false, worker: false });
  });
});
