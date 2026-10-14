CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_key" text NOT NULL,
	"telegram_message_id" integer NOT NULL,
	"problem_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"group_key" text,
	"problem_id" uuid,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"telegram_message_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"via" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid,
	"status" text NOT NULL,
	"includes_secrets" boolean DEFAULT false NOT NULL,
	"workflows" integer,
	"credentials" integer,
	"size_bytes" integer,
	"sha256" text,
	"object_key" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"problem_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"execution_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"mode" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"error" jsonb,
	"node_input" jsonb,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"container_name" text,
	"worker_id" uuid,
	"queue_mode" boolean DEFAULT false NOT NULL,
	"metrics_url" text,
	"worker_health_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collection" text DEFAULT 'direct' NOT NULL,
	"version" text,
	"scopes" jsonb,
	"scopes_source" text DEFAULT 'discovered' NOT NULL,
	"declared_access" text,
	"scopes_checked_at" timestamp with time zone,
	"health" text DEFAULT 'unknown' NOT NULL,
	"health_detail" jsonb,
	"health_checked_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"last_poll_error" text,
	"first_sync_done" boolean DEFAULT false NOT NULL,
	"execution_cursor" text,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_instance_id" uuid NOT NULL,
	"target_instance_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"new_workflow_id" text,
	"status" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_pairing_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"node_name" text NOT NULL,
	"error_message" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"muted_until" timestamp with time zone,
	"regression" boolean DEFAULT false NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"username" text,
	"display_username" text,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"instance_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workers_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"instance_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_detail" text DEFAULT '' NOT NULL,
	"structure_hash" text NOT NULL,
	"node_count" integer NOT NULL,
	"credential_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"called_workflow_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"runs_30d" integer DEFAULT 0 NOT NULL,
	"errors_30d" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_instance_id_workflow_id_pk" PRIMARY KEY("instance_id","workflow_id")
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failures" ADD CONSTRAINT "failures_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failures" ADD CONSTRAINT "failures_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_two_factor" ADD CONSTRAINT "auth_two_factor_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_jobs" ADD CONSTRAINT "worker_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_jobs" ADD CONSTRAINT "worker_jobs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_outbox_pending_idx" ON "alert_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "backup_runs_instance_idx" ON "backup_runs" USING btree ("instance_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "failures_execution_idx" ON "failures" USING btree ("instance_id","execution_id");--> statement-breakpoint
CREATE INDEX "failures_problem_idx" ON "failures" USING btree ("problem_id");--> statement-breakpoint
CREATE INDEX "failures_created_idx" ON "failures" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "problems_fingerprint_idx" ON "problems" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "problems_status_idx" ON "problems" USING btree ("status");--> statement-breakpoint
CREATE INDEX "problems_instance_idx" ON "problems" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "auth_two_factor_secret_idx" ON "auth_two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "auth_two_factor_user_idx" ON "auth_two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "worker_jobs_queue_idx" ON "worker_jobs" USING btree ("worker_id","status");--> statement-breakpoint
CREATE INDEX "workflows_hash_idx" ON "workflows" USING btree ("structure_hash");