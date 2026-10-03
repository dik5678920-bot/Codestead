import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";
import { expect, it } from "vitest";

it("0071 carries spent budgets and expiry forward before deleting the old counter", async () => {
  if (process.env.INTEGRATION_TEST !== "1"
    || !/\/learncoding_integration(?:\?|$)/.test(process.env.DATABASE_OWNER_URL ?? "")) {
    throw new Error("Rate-limit migration test requires the disposable integration database.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_OWNER_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Roll back the entire probe so the already-migrated disposable catalog is restored.
    await client.query("DROP TABLE public.api_rate_limit");
    await client.query("SET LOCAL search_path = public");
    await client.query(`CREATE TABLE api_rate_limit_window (
      scope text NOT NULL, key_hash text NOT NULL, window_start timestamptz NOT NULL,
      request_count integer NOT NULL, expires_at timestamptz NOT NULL,
      PRIMARY KEY (scope, key_hash, window_start)
    ); CREATE INDEX api_rate_limit_expiry_idx ON api_rate_limit_window (expires_at)`);
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const expiry = start + 120_000;
    await client.query(`INSERT INTO api_rate_limit_window VALUES ($1, $2, $3, $4, $5)`,
      ["monitoring_envelope_user", "a".repeat(64), new Date(start), 30, new Date(expiry)]);
    await client.query(await readFile("drizzle/0071_rate_limiter_flexible.sql", "utf8"));
    const key = `monitoring_envelope_user:${"a".repeat(64)}:${start}`;
    expect((await client.query("SELECT * FROM api_rate_limit")).rows).toEqual([
      { key, points: 30, expire: String(expiry) },
    ]);
    expect((await client.query("SELECT to_regclass('public.api_rate_limit_window') AS old")).rows)
      .toEqual([{ old: null }]);
    const limiter = new RateLimiterPostgres({
      storeClient: client, storeType: "client", schemaName: "public",
      tableName: "api_rate_limit", tableCreated: true, clearExpiredByTimeout: false,
      keyPrefix: "", points: 30, duration: 60,
    });
    await expect(limiter.consume(key)).rejects.toBeInstanceOf(RateLimiterRes);
    expect((await client.query("SELECT points, expire FROM api_rate_limit")).rows)
      .toEqual([{ points: 31, expire: String(expiry) }]);
    await expect(client.query("INSERT INTO api_rate_limit VALUES ('access_request_email:raw@example.com:0', 1, 1)"))
      .rejects.toMatchObject({ code: "23514" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
