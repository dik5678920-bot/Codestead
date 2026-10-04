import { NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/security/password-settings", () => ({ hasCredentialPassword: mocks.status }));
import { GET } from "../route";
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ session: { user: { id: "owner" } } }); });
it("returns only credential capability for the durable session owner without caching", async () => {
 mocks.status.mockResolvedValue(true); const response = await GET();
 expect(mocks.status).toHaveBeenCalledWith("owner"); expect(await response.json()).toEqual({ hasPassword: true }); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("rejects anonymous requests before reading account data", async () => {
 mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 401 }) });
 expect((await GET()).status).toBe(401); expect(mocks.status).not.toHaveBeenCalled();
});
it("does not misclassify an outage as a passwordless account", async () => {
 mocks.status.mockRejectedValue(new Error("private database error")); const response = await GET(); expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("hasPassword");
});
