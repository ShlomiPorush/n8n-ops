ALTER TABLE "access_requests" ADD COLUMN "notify_choice" jsonb;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "notify_failed" jsonb DEFAULT '{}'::jsonb NOT NULL;