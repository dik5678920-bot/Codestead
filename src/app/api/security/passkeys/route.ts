import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { passkey } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit({ policy: "passkey_list_user", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const records = await db.select({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt }).from(passkey)
      .where(and(eq(passkey.userId, authz.session.user.id), isNull(passkey.disabledAt)));
    return NextResponse.json({ passkeys: records }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
