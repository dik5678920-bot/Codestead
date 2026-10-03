import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/http/authz";
import { envelopeTarget, MAX_ENVELOPE_BYTES, rewriteEnvelope } from "@/lib/observability/envelope-tunnel";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

const NO_STORE = { "Cache-Control": "private, no-store" };

function browserTarget() {
  return envelopeTarget(process.env.SENTRY_BROWSER_DSN);
}

async function readEnvelope(request: NextRequest): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Browser monitoring availability and deployment release for this signed-in session. */
export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const status = { enabled: browserTarget() !== null };
  const release = status.enabled ? process.env.SENTRY_RELEASE?.trim() : undefined;
  return NextResponse.json({ ...status, ...(release ? { release } : {}) }, { headers: NO_STORE });
}

/** Forward one browser error envelope to the configured GlitchTip project. */
export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit([
    { policy: "monitoring_envelope_user", identity: { kind: "user", value: authz.session.user.id } },
    { policy: "monitoring_envelope_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
  ], async () => {
    const target = browserTarget();
    if (!target) return new NextResponse(null, { status: 204, headers: NO_STORE });
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_ENVELOPE_BYTES) return new NextResponse(null, { status: 413, headers: NO_STORE });
    const body = await readEnvelope(request);
    if (body === null) return new NextResponse(null, { status: 413, headers: NO_STORE });
    const envelope = rewriteEnvelope(body, target);
    if (!envelope) return new NextResponse(null, { status: 400, headers: NO_STORE });
    try {
      await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Monitoring is best effort; never surface its failures to the learner.
    }
    return new NextResponse(null, { status: 202, headers: NO_STORE });
  });
}
