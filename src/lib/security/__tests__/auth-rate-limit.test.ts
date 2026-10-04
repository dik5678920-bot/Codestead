import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock("../rate-limit", () => ({ withRateLimit: mocks.limit }));
import { atomicAuthRateLimitPlugin } from "../auth-rate-limit";

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("atomic auth request admission", () => {
  it.each([
    ["/sign-in/email", "auth_sign_in_ip", 8, 60],
    ["/sign-up/email", "auth_sign_up_ip", 3, 600],
    ["/two-factor/verify-totp", "auth_totp_ip", 6, 60],
  ])("enforces %s before endpoint validation", async (path, name, limit, windowSeconds) => {
    mocks.limit.mockImplementation(async (_check, admitted) => admitted());
    const plugin = atomicAuthRateLimitPlugin(true);
    const result = await plugin.onRequest(new Request(`https://example.test/api/auth${path}/`, {
      headers: { "cf-connecting-ip": "198.51.100.41", "x-forwarded-for": "203.0.113.9" },
    }), { baseURL: "https://example.test/api/auth" });
    expect(result).toBeUndefined();
    expect(mocks.limit).toHaveBeenCalledWith({
      policy: { name, limit, windowSeconds, failureMode: "closed" },
      identity: { kind: "ip", value: "198.51.100.41" },
    }, expect.any(Function));
  });

  it("preserves Better Auth's exact denial body and retry header", async () => {
    mocks.limit.mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "42" } }));
    const result = await atomicAuthRateLimitPlugin(true).onRequest(
      new Request("https://example.test/api/auth/sign-in/email"), { baseURL: "https://example.test/api/auth" },
    );
    expect(result?.response.status).toBe(429);
    expect(await result?.response.json()).toEqual({ message: "Too many requests. Please try again later." });
    expect(result?.response.headers.get("X-Retry-After")).toBe("42");
  });

  it("fails closed when persistence is unavailable", async () => {
    const unavailable = new Response("{}", { status: 503 });
    mocks.limit.mockResolvedValue(unavailable);
    expect((await atomicAuthRateLimitPlugin(true).onRequest(
      new Request("https://example.test/api/auth/sign-in/email"), { baseURL: "https://example.test/api/auth" },
    ))?.response).toBe(unavailable);
  });

  it.each(["", "not-an-ip", "fe80::1%eth0"])("shares invalid/missing Cloudflare addresses despite configured forwarding trust", async (ip) => {
    vi.stubEnv("RATE_LIMIT_TRUSTED_IP_HEADER", "x-forwarded-for");
    mocks.limit.mockImplementation(async (_check, admitted) => admitted());
    await atomicAuthRateLimitPlugin(true).onRequest(new Request("https://example.test/api/auth/sign-in/email", {
      headers: { "cf-connecting-ip": ip, "x-forwarded-for": "203.0.113.9" },
    }), { baseURL: "https://example.test/api/auth" });
    expect(mocks.limit.mock.calls[0][0].identity.value).toBe("unavailable");
  });

  it("leaves database-free development and unrelated endpoints to the secondary limiter", async () => {
    const request = new Request("https://example.test/api/auth/sign-in/email");
    const context = { baseURL: "https://example.test/api/auth" };
    await atomicAuthRateLimitPlugin(false).onRequest(request, context);
    await atomicAuthRateLimitPlugin(true).onRequest(new Request("https://example.test/api/auth/get-session"), context);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it("canonicalizes equivalent IPv6 headers into the same endpoint identity", async () => {
    mocks.limit.mockImplementation(async (_check, admitted) => admitted());
    const plugin = atomicAuthRateLimitPlugin(true);
    for (const ip of ["2001:db8::1", "2001:0DB8:0:0:0:0:0:1"]) {
      await plugin.onRequest(new Request("https://example.test/api/auth/sign-in/email", {
        headers: { "cf-connecting-ip": ip },
      }), { baseURL: "https://example.test/api/auth" });
    }
    expect(mocks.limit.mock.calls.map(([check]) => check.identity.value)).toEqual(["2001:db8::1", "2001:db8::1"]);
  });
});
