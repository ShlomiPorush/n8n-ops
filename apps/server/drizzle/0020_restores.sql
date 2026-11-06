CREATE TABLE "restores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"actor" text NOT NULL,
	"via" text NOT NULL,
	"run_id" uuid,
	"target_instance_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"reviewed" jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "restores_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_run_id_backup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backup_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_target_instance_id_instances_id_fk" FOREIGN KEY ("target_instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restores_target_idx" ON "restores" USING btree ("target_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "restores_status_idx" ON "restores" USING btree ("status","created_at");