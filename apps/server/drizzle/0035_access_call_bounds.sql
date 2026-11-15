ALTER TABLE "access_calls" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_calls" ADD COLUMN "change" boolean GENERATED ALWAYS AS (method NOT IN ('GET', 'HEAD', 'OPTIONS') AND refused IS NULL) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "refused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "access_calls_request_change_idx" ON "access_calls" USING btree ("request_id","change","created_at");--> statement-breakpoint
-- A change whose answer never came was recorded as refused, with the text also used when n8n-ops could not read the
-- instance's API description and sent nothing. Either way it may have changed n8n, so it becomes a change with no
-- answer. The Telegram message of an ended request whose refused count this changes is edited again.
WITH unanswered AS (
  UPDATE "access_calls" SET "status" = NULL, "refused" = NULL
  WHERE "method" NOT IN ('GET', 'HEAD', 'OPTIONS') AND "refused" = 'The n8n instance did not answer.'
  RETURNING "request_id"
)
UPDATE "access_requests" SET "telegram_closed_at" = NULL
WHERE "id" IN (SELECT "request_id" FROM unanswered)
  AND "telegram_message_id" IS NOT NULL
  AND "status" IN ('released', 'expired', 'revoked');--> statement-breakpoint
-- The refused calls are counted before only the latest other calls are kept.
UPDATE "access_requests" SET "refused_count" = refused.n
FROM (
  SELECT "request_id", count(*)::int AS n FROM "access_calls" WHERE "refused" IS NOT NULL GROUP BY "request_id"
) refused
WHERE refused."request_id" = "access_requests"."id";--> statement-breakpoint
-- Of the other calls of each request (refused calls and reads), the latest 500 are kept; changes all stay.
DELETE FROM "access_calls" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "request_id" ORDER BY "created_at" DESC, "id" DESC) AS n
    FROM "access_calls" WHERE NOT "change"
  ) ranked
  WHERE ranked.n > 500
);--> statement-breakpoint
-- A path is kept to its first 1,024 characters and a refusal reason to its first 500, ending with "…".
UPDATE "access_calls" SET "path" = left("path", 1023) || '…' WHERE char_length("path") > 1024;--> statement-breakpoint
UPDATE "access_calls" SET "refused" = left("refused", 499) || '…' WHERE char_length("refused") > 500;
