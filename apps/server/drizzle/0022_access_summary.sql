ALTER TABLE "access_requests" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "access_requests" SET "call_count" = (SELECT count(*) FROM "access_calls" WHERE "access_calls"."request_id" = "access_requests"."id");
