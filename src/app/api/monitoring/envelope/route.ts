import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/http/authz";
import { envelopeTarget, MAX_ENVELOPE_BYTES, rewriteEnvelope } from "@/lib/observability/envelope-tunnel";

const NO_STORE = { "Cache-Control": "private, no-store" };

function browserTarget() {
  return envelopeTarget(process.env.SENTRY_BROWSER_DSN);
}

/** Browser monitoring availability and deployment release for this signed-in session. */
export async function GET() {
  const authz = await requireAuth({ allowPending: true, allowPasswordChange: true, allowMfaChallenge: true });
  if (!authz.session) return authz.response;
  const status = { enabled: browserTarget() !== null };
  const release = status.enabled ? process.env.SENTRY_RELEASE?.trim() : undefined;
  return NextResponse.json({ ...status, ...(release ? { release } : {}) }, { headers: NO_STORE });
}

/** Forward one browser error envelope to the configured GlitchTip project. */
export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true, allowPasswordChange: true, allowMfaChallenge: true });
  if (!authz.session) return authz.response;
  const target = browserTarget();
  if (!target) return new NextResponse(null, { status: 204, headers: NO_STORE });
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_ENVELOPE_BYTES) return new NextResponse(null, { status: 413, headers: NO_STORE });
  const envelope = rewriteEnvelope(await request.text(), target);
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
}
