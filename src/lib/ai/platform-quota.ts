import { pool } from "@/lib/db/client";
import { FlexiblePostgresRateLimitStore, hashRateLimitIdentity, type RateLimitStore } from "@/lib/security/rate-limit";

const scope = "ai_platform_day";
const daySeconds = 86400;
let store: RateLimitStore | undefined;

export function platformDailyLimit(): number {
  const value = process.env.PLATFORM_AI_DAILY_REQUEST_LIMIT?.trim();
  const limit = value ? Number(value) : 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) {
    throw new Error("PLATFORM_AI_DAILY_REQUEST_LIMIT must be an integer between 1 and 1000000.");
  }
  return limit;
}

export class PlatformQuotaError extends Error {
  readonly name = "PlatformQuotaError";
  constructor(
    readonly code: "PLATFORM_AI_QUOTA_EXCEEDED" | "PLATFORM_AI_QUOTA_UNAVAILABLE",
    readonly status: 429 | 503,
    readonly retryAfterSeconds: number,
  ) {
    super(code === "PLATFORM_AI_QUOTA_EXCEEDED" ? "Today's platform AI quota is used up. Add your own key or try again tomorrow." : "Platform AI quota is temporarily unavailable. Please retry later.");
  }
}

export function isPlatformQuotaError(error: unknown): error is PlatformQuotaError {
  return typeof error === "object" && error !== null && "name" in error && error.name === "PlatformQuotaError"
    && "code" in error && (error.code === "PLATFORM_AI_QUOTA_EXCEEDED" || error.code === "PLATFORM_AI_QUOTA_UNAVAILABLE");
}

/** One allowance per tutor execution, shared across providers; resets at UTC midnight. */
export async function consumePlatformQuota(userId: string, deps: { store?: RateLimitStore; now?: Date; secret?: string } = {}) {
  const now = deps.now ?? new Date();
  let result;
  let limit;
  try {
    limit = platformDailyLimit();
    const selectedStore = deps.store ?? (store ??= new FlexiblePostgresRateLimitStore(pool));
    result = await selectedStore.consume({
      scope, keyHash: hashRateLimitIdentity(scope, "user", userId, deps.secret),
      limit, windowSeconds: daySeconds, now,
    });
  } catch {
    throw new PlatformQuotaError("PLATFORM_AI_QUOTA_UNAVAILABLE", 503, 30);
  }
  if (result.count > limit) {
    throw new PlatformQuotaError("PLATFORM_AI_QUOTA_EXCEEDED", 429, Math.max(1, Math.ceil((result.resetAt.getTime() - now.getTime()) / 1000)));
  }
}

/** Count admitted attempts, including provider outages; rejected retries are excluded. */
export async function todayPlatformUsage(queryable: Pick<typeof pool, "query"> = pool, now = new Date()) {
  const dailyLimit = platformDailyLimit();
  const start = Math.floor(now.getTime() / (daySeconds * 1000)) * daySeconds * 1000;
  const result = await queryable.query(
    "SELECT COALESCE(SUM(LEAST(points, $1)), 0)::text AS count FROM api_rate_limit WHERE key LIKE $2",
    [dailyLimit, `${scope}:%:${start}`],
  );
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid platform usage counter.");
  return { count, date: new Date(start).toISOString().slice(0, 10), dailyLimit };
}
