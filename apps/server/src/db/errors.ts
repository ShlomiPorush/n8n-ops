/**
 * Turns a failure to reach or sign in to PostgreSQL at startup into a sentence that says what
 * happened and what to do, instead of a stack trace. Returns null for any other error.
 */
export function describeDatabaseError(error: unknown, databaseUrl: string): string | null {
  const code = errorCode(error)
  if (!code) return null
  const { user, host, port, database } = parts(databaseUrl)
  switch (code) {
    case "28P01":
      return (
        `PostgreSQL refused the password for user "${user}". Changing the password in .env does not change ` +
        `it in a database that already exists. Set it to the one in .env: ` +
        `docker compose exec postgres psql -U ${user} -d ${database}, then \\password ${user}.`
      )
    case "28000":
      // Also a pg_hba.conf rule or a required client certificate, so the user may well exist.
      return (
        `PostgreSQL refused user "${user}" before checking a password. Check POSTGRES_USER and DATABASE_URL ` +
        `in .env, and the database's authentication rules.`
      )
    case "3D000":
      return `PostgreSQL has no database "${database}". Check POSTGRES_DB and DATABASE_URL in .env.`
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "CONNECT_TIMEOUT":
      return (
        `Cannot reach PostgreSQL at ${host}:${port} (${code}). Check that the postgres service is running ` +
        `and that DATABASE_URL in .env points to it.`
      )
    default:
      return null
  }
}

/** The first error code along the cause chain (postgres.js sets it on the cause of a query error). */
function errorCode(error: unknown): string | null {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string" && code) return code
  }
  return null
}

function parts(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl)
    return {
      user: decodeURIComponent(url.username) || "postgres",
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    }
  } catch {
    return { user: "?", host: "?", port: "?", database: "?" }
  }
}
