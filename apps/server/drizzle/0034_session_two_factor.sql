ALTER TABLE "auth_session" ADD COLUMN "two_factor_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- No device skips the two-factor code: trusted-device records Better Auth kept are removed.
DELETE FROM "auth_verification" WHERE "identifier" LIKE 'trust-device-%';
