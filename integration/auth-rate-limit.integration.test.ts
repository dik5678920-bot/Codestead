import { betterAuth } from "better-auth";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/lib/auth";
import { pool } from "@/lib/db/client";
import { hashRateLimitIdentity } from "@/lib/security/rate-limit";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const CLIENT_IP = "198.51.100.41";
const newAuthInstance = () => betterAuth(auth.options);
const budgets = [
  ["/sign-in/email", 8, 60, "auth_sign_in_ip"],
  ["/sign-up/email", 3, 600, "auth_sign_up_ip"],
  ["/two-factor/verify-totp", 6, 60, "auth_totp_ip"],
] as const;

async function counters(scope: string, ip = CLIENT_IP) {
  const prefix = `${scope}:${hashRateLimitIdentity(scope, "ip", ip)}:`;
  const result = await pool.query("select key, points, expire::text as expire from api_rate_limit where key like $1 order by key", [`${prefix}%`]);
  return { rows: result.rows, key: expect.stringMatching(new RegExp(`^${prefix}\\d+$`)) };
}

function request(path: string, headers: Record<string, string> = {}) {
  return new Request(`${auth.options.baseURL}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": CLIENT_IP, ...headers },
    // Invalid endpoint input consumes the budget without creating a user/session
    // or performing password hashing, email delivery or a TOTP challenge.
    body: "{}",
  });
}

beforeEach(async () => { await resetDisposableIntegrationDatabase(pool); });
afterAll(async () => { await pool.end(); });

describe("durable Better Auth rate limits", () => {
  it("uses the existing counter grants without adding an auth table", async () => {
    expect((await pool.query("select to_regclass('public.auth_rate_limit') as removed")).rows)
      .toEqual([{ removed: null }]);
    const result = await pool.query(`
      select role_name, privilege,
             has_table_privilege(role_name, 'public.api_rate_limit', privilege) allowed
        from (values ('learncoding_app'), ('learncoding_worker'), ('learncoding_ops')) roles(role_name)
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privileges(privilege)
       order by role_name, privilege
    `);
    expect(result.rows).toEqual([
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_app", privilege, allowed: true })),
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_ops", privilege, allowed: true })),
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_worker", privilege, allowed: true })),
    ]);
  });

  it.each(budgets)("preserves %s's custom budget across a new auth instance", async (path, max, window, scope) => {
    const first = newAuthInstance();
    for (let count = 0; count < max; count++) {
      expect((await first.handler(request(path))).status).toBe(400);
    }
    const before = await counters(scope);
    expect(before.rows).toEqual([{ key: before.key, points: max, expire: expect.any(String) }]);
    const restarted = newAuthInstance();
    expect(restarted).not.toBe(first);
    const denied = await restarted.handler(request(path));
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ message: "Too many requests. Please try again later." });
    expect(Number(denied.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    expect(Number(denied.headers.get("X-Retry-After"))).toBeLessThanOrEqual(window);
    // The atomic library counts every attempt, including denials. The bucket
    // identity/expiry survive a new instance; a denial never grants admission.
    expect((await counters(scope)).rows).toEqual([{ ...before.rows[0], points: max + 1 }]);
  });

  it("uses only cf-connecting-ip, ignoring spoofed forwarding headers", async () => {
    const instance = newAuthInstance();
    for (let count = 0; count < 8; count++) {
      expect((await instance.handler(request("/sign-in/email", {
        "x-forwarded-for": `203.0.113.${count + 1}`, "x-real-ip": `203.0.113.${count + 20}`,
      }))).status).toBe(400);
    }
    expect((await newAuthInstance().handler(request("/sign-in/email", { "x-forwarded-for": "203.0.113.99" }))).status)
      .toBe(429);
    expect((await newAuthInstance().handler(request("/sign-in/email", { "cf-connecting-ip": "198.51.100.42" }))).status)
      .toBe(400);
    const primary = await counters("auth_sign_in_ip");
    expect(primary.rows).toEqual([{ key: primary.key, points: 9, expire: expect.any(String) }]);
    const other = await counters("auth_sign_in_ip", "198.51.100.42");
    expect(other.rows).toEqual([{ key: other.key, points: 1, expire: expect.any(String) }]);
  });

  it("shares its dev/test fallback budget when the trusted header is missing", async () => {
    const instance = newAuthInstance();
    for (let count = 0; count < 8; count++) {
      expect((await instance.handler(request("/sign-in/email", {
        "cf-connecting-ip": "", "x-forwarded-for": `203.0.113.${count + 1}`,
      }))).status).toBe(400);
    }
    expect((await newAuthInstance().handler(request("/sign-in/email", {
      "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "203.0.113.99",
    }))).status).toBe(429);
    const fallback = await counters("auth_sign_in_ip", "unavailable");
    expect(fallback.rows).toEqual([{ key: fallback.key, points: 9, expire: expect.any(String) }]);
  });

  it("shares atomic admission across concurrent auth instances", async () => {
    const first = newAuthInstance();
    const second = newAuthInstance();
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      (index % 2 ? first : second).handler(request("/sign-in/email"))));
    expect(responses.filter(response => response.status === 400)).toHaveLength(8);
    expect(responses.filter(response => response.status === 429)).toHaveLength(8);
    const stored = await counters("auth_sign_in_ip");
    expect(stored.rows).toEqual([{ key: stored.key, points: 16, expire: expect.any(String) }]);
  });

  it.each(budgets)("admits exactly %s's budget under concurrent requests across instances", async (path, max, _window, scope) => {
    const first = newAuthInstance();
    const second = newAuthInstance();
    const responses = await Promise.all(Array.from({ length: max * 2 }, (_, index) =>
      (index % 2 ? first : second).handler(request(path))));
    expect(responses.filter(response => response.status === 400)).toHaveLength(max);
    expect(responses.filter(response => response.status === 429)).toHaveLength(max);
    const stored = await counters(scope);
    expect(stored.rows).toEqual([{ key: stored.key, points: max * 2, expire: expect.any(String) }]);
    expect((await pool.query("select to_regclass('public.auth_rate_limit') as removed")).rows).toEqual([{ removed: null }]);
  });

  it("refuses admission when the atomic database write fails", async () => {
    const query = vi.spyOn(pool, "query").mockRejectedValue(new Error("simulated persistence outage"));
    try {
      const response = await newAuthInstance().handler(request("/sign-in/email"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
    } finally {
      query.mockRestore();
    }
    expect((await counters("auth_sign_in_ip")).rows).toEqual([]);
  });
});
