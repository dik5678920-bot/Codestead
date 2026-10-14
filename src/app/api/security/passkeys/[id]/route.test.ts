import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), remove: vi.fn(), returning: vi.fn(), transaction: vi.fn(), auth: vi.fn(), audit: vi.fn(), deniedAudit: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
  transaction: mocks.transaction,
} }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: (_checks: unknown, run: () => unknown) => run() }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEventInTransaction: mocks.audit, writeAuditEvent: mocks.deniedAudit }));
import { DELETE } from "./route";

describe("passkey removal authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ session: { user: { id: "owner" }, session: { id: "current" } } });
    mocks.limit.mockReset();
    mocks.remove.mockReturnValue({ where: () => ({ returning: mocks.returning }) });
    mocks.returning.mockResolvedValue([{ id: "key" }]);
    mocks.transaction.mockImplementation((run) => run({ delete: mocks.remove }));
  });
  const request = () => new NextRequest("https://example.test/api/security/passkeys/key", { method: "DELETE" });
  const context = () => ({ params: Promise.resolve({ id: "key" }) });
  it("rejects missing fresh MFA with 403 and no mutation", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: "key" }]).mockResolvedValueOnce([{ mfaVerifiedAt: null }]);
    expect((await DELETE(request(), context())).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects a session verified more than five minutes ago", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: "key" }]).mockResolvedValueOnce([{ mfaVerifiedAt: new Date(Date.now() - 301_000) }]);
    expect((await DELETE(request(), context())).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("removes an owned passkey with fresh MFA and writes the audit in the transaction", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: "key" }]).mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }]);
    const response = await DELETE(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ delete: mocks.remove }), expect.objectContaining({ actorUserId: "owner", resourceId: "key", action: "passkey.remove", outcome: "success" }));
  });
  it("returns 404 for another user's passkey before revealing MFA state", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    expect((await DELETE(request(), context())).status).toBe(404);
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rolls back if the audit writer fails", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: "key" }]).mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }]);
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(DELETE(request(), context())).rejects.toThrow("audit unavailable");
  });
});
