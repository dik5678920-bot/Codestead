import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), mail: vi.fn(), audit: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmailInTransaction: mocks.mail }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEventInTransaction: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rate }));
import { createSupportRequest, fixSupportRequest } from "../support-service";
const input = { requestId: "10000000-0000-4000-8000-000000000001", kind: "support-ai" as const, provider: "google" as const, message: "Model failed validation" };
const row = { id: input.requestId, userId: "learner", kind: input.kind, subject: "AI model/key problem · google", details: JSON.stringify({ message: input.message }), status: "pending", decisionReason: null };
function fakeTx(results: unknown[][]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "from", "where", "orderBy", "limit", "for", "insert", "values", "returning", "update", "set"]) chain[method] = vi.fn(() => chain);
  chain.then = vi.fn((resolve) => Promise.resolve(results.shift() ?? []).then(resolve));
  chain.execute = vi.fn().mockResolvedValue({ rows: [] });
  mocks.transaction.mockImplementation(async (fn) => fn(chain));
  return chain;
}
describe("support request transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockImplementation(async (_checks, fn) => fn());
    mocks.mail.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });
  it("serializes creates and dedupes identical open requests without budget or mail", async () => {
    const tx = fakeTx([[], [row]]);
    const response = await createSupportRequest("learner", input);
    expect(response.status).toBe(200);
    expect(tx.execute).toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.mail).not.toHaveBeenCalled();
  });
  it("uses both daily budgets and the existing writer for each active admin", async () => {
    const tx = fakeTx([[], [], [row], [{ id: "admin", email: "admin@example.test", name: "Admin" }]]);
    expect((await createSupportRequest("learner", input)).status).toBe(201);
    expect(mocks.rate.mock.calls[0][0]).toEqual([
      { policy: "contact_admin_ai_provider_user", identity: { kind: "user", value: "learner:google" } },
      { policy: "learning_request_user", identity: { kind: "user", value: "learner" } },
    ]);
    expect(mocks.mail).toHaveBeenCalledWith(tx, expect.objectContaining({ template: "support-request-admin", userId: "admin", idempotencySeed: `${row.id}:created`, variables: expect.not.objectContaining({ message: input.message }) }));
  });
  it("preserves idempotency mismatch and never spends a budget on a retry", async () => {
    fakeTx([[{ ...row, details: "different" }]]);
    await expect(createSupportRequest("learner", input)).rejects.toThrow("IDEMPOTENCY_MISMATCH");
    expect(mocks.rate).not.toHaveBeenCalled();
  });
  it("fixes a support row with atomic audit, notification and email", async () => {
    const tx = fakeTx([[row], [], [], [{ id: "learner", name: "Learner", email: "learner@example.test" }]]);
    expect(await fixSupportRequest("admin", row.id, "Try again now")).toMatchObject({ ok: true });
    expect(tx.insert).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "support_request.fixed", resourceId: row.id }));
    expect(mocks.mail).toHaveBeenCalledWith(tx, expect.objectContaining({ template: "support-request-fixed", userId: "learner", idempotencySeed: `${row.id}:fixed` }));
  });
  it("replays fixed requests without repeating any effects", async () => {
    fakeTx([[{ ...row, status: "approved" }]]);
    expect(await fixSupportRequest("admin", row.id, "")).toMatchObject({ ok: true, replayed: true });
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("cannot mark curriculum or closed non-fixed requests fixed", async () => {
    for (const candidate of [{ ...row, kind: "new-subject" }, { ...row, status: "rejected" }]) {
      fakeTx([[candidate]]);
      expect(await fixSupportRequest("admin", row.id, "")).toBeNull();
    }
  });
  it("propagates outbox failure so the transaction rolls back", async () => {
    fakeTx([[row], [], [], [{ id: "learner", email: "learner@example.test" }]]);
    mocks.mail.mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(fixSupportRequest("admin", row.id, "")).rejects.toThrow("outbox unavailable");
  });
});
