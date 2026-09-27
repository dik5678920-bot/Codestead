import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

/**
 * Where a visitor who already holds a live session on this device should go
 * instead of the landing page or the sign-in form, or null to render the
 * public page. Mirrors the (app) layout gate so the two never disagree:
 * reopening the site on a remembered device resumes learning, while an
 * inactive account or a session that still needs a password change stays on
 * the public page (redirecting those would loop through /login).
 */
export async function signedInDestination(): Promise<string | null> {
  if (!isApplicationAuthRequired()) return null;
  const authz = await requireAuth({ allowPending: true });
  if (authz.session) {
    return authz.account.status === "pending" ? "/onboarding" : "/learn";
  }
  const denial = (await authz.response.json().catch(() => ({}))) as { code?: string };
  return denial.code === "MFA_CHALLENGE_REQUIRED" ? "/two-factor" : null;
}
