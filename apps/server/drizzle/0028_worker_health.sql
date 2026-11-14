CREATE TABLE "history_marks" (
	"key" text PRIMARY KEY NOT NULL,
	"before" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_recording" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"alive_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_beats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"boot_id" text NOT NULL,
	"seq" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"uptime_sec" double precision NOT NULL,
	"rtt_ms" integer,
	"rtt_at" timestamp with time zone,
	"failed_calls" integer,
	"last_call_error" text,
	"docker_checked_at" timestamp with time zone,
	"docker_ok" boolean,
	"docker_ms" integer,
	"docker_error" text,
	"docker_checks" integer,
	"docker_failed" integer
);
--> statement-breakpoint
CREATE TABLE "worker_offline" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"from" timestamp with time zone NOT NULL,
	"to" timestamp with time zone NOT NULL,
	"job" jsonb
);
--> statement-breakpoint
ALTER TABLE "worker_beats" ADD CONSTRAINT "worker_beats_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_offline" ADD CONSTRAINT "worker_offline_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_beats_boot_seq_idx" ON "worker_beats" USING btree ("worker_id","boot_id","seq");--> statement-breakpoint
CREATE INDEX "worker_beats_worker_received_idx" ON "worker_beats" USING btree ("worker_id","received_at");--> statement-breakpoint
CREATE INDEX "worker_offline_worker_to_idx" ON "worker_offline" USING btree ("worker_id","to");