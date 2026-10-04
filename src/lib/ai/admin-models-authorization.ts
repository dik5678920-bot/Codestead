import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { isFreshMfa, ADMIN_STEP_UP_MFA_MS } from "@/lib/security/privileged-access";
export async function adminModelMfaIsFresh(userId: string, sessionId: string) {
  const [bound] = await db.select({ mfaVerifiedAt: session.mfaVerifiedAt }).from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId))).limit(1);
  return isFreshMfa(bound?.mfaVerifiedAt, new Date(), ADMIN_STEP_UP_MFA_MS);
}
