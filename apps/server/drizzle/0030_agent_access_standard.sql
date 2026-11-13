CREATE TABLE "agent_consent" (
	"key" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"session_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"issuer" text
);
--> statement-breakpoint
CREATE INDEX "agent_consent_created_idx" ON "agent_consent" USING btree ("created_at");--> statement-breakpoint
-- The one state row. The issuer is learned at the next start (oauth/agents.ts reconcile), without ending anything.
INSERT INTO "agent_state" ("id", "generation", "issuer") VALUES (1, 0, NULL);
--> statement-breakpoint
-- Access tokens, refresh tokens and authorization codes are kept by the SHA-256 of their value only, without the
-- value in the payload (oauth/store.ts). Existing ones are converted in place, so no connection ends.
UPDATE "oauth_store" SET "id" = encode(sha256(convert_to("id", 'UTF8')), 'hex'), "payload" = "payload" - 'jti'
WHERE "type" IN ('AccessToken', 'RefreshToken', 'AuthorizationCode');
--> statement-breakpoint
-- Agents stay on in an installation that already has its account; a new installation starts with them off.
INSERT INTO "settings" ("key", "value") SELECT 'agents', '{"enabled": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "auth_user") ON CONFLICT ("key") DO NOTHING;
