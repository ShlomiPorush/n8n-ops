ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_instance_id_instances_id_fk";
--> statement-breakpoint
ALTER TABLE "access_requests" ALTER COLUMN "requested_minutes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" DROP COLUMN "instance_id";--> statement-breakpoint
ALTER TABLE "access_requests" DROP COLUMN "scopes";--> statement-breakpoint
ALTER TABLE "access_requests" DROP COLUMN "workflow_ids";--> statement-breakpoint
ALTER TABLE "access_requests" DROP COLUMN "workflow_names";