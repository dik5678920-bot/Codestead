import { afterAll, expect, it } from "vitest";
import { pool } from "@/lib/db/client";

afterAll(async () => { await pool.end(); });

// The spent-budget replay runs inside the validated helper's migration contract.
// This catalog probe uses application authority only.
it("0071 installs the library counter and removes the old layout", async () => {
  const tables = await pool.query("SELECT to_regclass('public.api_rate_limit') AS current, to_regclass('public.api_rate_limit_window') AS old");
  expect(tables.rows).toEqual([{ current: "api_rate_limit", old: null }]);
  const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='api_rate_limit' ORDER BY ordinal_position");
  expect(columns.rows.map(row => row.column_name)).toEqual(["key", "points", "expire"]);
});
