import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), changePassword: vi.fn(), hasPassword: vi.fn(), preserveSession: vi.fn(), audit: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/auth", () => ({ auth: { api: { changePassword: mocks.changePassword } } }));
vi.mock("@/lib/security/password-settings", () => ({ hasCredentialPassword: mocks.hasPassword, preservePasswordChangeSession: mocks.preserveSession }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.limit }));
import { POST } from "../route";
const current = { user: { id: "owner" }, session: { id: "session", mfaVerifiedAt: new Date(), deviceHash: "device" } };
const request = (body: unknown = { currentPassword: "current-password", newPassword: "a-new-long-password" }) => new NextRequest("https://learn.test/api/security/change-password", { method: "POST", headers: { "Content-Type": "application/json", cookie: "session-cookie" }, body: JSON.stringify(body) });
beforeEach(() => {
 vi.resetAllMocks(); mocks.requireAuth.mockResolvedValue({ session: current }); mocks.hasPassword.mockResolvedValue(true);
 mocks.limit.mockImplementation((_options, callback) => callback());
 mocks.changePassword.mockResolvedValue(new Response(JSON.stringify({ token: "new-token", user: { id: "owner" } }), { headers: { "set-cookie": "learncoding.session_token=new-token; HttpOnly; Path=/" } }));
});
it("stops anonymous requests before touching credentials", async () => {
 mocks.requireAuth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 401 }) });
 expect((await POST(request())).status).toBe(401); expect(mocks.changePassword).not.toHaveBeenCalled();
});
it("uses Better Auth with request-local current password and forces session revocation", async () => {
 const response = await POST(request()); expect(response.status).toBe(200);
 expect(mocks.changePassword).toHaveBeenCalledWith({ headers: expect.any(Headers), body: { currentPassword: "current-password", newPassword: "a-new-long-password", revokeOtherSessions: true }, asResponse: true });
 expect(mocks.preserveSession).toHaveBeenCalledWith(current, "new-token");
 expect(response.headers.get("set-cookie")).toContain("HttpOnly");
 expect(await response.json()).toEqual({ ok: true });
 expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "owner", action: "account.password_change", outcome: "success" }));
});
it("rejects Google-only accounts without invoking password creation", async () => {
 mocks.hasPassword.mockResolvedValue(false); expect((await POST(request())).status).toBe(403); expect(mocks.changePassword).not.toHaveBeenCalled();
});
it.each([{}, { currentPassword: "current-password", newPassword: "short" }, { currentPassword: "same-long-password", newPassword: "same-long-password" }, { currentPassword: "current-password", newPassword: "a-new-long-password", revokeOtherSessions: false }])("rejects malformed or bypass inputs", async (body) => {
 expect((await POST(request(body))).status).toBe(400); expect(mocks.changePassword).not.toHaveBeenCalled();
});
it("keeps the compromised-password error from the Better Auth plugin", async () => {
 mocks.changePassword.mockRejectedValue({ name: "APIError", statusCode: 400, body: { code: "PASSWORD_COMPROMISED" } });
 const response = await POST(request()); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
 expect(mocks.preserveSession).not.toHaveBeenCalled(); expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
});
it("does not leak provider errors or credentials on an invalid current password", async () => {
 mocks.changePassword.mockRejectedValue({ name: "APIError", statusCode: 400, body: { code: "INVALID_PASSWORD", message: "secret provider details" } });
 const response = await POST(request()); expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).not.toContain("secret");
});
it("fails closed on auth service outages", async () => {
 mocks.changePassword.mockRejectedValue(new Error("secret internal failure")); expect((await POST(request())).status).toBe(503);
});

it("refuses to change a password when its audit admission cannot be recorded", async () => {
 mocks.audit.mockRejectedValue(new Error("audit database unavailable"));
 const response = await POST(request()); expect(response.status).toBe(503); expect(mocks.changePassword).not.toHaveBeenCalled();
});
it("returns the rotated cookie and an honest recovery message if post-change confirmation fails", async () => {
 mocks.preserveSession.mockRejectedValue(new Error("post-change database unavailable"));
 const response = await POST(request()); expect(response.status).toBe(503);
 expect(response.headers.get("set-cookie")).toContain("HttpOnly");
 expect((await response.json()).error).toContain("Password changed");
});
