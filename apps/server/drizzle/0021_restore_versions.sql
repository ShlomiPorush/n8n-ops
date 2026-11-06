ALTER TABLE "restores" ADD COLUMN "before_archive" text;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "before_sha256" text;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "before_taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "from_restore_id" uuid;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_from_restore_id_restores_id_fk" FOREIGN KEY ("from_restore_id") REFERENCES "public"."restores"("id") ON DELETE set null ON UPDATE no action;