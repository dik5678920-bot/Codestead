// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Better Auth's plugin-wrapped hasher only works inside an endpoint context.
  hash: vi.fn(async () => { throw new Error("No auth context found. Please make sure you are using runWithEndpointContext()."); }),
  verify: vi.fn(async () => false),
  rows: [] as unknown[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { $context: Promise.resolve({ password: { hash: mocks.hash, verify: mocks.verify } }) },
}));
vi.mock("@/lib/db/client", () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: async () => mocks.rows };
  return { db: { select: () => chain } };
});
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitIp: () => "203.0.113.1",
  withRateLimit: async (_policy: unknown, handler: () => Promise<Response>) => handler(),
}));
vi.mock("@/lib/security/request-origin-policy", () => ({ evaluateRequestOrigin: () => ({ allowed: true }) }));
vi.mock("@/lib/security/session-takeover", () => ({
  claimTotpCode: vi.fn(), consumeSessionTakeoverBudget: vi.fn(), INTERNAL_TOTP_GRANT_HEADER: "x-test",
  issueInternalTotpGrant: vi.fn(), recordSessionTakeoverFailure: vi.fn(), revokeSessionsForTakeover: vi.fn(),
}));

import { POST } from "./route";

function request() {
  return new NextRequest("https://codestead.test/api/security/session-takeover", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://codestead.test" },
    body: JSON.stringify({ email: "nobody@example.test", password: "any-password", code: "123456" }),
  });
}

beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; });

describe("session takeover for unknown accounts", () => {
  it("does equal verifier work outside an endpoint context and gives the generic answer", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Email, password, or authenticator code is incorrect.", code: "SESSION_TAKEOVER_REJECTED" });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledOnce();
    const [{ hash, password }] = mocks.verify.mock.calls[0] as unknown as [{ hash: string; password: string }];
    expect(password).toBe("any-password");
    expect(hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/u);
  });
});
