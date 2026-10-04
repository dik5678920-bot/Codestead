import { and, asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { learningRequest, notification, user } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import { withRateLimit, type RateLimitCheck } from "@/lib/security/rate-limit";
import { encodeSupportDetails, isSupportKind, supportRequestSchema, type SupportRequestInput } from "./support-contract";

const headers = { "Cache-Control": "private, no-store" };
const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export async function createSupportRequest(userId: string, rawInput: SupportRequestInput): Promise<Response> {
  const input = supportRequestSchema.parse(rawInput);
  const subject = input.kind === "support-ai" ? `AI model/key problem · ${input.provider}` : "Other support request";
  const details = encodeSupportDetails(input);
  return db.transaction(async (tx) => {
    // Serialize per owner, including different receipt IDs, before dedupe/budgets.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`support-request:${userId}`}, 0))`);
    const [receipt] = await tx.select().from(learningRequest)
      .where(and(eq(learningRequest.userId, userId), eq(learningRequest.requestId, input.requestId))).limit(1);
    if (receipt) {
      if (receipt.kind !== input.kind || receipt.subject !== subject || receipt.details !== details) throw new Error("IDEMPOTENCY_MISMATCH");
      return NextResponse.json({ request: receipt, replayed: true }, { headers });
    }
    const [duplicate] = await tx.select().from(learningRequest).where(and(
      eq(learningRequest.userId, userId), eq(learningRequest.kind, input.kind),
      eq(learningRequest.subject, subject), eq(learningRequest.details, details), eq(learningRequest.status, "pending"),
    )).limit(1);
    if (duplicate) return NextResponse.json({ request: duplicate, replayed: true }, { headers });
    const checks: RateLimitCheck[] = [];
    if (input.kind === "support-ai") checks.push({ policy: "contact_admin_ai_provider_user", identity: { kind: "user", value: `${userId}:${input.provider}` } });
    checks.push({ policy: "learning_request_user", identity: { kind: "user", value: userId } });
    return withRateLimit(checks, async () => {
      const [created] = await tx.insert(learningRequest).values({ userId, requestId: input.requestId, kind: input.kind, subject, details }).returning();
      if (!created) throw new Error("SUPPORT_REQUEST_WRITE_FAILED");
      const admins = await tx.select({ id: user.id, email: user.email, name: user.name }).from(user)
        .where(and(eq(user.role, "admin"), eq(user.status, "active"), eq(user.emailVerified, true), eq(user.banned, false))).orderBy(asc(user.id));
      for (const admin of admins) await enqueueEmailInTransaction(tx, {
        to: admin.email, userId: admin.id, template: "support-request-admin",
        variables: { name: admin.name, url: `${appUrl()}/admin/requests` },
        idempotencySeed: `${created.id}:created`,
      });
      return NextResponse.json({ request: created, replayed: false }, { status: 201, headers });
    });
  });
}

export async function fixSupportRequest(actorUserId: string, id: string, reply: string) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(learningRequest).where(eq(learningRequest.id, id)).limit(1).for("update");
    if (!candidate || !isSupportKind(candidate.kind)) return null;
    if (candidate.status === "approved") return { ok: true, replayed: true, decision: "fixed", decidedAt: candidate.decidedAt };
    if (candidate.status !== "pending") return null;
    const decidedAt = new Date();
    await tx.update(learningRequest).set({ status: "approved", decisionBy: actorUserId, decisionReason: reply || null, decidedAt, updatedAt: decidedAt })
      .where(and(eq(learningRequest.id, id), eq(learningRequest.status, "pending")));
    await tx.insert(notification).values({
      userId: candidate.userId, type: "support-request-fixed", title: "Your support request was marked fixed",
      body: reply || "The administrator marked your request fixed. Try again and review your request for details.", actionUrl: "/requests",
    });
    const [learner] = await tx.select({ id: user.id, email: user.email, name: user.name }).from(user).where(eq(user.id, candidate.userId)).limit(1);
    if (!learner) throw new Error("SUPPORT_REQUEST_OWNER_UNAVAILABLE");
    await enqueueEmailInTransaction(tx, {
      to: learner.email, userId: learner.id, template: "support-request-fixed",
      variables: { name: learner.name, url: `${appUrl()}/requests` }, idempotencySeed: `${candidate.id}:fixed`,
    });
    await writeAuditEventInTransaction(tx, {
      actorUserId, subjectUserId: candidate.userId, action: "support_request.fixed",
      resourceType: "learning_request", resourceId: id, reason: "Marked support request fixed",
      outcome: "success", metadata: { replyProvided: reply.length > 0 },
    });
    return { ok: true, replayed: false, decision: "fixed", decidedAt };
  });
}
