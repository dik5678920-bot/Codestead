import { beforeEach, expect, it, vi } from "vitest";
import type { CurrentAuth } from "@/lib/http/authz";
const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), limit: vi.fn(), returning: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, update: mocks.update } }));
import { hasCredentialPassword, preservePasswordChangeSession } from "../password-settings";
const current = (stamp: Date | null = new Date("2026-10-04T00:00:00Z")) => ({ user: { id: "owner" }, session: { mfaVerifiedAt: stamp, deviceHash: "approved-device" } }) as unknown as CurrentAuth;
beforeEach(() => {
 vi.resetAllMocks(); mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: mocks.limit }) }) });
 mocks.update.mockReturnValue({ set: mocks.set }); mocks.set.mockReturnValue({ where: () => ({ returning: mocks.returning }) }); mocks.returning.mockResolvedValue([{ id: "rotated-session" }]);
});
it("distinguishes credential availability without exposing password hashes", async () => {
 mocks.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "credential" }]);
 expect(await hasCredentialPassword("owner")).toBe(false); expect(await hasCredentialPassword("owner")).toBe(true);
});
it("rejects unverified session authority before updating its replacement", async () => {
 await expect(preservePasswordChangeSession(current(null), "token")).rejects.toThrow("MFA-completed"); expect(mocks.update).not.toHaveBeenCalled();
});
it("retains prior MFA and device authority on the rotated session", async () => {
 await preservePasswordChangeSession(current(), "token"); expect(mocks.set).toHaveBeenCalledWith({ mfaVerifiedAt: new Date("2026-10-04T00:00:00Z"), deviceHash: "approved-device" });
});
it("fails if the owner-bound replacement session disappeared", async () => {
 mocks.returning.mockResolvedValue([]); await expect(preservePasswordChangeSession(current(), "token")).rejects.toThrow("Replacement session");
});
