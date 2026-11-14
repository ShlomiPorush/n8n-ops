import type { Context, Next } from "hono"

/**
 * Where a Bearer token is taken, each with its own check: the agent routes (/api/v1, /mcp), the Worker API (its own
 * token), the access proxy (a temporary key), and the authorization server's endpoints. The console's routes take
 * only a browser session.
 */
const BEARER_PATHS = /^(\/api\/v1(\/|$)|\/mcp(\/|$)|\/api\/worker(\/|$)|\/n8n(\/|$)|\/oauth\/|\/\.well-known\/)/

/**
 * A request whose Authorization header names Bearer (also a malformed one) is an agent's or a program's. Anywhere
 * else than the paths above it is refused before any route runs, so it never acts through a browser session it may
 * also carry, nor keeps one alive (the agent-access standard, REST channel).
 */
export async function agentGuard(c: Context, next: Next) {
  const auth = c.req.header("authorization")
  if (auth !== undefined && /bearer/i.test(auth) && !BEARER_PATHS.test(c.req.path))
    return c.json({ error: "forbidden", message: "Agent tokens are taken only on /api/v1 and /mcp." }, 403)
  await next()
}
