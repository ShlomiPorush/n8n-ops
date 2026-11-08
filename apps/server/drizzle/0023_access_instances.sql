CREATE TABLE "access_request_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"instance_id" uuid,
	"instance_name" text NOT NULL,
	"position" integer NOT NULL,
	"requested_scopes" jsonb,
	"requested_workflow_ids" jsonb,
	"scopes" jsonb NOT NULL,
	"workflow_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workflow_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"dropped_reason" text,
	"dropped_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_calls" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "requested_minutes" integer;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_request_instances" ADD CONSTRAINT "access_request_instances_request_id_access_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request_instances" ADD CONSTRAINT "access_request_instances_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_request_instances_position_idx" ON "access_request_instances" USING btree ("request_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "access_request_instances_instance_idx" ON "access_request_instances" USING btree ("request_id","instance_id") WHERE "access_request_instances"."instance_id" is not null;--> statement-breakpoint
CREATE INDEX "access_request_instances_instance_ref_idx" ON "access_request_instances" USING btree ("instance_id");--> statement-breakpoint
ALTER TABLE "access_calls" ADD CONSTRAINT "access_calls_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "access_request_instances" ("request_id", "instance_id", "instance_name", "position", "requested_scopes", "requested_workflow_ids", "scopes", "workflow_ids", "workflow_names", "included")
SELECT r."id", r."instance_id", i."name", 0, r."scopes", r."workflow_ids", r."scopes", r."workflow_ids", r."workflow_names", true
FROM "access_requests" r JOIN "instances" i ON i."id" = r."instance_id";--> statement-breakpoint
UPDATE "access_calls" SET "instance_id" = r."instance_id" FROM "access_requests" r WHERE r."id" = "access_calls"."request_id";--> statement-breakpoint
UPDATE "access_requests" SET "requested_minutes" = "minutes";
