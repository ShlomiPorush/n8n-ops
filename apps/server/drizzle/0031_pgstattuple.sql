-- Settings → Database measures free space with PostgreSQL's pgstattuple. It is installed only where the package is
-- available and the role may create it; otherwise the server still starts and the page says why free space is not
-- measured. Any other error fails the migration as usual.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgstattuple') THEN
    RAISE NOTICE 'pgstattuple is not available; free space will not be measured';
    RETURN;
  END IF;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgstattuple;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'the database role may not create pgstattuple; free space will not be measured';
  END;
END
$$;
