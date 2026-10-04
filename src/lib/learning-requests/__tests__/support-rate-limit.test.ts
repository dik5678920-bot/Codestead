import { describe, expect, it } from "vitest";
import { getRateLimitPolicy, withRateLimit, type ConsumeInput, type RateLimitStore } from "@/lib/security/rate-limit";
describe("support request rate limits", () => {
  it("isolates AI budgets by both user and provider with one request per day", async () => {
    const counts = new Map<string, number>();
    const store: RateLimitStore = { async consume(input: ConsumeInput) {
      const key = `${input.scope}:${input.keyHash}`;
      const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      return { count, resetAt: new Date(input.now.getTime() + input.windowSeconds * 1000) };
    } };
    const policy = getRateLimitPolicy("contact_admin_ai_provider_user");
    expect(policy).toMatchObject({ limit: 1, windowSeconds: 86400, failureMode: "closed" });
    expect(getRateLimitPolicy("learning_request_user")).toMatchObject({ limit: 5, windowSeconds: 86400, failureMode: "closed" });
    const invoke = (identity: string) => withRateLimit({ policy: "contact_admin_ai_provider_user", identity: { kind: "user", value: identity } }, async () => new Response(null, { status: 201 }), { store, secret: "test-only-fixture".repeat(3), now: () => new Date("2026-10-04T10:00:00Z") });
    expect((await invoke("learner-a:google")).status).toBe(201);
    expect((await invoke("learner-a:google")).status).toBe(429);
    expect((await invoke("learner-a:openai")).status).toBe(201);
    expect((await invoke("learner-b:google")).status).toBe(201);
  });
});
