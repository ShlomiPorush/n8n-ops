ALTER TABLE "access_requests" ADD COLUMN IF NOT EXISTS "telegram_missing_topic" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN IF NOT EXISTS "thread_id" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN IF NOT EXISTS "fell_back" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_outbox" ADD COLUMN IF NOT EXISTS "thread_id" integer;