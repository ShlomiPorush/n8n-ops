CREATE TABLE "access_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"refused" text
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"workflow_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decide_by" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decided_via" text,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"key_prefix" text,
	"key_hash" text,
	"key_enc" text,
	"key_collected_at" timestamp with time zone,
	CONSTRAINT "access_requests_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_request_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "agent_access" jsonb DEFAULT '{"enabled":false,"scopes":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_calls" ADD CONSTRAINT "access_calls_request_id_access_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_calls_request_idx" ON "access_calls" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "access_requests_status_idx" ON "access_requests" USING btree ("status");