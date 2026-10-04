// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn(), where: vi.fn(), from: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
import { adminModelMfaIsFresh } from "../admin-models-authorization";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T12:00:00Z")); mocks.select.mockReturnValue({ from: mocks.from }); mocks.from.mockReturnValue({ where: mocks.where }); mocks.where.mockReturnValue({ limit: mocks.limit }); });
afterEach(() => vi.useRealTimers());
it.each([undefined, new Date("2026-10-03T11:59:59Z"), new Date("2026-10-04T12:00:01Z"), new Date("invalid")])("refuses a missing, expired, future or invalid durable MFA timestamp", async (mfaVerifiedAt) => {
 mocks.limit.mockResolvedValue(mfaVerifiedAt ? [{ mfaVerifiedAt }] : []); expect(await adminModelMfaIsFresh("admin", "session")).toBe(false);
});
it("uses the existing 24-hour administrator step-up policy for this session", async () => {
 mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date("2026-10-03T12:00:00Z") }]); expect(await adminModelMfaIsFresh("admin", "session")).toBe(true);
});
