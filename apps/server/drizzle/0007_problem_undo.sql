CREATE TABLE "problem_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"problem_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"prior" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_receipts" ADD CONSTRAINT "problem_receipts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every change of the state an Undo restores moves the version on, whatever makes it: a person, ingest, housekeeping,
-- Telegram or a merge. So does every new occurrence (count, first and last seen), from ingest or a merge into the
-- problem: an Undo must not put a problem back to resolved or muted over a failure that came after its action. An
-- Undo applies only while the version is the one its action left (FB-16). Kept here rather than in each writer, so a
-- future writer cannot forget it; other updates (the workflow's name) leave it alone.
CREATE FUNCTION "problems_bump_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.regression IS DISTINCT FROM OLD.regression
    OR NEW.muted_until IS DISTINCT FROM OLD.muted_until
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.merged_into IS DISTINCT FROM OLD.merged_into
    OR NEW.count IS DISTINCT FROM OLD.count
    OR NEW.first_seen IS DISTINCT FROM OLD.first_seen
    OR NEW.last_seen IS DISTINCT FROM OLD.last_seen THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "problems_bump_version" BEFORE UPDATE ON "problems"
  FOR EACH ROW EXECUTE FUNCTION "problems_bump_version"();