ALTER TABLE "auth_session" ADD COLUMN "authenticated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
-- Sessions open before the upgrade count their maximum length from when they were created.
UPDATE "auth_session" SET "authenticated_at" = "created_at";