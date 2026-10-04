CREATE TABLE "public"."auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_count_check" CHECK ("public"."auth_rate_limit"."count" >= 0),
	CONSTRAINT "auth_rate_limit_last_request_check" CHECK ("public"."auth_rate_limit"."last_request" >= 0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limit_key_unique" ON "public"."auth_rate_limit" USING btree ("key");
--> statement-breakpoint
CREATE INDEX "auth_rate_limit_last_request_idx" ON "public"."auth_rate_limit" USING btree ("last_request");
