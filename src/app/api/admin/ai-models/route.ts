import { NextRequest } from "next/server";
import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { requireAdmin } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { adminModelMfaIsFresh } from "@/lib/ai/admin-models-authorization";
import { modelCommandSchema } from "@/lib/ai/admin-models-domain";
import { executeAdminModelCommand, listAdminModels } from "@/lib/ai/admin-models-service";
import { isProviderError } from "@/lib/ai/types";

export const runtime = "nodejs";
export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "admin_ai_models_read", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    try { return adminJson({ providers: await listAdminModels() }); }
    catch { return adminJson({ error: "AI model settings are temporarily unavailable." }, 503); }
  });
}
async function boundedBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 32768) { await reader.cancel(); return null; }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}
export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  // Enforce origin even for requests without cookies; this route is browser/session-only.
  const headers = new Headers(request.headers);
  if (!headers.has("cookie")) headers.set("cookie", "session-route=1");
  const origin = evaluateRequestOrigin({ method: "POST", headers, appUrl: process.env.APP_URL, production: process.env.NODE_ENV === "production" });
  if (!origin.allowed) return adminJson({ error: origin.code }, origin.status);
  return withRateLimit({ policy: "admin_ai_models_write", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const parsed = modelCommandSchema.safeParse(await boundedBody(request));
    if (!parsed.success) return adminJson({ error: "INVALID_REQUEST" }, 400);
    const command = parsed.data;
    if (!await adminModelMfaIsFresh(authz.session.user.id, authz.session.session.id)) {
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "ai_models." + command.action, resourceType: "provider_policy", outcome: "denied", metadata: { provider: command.provider, denialCode: "FRESH_MFA_REQUIRED" } });
      return adminJson({ error: "Verify your authenticator to manage AI model settings.", code: "FRESH_MFA_REQUIRED" }, 403);
    }
    const execute = async () => {
      try { return adminJson(await executeAdminModelCommand({ actorId: authz.session.user.id, sessionId: authz.session.session.id }, command)); }
      catch (error) {
        const normalized = isProviderError(error) ? error : null;
        const code = normalized?.code ?? "UNAVAILABLE";
        console.warn("Admin AI model operation failed", { provider: command.provider, code, httpStatus: normalized?.status ?? null });
        await writeAuditEvent({ actorUserId: authz.session.user.id, action: "ai_models." + command.action, resourceType: "provider_policy", outcome: "failure", metadata: { provider: command.provider, errorCode: code, httpStatus: normalized?.status ?? null } });
        const messages: Record<string, string> = {
          AUTHENTICATION: "Set or replace the platform API key before loading or testing this provider.",
          POLICY: "Check the public HTTPS endpoint, reload changed settings, and test this exact model before saving it as verified. Replace or remove the key when changing its endpoint.",
          MODEL_NOT_FOUND: "This model was not found or has been retired. Choose another model.",
          BAD_REQUEST: "The provider rejected this request. Check its model and endpoint.",
          RATE_LIMIT: "The provider rate limit was reached. Try again later.",
          TIMEOUT: "The provider request timed out. Try again.",
          BAD_RESPONSE: "The provider returned an invalid or unsafe response.",
        };
        return adminJson({ error: messages[code] ?? "AI model operation failed. Try again.", code, httpStatus: normalized?.status ?? null }, normalized?.status === 409 ? 409 : code === "POLICY" ? 400 : 502);
      }
    };
    return command.action === "test"
      ? withRateLimit({ policy: "admin_ai_models_test", identity: { kind: "user", value: authz.session.user.id } }, execute)
      : execute();
  });
}
