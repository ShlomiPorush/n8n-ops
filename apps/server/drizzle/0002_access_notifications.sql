ALTER TABLE "access_requests" ADD COLUMN "telegram_message_id" integer;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "telegram_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "notify_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "notify_error" text;