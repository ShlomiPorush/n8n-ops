import type { Context, Next } from "hono"

const BEARER_PATHS = /^(\/api\/v1(\/|$)|\/mcp(\/|$)|\/api\/worker(\/|$)|\/n8n(\/|$)|\/oauth\/|\/\.well-known\/)/

export async function agentGuard(c: Context, next: Next) {
  const auth = c.req.header("authorization")
  if (auth !== undefined && /bearer/i.test(auth) && !BEARER_PATHS.test(c.req.path))
    return c.json({ error: "forbidden", message: "Agent tokens are taken only on /api/v1 and /mcp." }, 403)
  await next()
}
