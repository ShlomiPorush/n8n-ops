CREATE TABLE "db_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"relation_id" bigint NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"size_before" bigint,
	"size_after" bigint,
	"error" text,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
