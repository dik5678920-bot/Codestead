import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";

export function proxy(request: NextRequest) {
  const decision = evaluateRequestOrigin({
    method: request.method,
    headers: request.headers,
    appUrl: process.env.APP_URL,
    production: process.env.NODE_ENV === "production",
  });
  if (decision.allowed) {
    const nonce = randomBytes(32).toString("base64");
    const production = process.env.NODE_ENV === "production";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      "script-src-attr 'none'",
      // Monaco and the application's inline style properties need this.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Browser monitoring uses /api/monitoring/envelope, never the remote DSN.
      `connect-src 'self'${production ? "" : " ws: wss:"}`,
      "worker-src 'self' blob:",
      // Google OAuth navigates via the same-origin auth endpoint, not a form
      // submission to Google. No external script or connect allowance is needed.
      "form-action 'self'",
      ...(production ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    const headers = new Headers(request.headers);
    // Replace client-supplied values before Next extracts the rendering nonce.
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  return NextResponse.json(
    { error: decision.code },
    {
      status: decision.status,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

export const config = {
  matcher: ["/api/:path*", "/((?!api/|_next/static|_next/image|monaco/|favicon.ico).*)"],
};
