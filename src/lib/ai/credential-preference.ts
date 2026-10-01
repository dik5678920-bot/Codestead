import { and, eq, ne, sql } from "drizzle-orm";

import type { db } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";

type PreferenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Caller holds the per-user authority lock in the same transaction as the
 * preferred insertion/update. The partial unique index is the final guard. */
export async function clearOtherCredentialPreferences(
  tx: PreferenceTransaction,
  userId: string,
  credentialId: string,
) {
  await tx.update(providerCredential).set({
    isPreferred: false,
    updatedAt: sql`greatest(clock_timestamp(), ${providerCredential.updatedAt} + interval '1 microsecond')`,
  }).where(and(
    eq(providerCredential.userId, userId),
    eq(providerCredential.isPreferred, true),
    ne(providerCredential.id, credentialId),
  ));
}
