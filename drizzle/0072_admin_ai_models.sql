ALTER TABLE "public"."provider_policy" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD COLUMN "platform_credential" jsonb;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD COLUMN "configuration_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD COLUMN "verification_status" text DEFAULT 'untested' NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD COLUMN "verified_reported_model" text;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD CONSTRAINT "provider_policy_connection_check" CHECK ("public"."provider_policy"."configuration_version" >= 0 AND ("public"."provider_policy"."base_url" IS NULL OR "public"."provider_policy"."base_url" LIKE 'https://%') AND ("public"."provider_policy"."platform_credential" IS NULL OR ("public"."provider_policy"."operation" = 'provider_configuration' AND jsonb_typeof("public"."provider_policy"."platform_credential") = 'object')));--> statement-breakpoint
ALTER TABLE "public"."provider_policy" ADD CONSTRAINT "provider_policy_verification_check" CHECK (("public"."provider_policy"."verification_status" = 'untested' AND "public"."provider_policy"."verified_at" IS NULL) OR ("public"."provider_policy"."verification_status" = 'verified' AND "public"."provider_policy"."verified_at" IS NOT NULL));
