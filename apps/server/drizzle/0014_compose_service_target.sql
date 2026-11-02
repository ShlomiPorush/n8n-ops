ALTER TABLE "instances" ADD COLUMN "compose_project" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "compose_service" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "features" jsonb;