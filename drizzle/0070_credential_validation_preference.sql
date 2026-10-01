ALTER TYPE "public"."credential_status" ADD VALUE 'unreachable' BEFORE 'disabled';--> statement-breakpoint
-- The application has one preference across providers. Keep the most recently
-- changed preferred row, breaking ties by creation time and UUID. Stored key
-- envelopes and legacy validation statuses remain unchanged.
LOCK TABLE "provider_credential" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id"
    ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
  ) AS preference_rank
  FROM "provider_credential"
  WHERE "is_preferred" = true
)
UPDATE "provider_credential" AS credential
SET "is_preferred" = false,
    "updated_at" = greatest(clock_timestamp(), credential."updated_at" + interval '1 microsecond')
FROM ranked
WHERE credential."id" = ranked."id" AND ranked.preference_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_one_preferred_per_user_idx" ON "provider_credential" USING btree ("user_id") WHERE "provider_credential"."is_preferred" = true;
