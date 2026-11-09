ALTER TABLE "alert_state" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_state" ADD COLUMN "failing_since" timestamp with time zone;