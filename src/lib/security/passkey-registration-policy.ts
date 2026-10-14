import { readBoundedJson } from "@/lib/http/bounded-json";

export async function authorizePasskeyRegistration(request: Request): Promise<Response | null> {
  const { requireAuth } = await import("@/lib/http/authz");
  const { requireRecentMfa } = await import("./recent-mfa");
  const { withRateLimit, rateLimitIp } = await import("./rate-limit");
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const admission = await withRateLimit([
    { policy: "passkey_register_user", identity: { kind: "user", value: authz.session.user.id } },
    { policy: "passkey_register_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
  ], async () => new Response(null, { status: 204 }));
  if (admission.status !== 204) return admission;
  const gate = await requireRecentMfa({ userId: authz.session.user.id, sessionId: authz.session.session.id,
    action: "passkey.add", maxAgeMs: 5 * 60_000 });
  if (!gate.allowed) return gate.response;
  if (request.method === "POST") {
    const parsed = await readBoundedJson(request.clone());
    if (parsed.response) return parsed.response;
    const body = parsed.value as { createSession?: unknown; name?: unknown } | null;
    if (!body || body.createSession !== undefined || (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80))) {
      return Response.json({ error: "Invalid passkey registration." }, { status: 400 });
    }
  }
  const name = new URL(request.url).searchParams.get("name");
  if (name !== null && (!name.trim() || name.length > 80)) return Response.json({ error: "Invalid passkey name." }, { status: 400 });
  return null;
}

export async function requirePasskeyUvOptions(request: Request, response: Response) {
  if (!response.ok || !new URL(request.url).pathname.endsWith("/passkey/generate-authenticate-options")) return response;
  const body = await response.json();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Cache-Control", "private, no-store");
  return Response.json({ ...body, userVerification: "required" }, { status: response.status, headers });
}
