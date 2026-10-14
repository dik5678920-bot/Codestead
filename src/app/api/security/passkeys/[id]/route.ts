import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { passkey } from "@/lib/db/schema";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { requireAuth } from "@/lib/http/authz";
import { requireRecentMfa } from "@/lib/security/recent-mfa";
import { withRateLimit } from "@/lib/security/rate-limit";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "private, no-store" };
const nameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

async function mutate(request: NextRequest, context: Context, remove: boolean, input: { userId: string; sessionId: string }) {
  const { id } = await context.params;
  const { userId, sessionId } = input;
  return withRateLimit({ policy: "passkey_manage_user", identity: { kind: "user", value: userId } }, async () => {
    const [owned] = await db.select({ id: passkey.id }).from(passkey)
      .where(and(eq(passkey.id, id), eq(passkey.userId, userId), isNull(passkey.disabledAt))).limit(1);
    if (!owned) return NextResponse.json({ error: "Passkey not found." }, { status: 404, headers: noStore });
    if (remove) {
      const gate = await requireRecentMfa({ userId, sessionId, action: "passkey.remove", resourceId: id, maxAgeMs: 5 * 60_000 });
      if (!gate.allowed) return gate.response;
    }
    let name: string | undefined;
    if (!remove) {
      const json = await readBoundedJson(request);
      if (json.response) return json.response;
      const body = nameSchema.safeParse(json.value);
      if (!body.success) return NextResponse.json({ error: "Enter a passkey name of 1 to 80 characters." }, { status: 400, headers: noStore });
      name = body.data.name;
    }
    const changed = await db.transaction(async (tx) => {
      const predicate = and(eq(passkey.id, id), eq(passkey.userId, userId), isNull(passkey.disabledAt));
      const records = remove ? await tx.delete(passkey).where(predicate).returning({ id: passkey.id })
        : await tx.update(passkey).set({ name }).where(predicate).returning({ id: passkey.id });
      if (!records.length) return false;
      await writeAuditEventInTransaction(tx, { actorUserId: userId, action: remove ? "passkey.remove" : "passkey.rename", resourceType: "passkey", resourceId: id, outcome: "success" });
      return true;
    });
    return changed ? NextResponse.json({ ok: true }, { headers: noStore })
      : NextResponse.json({ error: "Passkey not found." }, { status: 404, headers: noStore });
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return mutate(request, context, true, { userId: authz.session.user.id, sessionId: authz.session.session.id });
}
export async function PATCH(request: NextRequest, context: Context) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return mutate(request, context, false, { userId: authz.session.user.id, sessionId: authz.session.session.id });
}
