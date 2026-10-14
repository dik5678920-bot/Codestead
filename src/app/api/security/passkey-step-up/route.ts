import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/http/authz";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { passkeyStepUpOptions, verifyPasskeyStepUp } from "@/lib/security/passkeys";
import { withRateLimit, rateLimitIp } from "@/lib/security/rate-limit";
import { writeAuditEvent } from "@/lib/security/audit-writer";

const noStore = { "Cache-Control": "private, no-store" };
const assertion = z.object({ id: z.string().uuid(), response: z.object({ id: z.string().min(1).max(2048), rawId: z.string().min(1).max(2048), type: z.literal("public-key"),
  response: z.object({ clientDataJSON: z.string().min(1).max(8192), authenticatorData: z.string().min(1).max(8192), signature: z.string().min(1).max(8192), userHandle: z.string().nullable().optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()), authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional() }) }).strict();

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowMfaChallenge: true });
  if (!authz.session) return authz.response;
  const userId = authz.session.user.id;
  const sessionId = authz.session.session.id;
  return withRateLimit([
    { policy: "fresh_mfa_user", identity: { kind: "user", value: userId } },
    { policy: "passkey_step_up_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
  ], async () => {
    const json = await readBoundedJson(request);
    if (json.response) return json.response;
    try {
      if (json.value && typeof json.value === "object" && !Array.isArray(json.value) && Object.keys(json.value).length === 0) {
        return NextResponse.json(await passkeyStepUpOptions(userId, sessionId), { headers: noStore });
      }
      const body = assertion.safeParse(json.value);
      if (!body.success) return NextResponse.json({ error: "Invalid passkey assertion." }, { status: 400, headers: noStore });
      const verifiedAt = await verifyPasskeyStepUp(userId, sessionId, body.data.id, { ...body.data.response,
        response: { ...body.data.response.response, userHandle: body.data.response.response.userHandle ?? undefined } });
      return NextResponse.json({ ok: true, validUntil: new Date(verifiedAt.getTime() + 5 * 60_000) }, { headers: noStore });
    } catch {
      await writeAuditEvent({ actorUserId: userId, action: "passkey.use", resourceType: "session", resourceId: sessionId, outcome: "denied", metadata: { purpose: "step_up" } });
      return NextResponse.json({ error: "Passkey verification was not accepted." }, { status: 403, headers: noStore });
    }
  });
}
