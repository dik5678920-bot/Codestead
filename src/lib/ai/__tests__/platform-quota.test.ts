// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ pool: { query: vi.fn() } }));
import { consumePlatformQuota, platformDailyLimit, todayPlatformUsage } from "../platform-quota";
import { FlexiblePostgresRateLimitStore } from "@/lib/security/rate-limit";

const now = new Date("2026-10-05T12:00:00Z");
afterEach(() => vi.unstubAllEnvs());
it("defaults to 25 daily requests and rejects invalid environment limits", () => {
  vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", "");
  expect(platformDailyLimit()).toBe(25);
  vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", "40");
  expect(platformDailyLimit()).toBe(40);
  for (const value of ["0", "-1", "2.5", "NaN", "1000001"]) {
    vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", value);
    expect(() => platformDailyLimit()).toThrow();
  }
});
it("uses the existing atomic Postgres limiter with a per-user UTC day bucket", async () => {
  vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", "25");
  const query = vi.fn().mockResolvedValue({ rows: [{ points: 25, expire: now.getTime() + 86400000 }] });
  const store = new FlexiblePostgresRateLimitStore({ query }, Number.POSITIVE_INFINITY);
  await consumePlatformQuota("learner-1", { store, now, secret: "s".repeat(32) });
  const statement = query.mock.calls[0][0];
  expect(statement.text).toContain("ON CONFLICT(key)");
  expect(statement.values[0]).toMatch(/^ai_platform_day:[a-f0-9]{64}:1791158400000$/);
  expect(statement.values[0]).not.toContain("learner-1");
  query.mockResolvedValue({ rows: [{ points: 26, expire: now.getTime() + 86400000 }] });
  await expect(consumePlatformQuota("learner-1", { store, now, secret: "s".repeat(32) }))
    .rejects.toMatchObject({ code: "PLATFORM_AI_QUOTA_EXCEEDED", status: 429, retryAfterSeconds: 43200 });
});
it("fails closed on database failure instead of allowing platform calls", async () => {
  const store = { consume: vi.fn().mockRejectedValue(new Error("database unavailable")) };
  await expect(consumePlatformQuota("learner", { store, now, secret: "s".repeat(32) }))
    .rejects.toMatchObject({ code: "PLATFORM_AI_QUOTA_UNAVAILABLE", status: 503 });
});
it("admits exactly 25 concurrent requests per user and starts a fresh bucket at UTC midnight", async () => {
  vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", "25");
  const counters = new Map<string, number>();
  const query = vi.fn(async (statement: { text: string; values: unknown[] }) => {
    const key = String(statement.values[0]);
    const points = (counters.get(key) ?? 0) + 1;
    counters.set(key, points);
    return { rows: [{ points, expire: Date.now() + 172800000 }] };
  });
  const store = new FlexiblePostgresRateLimitStore({ query }, Number.POSITIVE_INFINITY);
  for (const user of ["learner-1", "learner-2"]) {
    const requests = await Promise.allSettled(Array.from({ length: 26 }, () => consumePlatformQuota(user, { store, now, secret: "s".repeat(32) })));
    expect(requests.filter((request) => request.status === "fulfilled")).toHaveLength(25);
    expect(requests.filter((request) => request.status === "rejected")).toHaveLength(1);
  }
  expect(counters.size).toBe(2);
  await consumePlatformQuota("learner-1", { store, now: new Date("2026-10-06T00:00:00Z"), secret: "s".repeat(32) });
  expect(counters.size).toBe(3);
});
it("reports only today's admitted platform attempts, excluding rejected retries", async () => {
  vi.stubEnv("PLATFORM_AI_DAILY_REQUEST_LIMIT", "25");
  const query = vi.fn().mockResolvedValue({ rows: [{ count: "47" }] });
  expect(await todayPlatformUsage({ query }, now)).toEqual({ count: 47, date: "2026-10-05", dailyLimit: 25 });
  expect(query.mock.calls[0][0]).toContain("LEAST(points, $1)");
  expect(query.mock.calls[0][1]).toEqual([25, "ai_platform_day:%:1791158400000"]);
});
