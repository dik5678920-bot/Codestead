import { passkey as betterAuthPasskey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { passkey, session } from "@/lib/db/schema";
import { readEnabledPasskey } from "./passkeys";
import { writeAuditEvent, writeAuditEventInTransaction } from "./audit-writer";
import { withRateLimit } from "./rate-limit";

const verifiedAssertions = new WeakMap<object, { userId: string; passkeyId: string }>();

export function createPasskeyPlugin() {
  const url = new URL(process.env.APP_URL ?? "http://localhost:3000");
  return betterAuthPasskey({ rpID: url.hostname, origin: url.origin,
    rpName: process.env.APP_NAME ?? "Codestead",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    registration: { requireSession: true, afterVerification: async ({ verification, user }) => {
      if (!verification.registrationInfo?.userVerified) throw new APIError("FORBIDDEN", { message: "User verification is required." });
      await writeAuditEvent({ actorUserId: user.id, action: "passkey.add", resourceType: "passkey", outcome: "allowed" });
    } },
    authentication: { afterVerification: async ({ ctx, verification, clientData }) => {
      if (!verification.authenticationInfo.userVerified) throw new APIError("FORBIDDEN", { message: "User verification is required." });
      const record = await readEnabledPasskey(clientData.id);
      if (!record) throw new APIError("UNAUTHORIZED", { message: "Passkey is unavailable." });
      const admission = await withRateLimit({ policy: "passkey_login_user", identity: { kind: "user", value: record.account.id } }, async () => new Response(null, { status: 204 }));
      if (admission.status !== 204) throw new APIError(admission.status === 429 ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE", { message: "Passkey sign-in is unavailable. Try again later." });
      await writeAuditEvent({ actorUserId: record.account.id, action: "passkey.use", resourceType: "passkey", resourceId: record.credential.id, outcome: "allowed", metadata: { purpose: "sign_in", userVerified: true } });
      verifiedAssertions.set(ctx.context, { userId: record.account.id, passkeyId: record.credential.id });
    } },
  });
}

export async function completePasskeyCeremony(ctx: GenericEndpointContext) {
  if (ctx.path === "/passkey/verify-authentication") {
    const verified = verifiedAssertions.get(ctx.context);
    verifiedAssertions.delete(ctx.context);
    const created = ctx.context.newSession;
    if (!verified || !created || created.user.id !== verified.userId) return;
    await db.transaction(async (tx) => {
      const [credential] = await tx.select({ id: passkey.id }).from(passkey)
        .where(and(eq(passkey.id, verified.passkeyId), eq(passkey.userId, verified.userId), isNull(passkey.disabledAt))).for("update");
      if (!credential) throw new APIError("UNAUTHORIZED", { message: "Passkey is unavailable." });
      const [stamped] = await tx.update(session).set({ mfaVerifiedAt: new Date() })
        .where(and(eq(session.id, created.session.id), eq(session.userId, verified.userId))).returning({ id: session.id });
      if (!stamped) throw new APIError("UNAUTHORIZED", { message: "Session is unavailable." });
      await writeAuditEventInTransaction(tx, { actorUserId: verified.userId, action: "passkey.use", resourceType: "passkey", resourceId: verified.passkeyId, outcome: "success", metadata: { purpose: "sign_in", userVerified: true } });
    });
  }
  if (ctx.path === "/passkey/verify-registration" && ctx.context.session) {
    const credentialId = ctx.body?.response?.id;
    if (typeof credentialId !== "string") return;
    const [created] = await db.select({ id: passkey.id }).from(passkey)
      .where(and(eq(passkey.credentialID, credentialId), eq(passkey.userId, ctx.context.session.user.id))).limit(1);
    if (created) await writeAuditEvent({ actorUserId: ctx.context.session.user.id, action: "passkey.add", resourceType: "passkey", resourceId: created.id, outcome: "success" });
  }
}
