CREATE TABLE "affected_workflow_aliases" (
	"old_id" uuid NOT NULL,
	"new_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "affected_workflow_aliases_old_id_new_id_pk" PRIMARY KEY("old_id","new_id")
);
--> statement-breakpoint
CREATE TABLE "problem_regroups" (
	"old_problem_id" uuid NOT NULL,
	"new_problem_id" uuid NOT NULL,
	"rows" integer NOT NULL,
	CONSTRAINT "problem_regroups_old_problem_id_new_problem_id_pk" PRIMARY KEY("old_problem_id","new_problem_id")
);
--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "target_key" text;--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "target_source" text;--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "affected_workflows" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "alert_groups" ADD COLUMN "before_regroup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "target_key" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "target_source" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "regrouped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "affected_workflow_aliases" ADD CONSTRAINT "affected_workflow_aliases_new_id_affected_workflows_id_fk" FOREIGN KEY ("new_id") REFERENCES "public"."affected_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_regroups" ADD CONSTRAINT "problem_regroups_old_problem_id_problems_id_fk" FOREIGN KEY ("old_problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_regroups" ADD CONSTRAINT "problem_regroups_new_problem_id_problems_id_fk" FOREIGN KEY ("new_problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;