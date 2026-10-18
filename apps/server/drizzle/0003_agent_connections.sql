CREATE TABLE "oauth_store" (
	"type" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_store_type_id_pk" PRIMARY KEY("type","id")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "grant_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "connected_via" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "redirect_host" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "end_reason" text;--> statement-breakpoint
CREATE INDEX "oauth_store_grant_idx" ON "oauth_store" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_store_user_code_idx" ON "oauth_store" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauth_store_uid_idx" ON "oauth_store" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "oauth_store_expires_idx" ON "oauth_store" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_grant_id_unique" UNIQUE("grant_id");