CREATE TABLE "backup_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"version_id" text,
	"retain_until" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location" jsonb NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention" jsonb NOT NULL,
	"object_lock" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_destinations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "instance_backup_destinations" (
	"instance_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_backup_destinations_instance_id_destination_id_pk" PRIMARY KEY("instance_id","destination_id")
);
--> statement-breakpoint
ALTER TABLE "backup_runs" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "upload_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "spooled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "backup_destinations" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_copies" ADD CONSTRAINT "backup_copies_run_id_backup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_copies" ADD CONSTRAINT "backup_copies_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_backup_destinations" ADD CONSTRAINT "instance_backup_destinations_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_backup_destinations" ADD CONSTRAINT "instance_backup_destinations_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_copies_run_destination_idx" ON "backup_copies" USING btree ("run_id","destination_id");--> statement-breakpoint
CREATE INDEX "backup_copies_destination_idx" ON "backup_copies" USING btree ("destination_id","status");--> statement-breakpoint
-- Data. The S3 storage of Settings > Backup Storage becomes the first destination, and every archive written
-- there becomes a copy on it under its exact key. Its retention is, per field, the largest of the global
-- default and every instance override, so no instance keeps fewer archives than before. Nothing is deleted.
-- Migrations run in one transaction: a failure here leaves the database as it was.
DO $migrate$
DECLARE
  s jsonb := COALESCE((SELECT value FROM settings WHERE key = 'storage'), '{}'::jsonb);
  d jsonb := COALESCE((SELECT value FROM settings WHERE key = 'defaults'), '{}'::jsonb);
  complete boolean;
  has_archives boolean := EXISTS (SELECT 1 FROM backup_runs WHERE object_key IS NOT NULL);
  keep_daily integer;
  keep_weekly integer;
  keep_monthly integer;
  destination uuid;
  overridden jsonb;
BEGIN
  complete := COALESCE(s->>'bucket', '') <> '' AND COALESCE(s->>'accessKeyId', '') <> ''
    AND COALESCE(s->>'secretAccessKeyEnc', '') <> '';
  SELECT
    GREATEST(COALESCE((d->>'retentionDaily')::int, 7), COALESCE(MAX((overrides->>'retentionDaily')::int), 0)),
    GREATEST(COALESCE((d->>'retentionWeekly')::int, 4), COALESCE(MAX((overrides->>'retentionWeekly')::int), 0)),
    GREATEST(COALESCE((d->>'retentionMonthly')::int, 6), COALESCE(MAX((overrides->>'retentionMonthly')::int), 0))
  INTO keep_daily, keep_weekly, keep_monthly
  FROM instances;
  SELECT jsonb_agg(jsonb_build_object(
      'instance', name,
      'daily', overrides->'retentionDaily',
      'weekly', overrides->'retentionWeekly',
      'monthly', overrides->'retentionMonthly'))
  INTO overridden
  FROM instances
  WHERE overrides ?| ARRAY['retentionDaily', 'retentionWeekly', 'retentionMonthly'];

  -- A backup running during the upgrade cannot finish under the new rules; it counts as failed.
  UPDATE backup_runs SET status = 'failed', error = 'Interrupted by the upgrade to backup destinations.',
    finished_at = now()
  WHERE status = 'running';

  IF COALESCE(s->>'bucket', '') <> '' OR has_archives THEN
    -- Incomplete settings stay visible with their history, but off; their place can still be corrected.
    INSERT INTO backup_destinations (name, kind, location, credentials, retention, enabled, is_default, locked_at)
    VALUES (
      CASE WHEN complete THEN 'S3' ELSE 'S3 (incomplete settings)' END,
      's3',
      jsonb_build_object(
        'endpoint', COALESCE(s->>'endpoint', ''),
        'region', COALESCE(NULLIF(s->>'region', ''), 'us-east-1'),
        'bucket', COALESCE(s->>'bucket', ''),
        'prefix', btrim(COALESCE(s->>'prefix', 'n8n-ops'), '/'),
        'forcePathStyle', COALESCE((s->>'forcePathStyle')::boolean, true)
      ),
      jsonb_strip_nulls(jsonb_build_object(
        'accessKeyId', NULLIF(s->>'accessKeyId', ''),
        'secretAccessKeyEnc', NULLIF(s->>'secretAccessKeyEnc', '')
      )),
      jsonb_build_object('daily', keep_daily, 'weekly', keep_weekly, 'monthly', keep_monthly),
      complete,
      complete,
      CASE WHEN complete THEN now() END
    )
    RETURNING id INTO destination;

    INSERT INTO backup_copies (run_id, destination_id, object_key, status, legacy, created_at, finished_at, deleted_at)
    SELECT id, destination, object_key, CASE WHEN status = 'ok' THEN 'ok' ELSE 'failed' END, true, started_at,
      finished_at, deleted_at
    FROM backup_runs
    WHERE object_key IS NOT NULL;

    INSERT INTO audit_log (actor, action, target, via, details)
    VALUES ('n8n-ops', 'Backup storage became a destination',
      CASE WHEN complete THEN 'S3' ELSE 'S3 (incomplete settings)' END, 'upgrade', jsonb_build_object(
        'complete', complete,
        'retention', jsonb_build_object('daily', keep_daily, 'weekly', keep_weekly, 'monthly', keep_monthly),
        'previousDefaults', jsonb_build_object('daily', d->'retentionDaily', 'weekly', d->'retentionWeekly',
          'monthly', d->'retentionMonthly'),
        'previousOverrides', COALESCE(overridden, '[]'::jsonb)
      ));
  END IF;

  -- Retention now belongs to each destination.
  UPDATE settings SET value = value - 'retentionDaily' - 'retentionWeekly' - 'retentionMonthly'
  WHERE key = 'defaults';
  UPDATE instances SET overrides = overrides - 'retentionDaily' - 'retentionWeekly' - 'retentionMonthly'
  WHERE overrides ?| ARRAY['retentionDaily', 'retentionWeekly', 'retentionMonthly'];
  DELETE FROM settings WHERE key = 'storage';
  -- Stale-backup alerts were per instance; now they are per instance and destination, and start afresh.
  DELETE FROM alert_state WHERE key ~ '^backup:[0-9a-f-]{36}$';
END
$migrate$;