-- A Problem becomes one error across workflows and instances (docs/adr/0001). Written by hand: drizzle-kit would drop
-- the columns of "problems" and create "affected_workflows" empty. Every row of "problems" (instance + workflow + node +
-- exact text) becomes an Affected workflow with its id, state, counts and failures, and the rows with the same text are
-- joined under one new Problem. The migrator runs this in one transaction: a failed step leaves the database as it was.

-- 1. Today's rows become Affected workflows, with the names drizzle-kit gives the new table.
ALTER TABLE "problems" RENAME TO "affected_workflows";--> statement-breakpoint
ALTER TABLE "affected_workflows" RENAME CONSTRAINT "problems_pkey" TO "affected_workflows_pkey";--> statement-breakpoint
ALTER TABLE "affected_workflows" RENAME CONSTRAINT "problems_instance_id_instances_id_fk" TO "affected_workflows_instance_id_instances_id_fk";--> statement-breakpoint
ALTER INDEX "problems_fingerprint_idx" RENAME TO "affected_workflows_fingerprint_idx";--> statement-breakpoint
ALTER INDEX "problems_status_idx" RENAME TO "affected_workflows_status_idx";--> statement-breakpoint
ALTER INDEX "problems_instance_idx" RENAME TO "affected_workflows_instance_idx";--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "problem_id" uuid;--> statement-breakpoint
ALTER TRIGGER "problems_bump_version" ON "affected_workflows" RENAME TO "affected_workflows_bump_version";--> statement-breakpoint
ALTER FUNCTION "problems_bump_version"() RENAME TO "affected_workflows_bump_version";--> statement-breakpoint
-- The version also moves when the workflow moves to another Problem (Merge, Split); merges are no longer on this row.
CREATE OR REPLACE FUNCTION "affected_workflows_bump_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.regression IS DISTINCT FROM OLD.regression
    OR NEW.muted_until IS DISTINCT FROM OLD.muted_until
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.problem_id IS DISTINCT FROM OLD.problem_id
    OR NEW.count IS DISTINCT FROM OLD.count
    OR NEW.first_seen IS DISTINCT FROM OLD.first_seen
    OR NEW.last_seen IS DISTINCT FROM OLD.last_seen THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- 2. Failures, outbox rows and Telegram messages now name Affected workflows (the same ids).
ALTER TABLE "failures" RENAME COLUMN "problem_id" TO "affected_workflow_id";--> statement-breakpoint
ALTER TABLE "failures" RENAME CONSTRAINT "failures_problem_id_problems_id_fk" TO "failures_affected_workflow_id_affected_workflows_id_fk";--> statement-breakpoint
ALTER INDEX "failures_problem_idx" RENAME TO "failures_affected_workflow_idx";--> statement-breakpoint
ALTER TABLE "alert_outbox" RENAME COLUMN "problem_id" TO "affected_workflow_id";--> statement-breakpoint
ALTER TABLE "alert_groups" RENAME COLUMN "problem_ids" TO "affected_workflow_ids";--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "problem_id" uuid;--> statement-breakpoint
-- A message sent before this release may list workflows of several Problems: its buttons keep working, but later
-- alerts send a new message instead of editing it.
UPDATE "alert_groups" SET "closed_at" = now() WHERE "closed_at" IS NULL;--> statement-breakpoint
-- Receipts live 15 minutes and describe the old rows; an Undo across the upgrade is not offered.
DELETE FROM "problem_receipts";--> statement-breakpoint
ALTER TABLE "problem_receipts" DROP CONSTRAINT "problem_receipts_problem_id_problems_id_fk";--> statement-breakpoint
ALTER TABLE "problem_receipts" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "problem_receipts" ADD COLUMN "affected_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "problem_receipts" ADD COLUMN "problem_version" integer NOT NULL;--> statement-breakpoint

-- 3. Where each merged row went. The old Merge was not one transaction and "merged_into" had no foreign key, so a
-- chain may be longer than one step, end at a row that is gone, or loop. A row whose walk ends at a row that is not
-- merged was merged into it; any other row is taken as not merged.
CREATE TEMP TABLE "_merge_target" ON COMMIT DROP AS
WITH RECURSIVE "walk"("id", "cur", "path") AS (
  SELECT "id", "merged_into", ARRAY["id"] FROM "affected_workflows" WHERE "merged_into" IS NOT NULL
  UNION ALL
  SELECT w."id", t."merged_into", w."path" || t."id"
  FROM "walk" w JOIN "affected_workflows" t ON t."id" = w."cur"
  WHERE t."merged_into" IS NOT NULL AND NOT (t."id" = ANY(w."path"))
)
SELECT DISTINCT ON (w."id") w."id", t."id" AS "target"
FROM "walk" w LEFT JOIN "affected_workflows" t ON t."id" = w."cur" AND t."merged_into" IS NULL
ORDER BY w."id", cardinality(w."path") DESC;--> statement-breakpoint
UPDATE "affected_workflows" a SET "merged_into" = NULL
FROM "_merge_target" m WHERE m."id" = a."id" AND m."target" IS NULL;--> statement-breakpoint

