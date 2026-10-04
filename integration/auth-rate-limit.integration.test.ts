import { betterAuth } from "better-auth";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { auth } from "@/lib/auth";
import { pool } from "@/lib/db/client";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const CLIENT_IP = "198.51.100.41";
const newAuthInstance = () => betterAuth(auth.options);

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
  it("restricts the counter to application admission and operations cleanup", async () => {
    const result = await pool.query(`
      select role_name, privilege,
             has_table_privilege(role_name, 'public.auth_rate_limit', privilege) allowed
        from (values ('learncoding_app'), ('learncoding_worker'), ('learncoding_ops')) roles(role_name)
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privileges(privilege)
       order by role_name, privilege
    `);
    expect(result.rows).toEqual([
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_app", privilege, allowed: true })),
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_ops", privilege, allowed: ["DELETE", "SELECT"].includes(privilege) })),
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege => ({ role_name: "learncoding_worker", privilege, allowed: false })),
    ]);
  });

  it.each([
    ["/sign-in/email", 8, 60],
    ["/sign-up/email", 3, 600],
    ["/two-factor/verify-totp", 6, 60],
  ] as const)("preserves %s's custom budget across a new auth instance", async (path, max, window) => {
    const first = newAuthInstance();
    for (let count = 0; count < max; count++) {
      expect((await first.handler(request(path))).status).toBe(400);
    }
    const key = `${CLIENT_IP}|${path}`;
    const before = await pool.query("select key, count, last_request from auth_rate_limit where key = $1", [key]);
    expect(before.rows).toEqual([{ key, count: max, last_request: expect.any(String) }]);
    const restarted = newAuthInstance();
    expect(restarted).not.toBe(first);
    const denied = await restarted.handler(request(path));
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ message: "Too many requests. Please try again later." });
    expect(Number(denied.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    expect(Number(denied.headers.get("X-Retry-After"))).toBeLessThanOrEqual(window);
    expect((await pool.query("select key, count, last_request from auth_rate_limit where key = $1", [key])).rows)
      .toEqual(before.rows);
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
    expect((await pool.query("select key, count from auth_rate_limit order by key")).rows).toEqual([
      { key: "198.51.100.41|/sign-in/email", count: 8 },
      { key: "198.51.100.42|/sign-in/email", count: 1 },
    ]);
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
    expect((await pool.query("select key, count from auth_rate_limit")).rows)
      .toEqual([{ key: "127.0.0.1|/sign-in/email", count: 8 }]);
  });

  it("shares atomic admission across concurrent auth instances", async () => {
    const first = newAuthInstance();
    const second = newAuthInstance();
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      (index % 2 ? first : second).handler(request("/sign-in/email"))));
    expect(responses.filter(response => response.status === 400)).toHaveLength(8);
    expect(responses.filter(response => response.status === 429)).toHaveLength(8);
    expect((await pool.query("select count from auth_rate_limit")).rows).toEqual([{ count: 8 }]);
  });
});
