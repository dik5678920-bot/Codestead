-- Upgrade with the application stopped; carry all counters forward before
-- removing the old layout. The lock prevents a consume racing the copy.
LOCK TABLE "public"."api_rate_limit_window" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "public"."api_rate_limit" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 1 NOT NULL,
	"expire" bigint NOT NULL,
	CONSTRAINT "api_rate_limit_key_check" CHECK ("public"."api_rate_limit"."key" ~ '^[a-z][a-z0-9_]{0,99}:[0-9a-f]{64}:-?[0-9]{1,16}$'),
	CONSTRAINT "api_rate_limit_points_check" CHECK ("public"."api_rate_limit"."points" BETWEEN 1 AND 1000001),
	CONSTRAINT "api_rate_limit_expiry_check" CHECK ("public"."api_rate_limit"."expire" > split_part("public"."api_rate_limit"."key", ':', 3)::bigint)
);
--> statement-breakpoint
INSERT INTO "public"."api_rate_limit" ("key", "points", "expire")
SELECT scope || ':' || key_hash || ':' ||
       (extract(epoch FROM window_start) * 1000)::bigint::text,
       request_count,
       (extract(epoch FROM expires_at) * 1000)::bigint
FROM "public"."api_rate_limit_window";
--> statement-breakpoint
DROP TABLE "public"."api_rate_limit_window";--> statement-breakpoint
CREATE INDEX "api_rate_limit_expiry_idx" ON "public"."api_rate_limit" USING btree ("expire");
