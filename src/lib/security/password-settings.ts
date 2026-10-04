import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { account, session } from "@/lib/db/schema";
import type { CurrentAuth } from "@/lib/http/authz";

export async function hasCredentialPassword(userId: string) {
  const [credential] = await db.select({ id: account.id }).from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password), ne(account.password, ""))).limit(1);
  return Boolean(credential);
}

// Better Auth rotates the current session when revokeOtherSessions is true.
// Retain only this request's approved-device/MFA authority on its replacement.
export async function preservePasswordChangeSession(current: CurrentAuth, token: string) {
  const prior = current.session as CurrentAuth["session"] & { mfaVerifiedAt?: Date | string | null; deviceHash?: string | null };
  const verifiedAt = prior.mfaVerifiedAt ? new Date(prior.mfaVerifiedAt) : null;
  if (!verifiedAt || !Number.isFinite(verifiedAt.getTime())) throw new Error("MFA-completed session required.");
  const [updated] = await db.update(session).set({ mfaVerifiedAt: verifiedAt, deviceHash: prior.deviceHash ?? null })
    .where(and(eq(session.userId, current.user.id), eq(session.token, token))).returning({ id: session.id });
  if (!updated) throw new Error("Replacement session is unavailable.");
}
