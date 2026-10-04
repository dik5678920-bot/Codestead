import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/http/authz";
import { hasCredentialPassword } from "@/lib/security/password-settings";
export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try {
    return NextResponse.json({ hasPassword: await hasCredentialPassword(authz.session.user.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Account security settings could not be loaded." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
