-- n8n-ops has exactly one account, and from here the database refuses a second one. An installation that holds more
-- than one stops here with a message instead of choosing or deleting an account itself; the upgrade runs once the
-- accounts that are not the operator's are deleted.
DO $$
DECLARE
  accounts bigint;
BEGIN
  SELECT count(*) INTO accounts FROM "auth_user";
  IF accounts > 1 THEN
    RAISE EXCEPTION 'n8n-ops has exactly one account, but this installation holds % accounts. Delete the accounts that are not the operator''s from auth_user, then start n8n-ops again.', accounts;
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_single" ON "auth_user" USING btree ((true));
