import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuth = vi.fn();
const isApplicationAuthRequired = vi.fn(() => true);
vi.mock("@/lib/http/authz", () => ({ requireAuth }));
vi.mock("@/lib/security/runtime-policy", () => ({ isApplicationAuthRequired }));

const { signedInDestination } = await import("../signed-in-destination");

function denied(status: number, code?: string) {
  return { session: null, response: NextResponse.json({ code }, { status }) };
}

beforeEach(() => {
  requireAuth.mockReset();
  isApplicationAuthRequired.mockReturnValue(true);
});

describe("signedInDestination", () => {
  it("sends a remembered active learner straight to the app", async () => {
    requireAuth.mockResolvedValue({ session: {}, account: { status: "active" }, response: null });
    await expect(signedInDestination()).resolves.toBe("/learn");
    expect(requireAuth).toHaveBeenCalledWith({ allowPending: true });
  });

  it("resumes setup for a pending account and the challenge for an unverified session", async () => {
    requireAuth.mockResolvedValueOnce({ session: {}, account: { status: "pending" }, response: null });
    await expect(signedInDestination()).resolves.toBe("/onboarding");
    requireAuth.mockResolvedValueOnce(denied(403, "MFA_CHALLENGE_REQUIRED"));
    await expect(signedInDestination()).resolves.toBe("/two-factor");
  });

  it.each([
    ["no session", denied(401)],
    ["an inactive account", denied(403, "ACCOUNT_NOT_ACTIVE")],
    ["a pending password change", denied(403, "PASSWORD_CHANGE_REQUIRED")],
  ])("keeps the public page for %s (no redirect loop)", async (_label, result) => {
    requireAuth.mockResolvedValue(result);
    await expect(signedInDestination()).resolves.toBeNull();
  });

  it("does nothing in demo mode", async () => {
    isApplicationAuthRequired.mockReturnValue(false);
    await expect(signedInDestination()).resolves.toBeNull();
    expect(requireAuth).not.toHaveBeenCalled();
  });
});
