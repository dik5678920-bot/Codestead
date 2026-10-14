import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { db } from "@/lib/db/client";
import { passkey, session, user, verification } from "@/lib/db/schema";
import { writeAuditEventInTransaction } from "./audit-writer";

export function passkeyRelyingParty() {
  const url = new URL(process.env.APP_URL ?? "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Passkeys require an HTTPS application URL.");
  return { rpID: url.hostname, origin: url.origin };
}

export async function readEnabledPasskey(credentialID: string) {
  const [record] = await db.select({ credential: passkey, account: user }).from(passkey)
    .innerJoin(user, eq(user.id, passkey.userId))
    .where(and(eq(passkey.credentialID, credentialID), isNull(passkey.disabledAt))).limit(1);
  if (!record || record.account.status !== "active" || !record.account.emailVerified || !record.account.twoFactorEnabled || record.account.banned || record.account.mustChangePassword) return null;
  return record;
}

export async function passkeyStepUpOptions(userId: string, sessionId: string) {
  const credentials = await db.select({ credentialID: passkey.credentialID }).from(passkey)
    .where(and(eq(passkey.userId, userId), isNull(passkey.disabledAt)));
  if (!credentials.length) throw new Error("No enabled passkey is available.");
  const options = await generateAuthenticationOptions({ rpID: passkeyRelyingParty().rpID,
    userVerification: "required", allowCredentials: credentials.map(({ credentialID }) => ({ id: credentialID })) });
  const id = randomUUID();
  await db.insert(verification).values({ id, identifier: `passkey-step-up:${id}`,
    value: JSON.stringify({ userId, sessionId, challenge: options.challenge }), expiresAt: new Date(Date.now() + 5 * 60_000) });
  return { id, options };
}

export async function verifyPasskeyStepUp(userId: string, sessionId: string, id: string, response: Parameters<typeof verifyAuthenticationResponse>[0]["response"]) {
  // Consume before verification, including failures. Bind challenges to both the
  // durable user and current session; a login assertion cannot be used here.
  const [challenge] = await db.delete(verification).where(and(eq(verification.identifier, `passkey-step-up:${id}`), gt(verification.expiresAt, new Date())))
    .returning({ value: verification.value });
  if (!challenge) throw new Error("Challenge expired or already used.");
  const binding = JSON.parse(challenge.value) as { userId: string; sessionId: string; challenge: string };
  if (binding.userId !== userId || binding.sessionId !== sessionId) throw new Error("Challenge does not belong to this session.");
  return db.transaction(async (tx) => {
    const [credential] = await tx.select().from(passkey).where(and(eq(passkey.credentialID, response.id), eq(passkey.userId, userId), isNull(passkey.disabledAt))).for("update");
    if (!credential) throw new Error("Passkey is unavailable.");
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: binding.challenge,
      expectedOrigin: passkeyRelyingParty().origin, expectedRPID: passkeyRelyingParty().rpID, requireUserVerification: true,
      credential: { id: credential.credentialID, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64")), counter: credential.counter } });
    if (!result.verified || !result.authenticationInfo.userVerified) throw new Error("User verification is required.");
    const now = new Date();
    const [stamped] = await tx.update(session).set({ mfaVerifiedAt: now })
      .where(and(eq(session.id, sessionId), eq(session.userId, userId), isNull(session.revokedAt), gt(session.expiresAt, now))).returning({ id: session.id });
    if (!stamped) throw new Error("Session is no longer active.");
    await tx.update(passkey).set({ counter: result.authenticationInfo.newCounter }).where(eq(passkey.id, credential.id));
    await writeAuditEventInTransaction(tx, { actorUserId: userId, action: "passkey.use", resourceType: "passkey", resourceId: credential.id, outcome: "success", metadata: { purpose: "step_up", userVerified: true } });
    return now;
  });
}
