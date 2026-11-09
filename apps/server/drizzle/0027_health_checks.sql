CREATE TABLE "health_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"via" text NOT NULL,
	"source" text,
	"mode" text NOT NULL,
	"alert_after" integer NOT NULL,
	"main_ok" boolean,
	"main_status" integer,
	"main_ms" integer,
	"readiness_ok" boolean,
	"readiness_ms" integer,
	"failure_kind" text,
	"code" text,
	"error" text,
	"alert_queued" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_checks_instance_checked_idx" ON "health_checks" USING btree ("instance_id","checked_at");