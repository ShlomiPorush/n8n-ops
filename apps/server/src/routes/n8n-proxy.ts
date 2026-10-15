import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import type { Env } from "../http/types.ts"
import { AccessError, checkCall, grantForKey, instanceSpec, logCall } from "../services/access.ts"

/**
 * The access proxy: /n8n/<instance>/api/v1/... with a temporary key in X-N8N-API-KEY, the same header n8n uses,
 * so n8n API clients work by pointing their base URL here. Every call is checked against the grant and the
 * instance's own API description, forwarded with the instance's key, and recorded on the request.
 */
export function n8nProxyRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.all("/:instance/api/v1/*", async (c) => {
    const header = c.req.header("x-n8n-api-key") ?? ""
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    const grant = await grantForKey(ctx, header || bearer)
    if (!grant) return c.json({ message: "The access key is unknown, expired, released or revoked." }, 401)
    const { request, instance } = grant
    const ref = c.req.param("instance")
    if (ref !== instance.name && ref !== instance.id)
      return c.json({ message: `This key is for ${instance.name}, not ${ref}.` }, 403)

    const url = new URL(c.req.url)
    const prefix = url.pathname.indexOf("/api/v1")
    const path = url.pathname.slice(prefix + "/api/v1".length) || "/"
    const method = c.req.method.toUpperCase()
    const refuse = async (status: number, message: string) => {
      await logCall(ctx, request.id, { method, path, status, refused: message })
      return c.json({ message }, status as 403)
    }

    let ops: Awaited<ReturnType<typeof instanceSpec>>
    try {
      ops = await instanceSpec(ctx, instance)
    } catch (e) {
      return refuse(502, e instanceof AccessError ? e.message : "The n8n instance did not answer.")
    }
    const decision = checkCall(ops, request, method, path, url.searchParams)
    if (!decision.allowed) return refuse(403, decision.reason)

    const apiKey = ctx.secrets.decrypt(instance.apiKeyEnc)
    const target = `${instance.baseUrl.replace(/\/+$/, "")}/api/v1${path}${url.search}`
    const n8n = (m: string, u: string, body?: ArrayBuffer) =>
      fetch(u, {
        method: m,
        headers: {
          "X-N8N-API-KEY": apiKey,
          accept: c.req.header("accept") ?? "application/json",
          ...(body ? { "content-type": c.req.header("content-type") ?? "application/json" } : {}),
        },
        body,
        signal: AbortSignal.timeout(60_000),
      })

    // An execution of a limited grant must belong to one of its workflows; ask n8n first.
    if (decision.executionId) {
      const check = await n8n(
        "GET",
        `${instance.baseUrl.replace(/\/+$/, "")}/api/v1/executions/${decision.executionId}`,
      )
      const execution = check.ok ? ((await check.json()) as { workflowId?: string }) : null
      if (!execution?.workflowId || !request.workflowIds.includes(execution.workflowId))
        return refuse(403, `Execution ${decision.executionId} is not of a workflow in this access.`)
    }

    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
    let res: Response
    try {
      res = await n8n(method, target, body)
    } catch {
      return refuse(502, "The n8n instance did not answer.")
    }

    if (decision.workflowFilter && res.ok) {
      const data = (await res.json()) as { data?: { id: string }[]; nextCursor?: string | null }
      const allowed = new Set(request.workflowIds)
      await logCall(ctx, request.id, { method, path, status: res.status })
      return c.json({ ...data, data: (data.data ?? []).filter((w) => allowed.has(w.id)) }, res.status as 200)
    }
    await logCall(ctx, request.id, { method, path, status: res.status })
    const headers = new Headers()
    const type = res.headers.get("content-type")
    if (type) headers.set("content-type", type)
    const disposition = res.headers.get("content-disposition")
    if (disposition) headers.set("content-disposition", disposition)
    return new Response(res.body, { status: res.status, headers })
  })
  app.all("/*", (c) => c.json({ message: "Use /n8n/<instance>/api/v1/... with the key in X-N8N-API-KEY." }, 404))
  return app
}
