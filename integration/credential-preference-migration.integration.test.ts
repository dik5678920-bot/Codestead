import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/lib/db/client";

afterAll(async () => { await pool.end(); });

// The legacy-row replay lives inside the validated owner helper and runs with
// the existing PostgreSQL migration contract. This probe uses app authority.
describe("credential preference migration catalog", () => {
  it("installs the preference constraint and unreachable outcome", async () => {
    const index = await pool.query(`select indexdef from pg_catalog.pg_indexes
      where schemaname='public' and indexname='credential_one_preferred_per_user_idx'`);
    expect(index.rows[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(index.rows[0]?.indexdef).toContain("WHERE");
    const status = await pool.query(`select enumlabel from pg_catalog.pg_enum
      join pg_catalog.pg_type on pg_type.oid=enumtypid
      join pg_catalog.pg_namespace on pg_namespace.oid=typnamespace
      where nspname='public' and typname='credential_status' and enumlabel='unreachable'`);
    expect(status.rows).toEqual([{ enumlabel: "unreachable" }]);
  });
});
