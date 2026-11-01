ALTER TABLE "instances" ALTER COLUMN "api_key_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "setup_state" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "chosen_capabilities" jsonb DEFAULT '["health","monitor","map","move","agents","backup","restore"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "backup_via" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "config_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "setup_attempt_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "setup_checks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "scopes_source";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "declared_access";--> statement-breakpoint
-- Existing instances keep every capability, active as before. They backed up through their worker when one was
-- assigned and the main was set (the worker then exported credential secrets), otherwise through the API.
UPDATE "instances" SET "backup_via" = 'worker'
  WHERE "worker_id" IS NOT NULL AND ("container_name" IS NOT NULL OR "compose_project" IS NOT NULL);
