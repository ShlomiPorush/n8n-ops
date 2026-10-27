ALTER TABLE "instances" ADD COLUMN "last_known_health" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "last_known_at" timestamp with time zone;--> statement-breakpoint
-- The health stored so far is the last known health, unless it was never read or the last check was not collected.
UPDATE "instances" SET "last_known_health" = "health", "last_known_at" = "health_checked_at" WHERE "health" <> 'unknown';