-- 4. One Problem per exact text over the rows that are not merged, with the fingerprint ingest computes
-- (sha256 of the UTF-8 text, hex). A text that only merged rows have gets no Problem: it is not routed anywhere.
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"error_message" text NOT NULL,
	"fingerprint" text,
	"merged_into" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "problems" ("error_message", "fingerprint", "created_at")
SELECT "error_message", encode(sha256(convert_to("error_message", 'UTF8')), 'hex'), min("created_at")
FROM "affected_workflows" WHERE "merged_into" IS NULL
GROUP BY "error_message";--> statement-breakpoint
UPDATE "affected_workflows" a SET "problem_id" = p."id"
FROM "problems" p
WHERE a."merged_into" IS NULL AND p."fingerprint" = encode(sha256(convert_to(a."error_message", 'UTF8')), 'hex');--> statement-breakpoint
-- A merged row stays with the row it was merged into, in its Problem and in its state, so its next failure is not
-- taken for a Regression (until now it counted on that row).
UPDATE "affected_workflows" a
SET "problem_id" = t."problem_id", "status" = t."status", "regression" = t."regression",
  "muted_until" = t."muted_until", "resolved_at" = t."resolved_at"
FROM "_merge_target" m JOIN "affected_workflows" t ON t."id" = m."target"
WHERE m."id" = a."id";--> statement-breakpoint

-- 5. The old Merge moved a merged row's failures onto its target, which then held failures of other workflows. Each
-- kept failure goes back to the row of its own instance, workflow, node and text (the node read from the stored
-- execution as ingest reads it), and one count moves with it. Counts of failures already past retention cannot be
-- attributed and stay where they are.
CREATE TEMP TABLE "_rehome" ON COMMIT DROP AS
SELECT f."id", f."affected_workflow_id" AS "from_id", r."id" AS "to_id",
  coalesce(f."stopped_at", f."started_at", f."created_at") AS "seen"
FROM "failures" f
JOIN "affected_workflows" r
  ON r."instance_id" = f."instance_id" AND r."workflow_id" = f."workflow_id"
  AND r."error_message" = f."error"->>'message'
  AND r."node_name" = coalesce(
    f."data"->'data'->'resultData'->'error'->'node'->>'name',
    f."data"->'data'->'resultData'->>'lastNodeExecuted',
    'Workflow')
WHERE r."id" <> f."affected_workflow_id";--> statement-breakpoint
UPDATE "failures" f SET "affected_workflow_id" = h."to_id" FROM "_rehome" h WHERE h."id" = f."id";--> statement-breakpoint
UPDATE "affected_workflows" a SET "count" = a."count" + h."n", "last_seen" = greatest(a."last_seen", h."seen")
FROM (SELECT "to_id", count(*)::int AS "n", max("seen") AS "seen" FROM "_rehome" GROUP BY "to_id") h
WHERE h."to_id" = a."id";--> statement-breakpoint
UPDATE "affected_workflows" a SET "count" = greatest(a."count" - h."n", 0)
FROM (SELECT "from_id", count(*)::int AS "n" FROM "_rehome" GROUP BY "from_id") h
WHERE h."from_id" = a."id";--> statement-breakpoint
-- A merge target also took the merged rows' last failure time and, from ingest, their workflow's name. Its last seen
-- comes back from its own kept failures (retention keeps the newest), its name from the workflow list or its own last
-- failure. Its first seen cannot be rebuilt past retention.
UPDATE "affected_workflows" a SET "last_seen" = s."seen"
FROM (
  SELECT f."affected_workflow_id" AS "id", max(coalesce(f."stopped_at", f."started_at", f."created_at")) AS "seen"
  FROM "failures" f
  WHERE f."affected_workflow_id" IN (SELECT "from_id" FROM "_rehome" UNION SELECT "target" FROM "_merge_target")
  GROUP BY f."affected_workflow_id"
) s
WHERE s."id" = a."id";--> statement-breakpoint
UPDATE "affected_workflows" a SET "workflow_name" = coalesce(
  (SELECT w."name" FROM "workflows" w WHERE w."instance_id" = a."instance_id" AND w."workflow_id" = a."workflow_id"),
  (SELECT f."data"->'workflowData'->>'name' FROM "failures" f
    WHERE f."affected_workflow_id" = a."id" AND f."data"->'workflowData'->>'name' IS NOT NULL
    ORDER BY f."created_at" DESC LIMIT 1),
  a."workflow_name")
WHERE a."id" IN (SELECT "from_id" FROM "_rehome" UNION SELECT "target" FROM "_merge_target" WHERE "target" IS NOT NULL);--> statement-breakpoint

-- 6. The final shape.
ALTER TABLE "affected_workflows" DROP COLUMN "merged_into";--> statement-breakpoint
ALTER TABLE "affected_workflows" ALTER COLUMN "problem_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD CONSTRAINT "affected_workflows_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affected_workflows_problem_idx" ON "affected_workflows" USING btree ("problem_id");--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_merged_into_problems_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "problems_fingerprint_idx" ON "problems" USING btree ("fingerprint");--> statement-breakpoint
ALTER TABLE "problem_receipts" ADD CONSTRAINT "problem_receipts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_receipts" ADD CONSTRAINT "problem_receipts_affected_workflow_id_affected_workflows_id_fk" FOREIGN KEY ("affected_workflow_id") REFERENCES "public"."affected_workflows"("id") ON DELETE cascade ON UPDATE no action;
