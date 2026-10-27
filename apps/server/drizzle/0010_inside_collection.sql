ALTER TABLE "instances" ADD COLUMN "queue_mode_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "collection_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "health_check_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "health_applied_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "backlog_since" timestamp with time zone;