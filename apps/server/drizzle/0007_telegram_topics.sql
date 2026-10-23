ALTER TABLE "alert_groups" ADD COLUMN "thread_id" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "sent_thread_id" integer;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_outbox" ADD COLUMN "thread_id" integer;