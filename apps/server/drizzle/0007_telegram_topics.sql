ALTER TABLE "access_requests" ADD COLUMN "telegram_missing_topic" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "thread_id" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "fell_back" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_outbox" ADD COLUMN "thread_id" integer;