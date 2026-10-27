ALTER TABLE "backup_runs" ADD COLUMN "refusal" jsonb;--> statement-breakpoint
ALTER TABLE "worker_pairing_tokens" ADD COLUMN "install" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "install" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "allowed" jsonb;