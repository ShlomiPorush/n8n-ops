import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { createMiddleware } from "hono/factory"
import type { Ctx } from "../context.ts"
import type { Env } from "../http/types.ts"
import {
  AccessError,
  checkCall,
  finishChange,
  grantForKey,
  instanceSpec,
  isChange,
  logCall,
  MAX_CHANGES,
  openToAgents,
  refuseChange,
  reserveChange,
} from "../services/access.ts"
import { syncWorkflowsSoon } from "../services/workflows.ts"
import { slots } from "./agent.ts"

/**
 * Whether a call forwarded to n8n changed what the workflow map shows: a write to workflows, tags or executions
 * (deleting or retrying a run changes the counts) that n8n accepted. A refused or failed write changes nothing that
 * is known; the next scheduled refresh reads it anyway.
 */
export function changesWorkflowMap(method: string, path: string, status: number) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  if (status < 200 || status > 299) return false
  return /^\/(workflows|tags|executions)(\/|$)/i.test(path)
}

/**
 * The largest request body the access proxy forwards: n8n's own default limit on a request body
 * (`N8N_PAYLOAD_SIZE_MAX`, 16 MiB).
 */
export const PROXY_BODY_BYTES = 16 * 1024 * 1024

/** A call that passed its access and operation checks, as the step that reads its body and forwards it needs it. */
type Access = Extract<Awaited<ReturnType<typeof accessFor>>, { refused: null }>
type Call = {
  key: string
  ref: string
  request: Access["request"]
  grant: Access["grant"]
  instance: Access["instance"]
  url: URL
  path: string
  method: string
  decision: { workflowFilter?: boolean; executionId?: string }
  refuse: (status: number, message: string) => Promise<Response>
  n8n: (method: string, url: string, body?: ArrayBuffer) => Promise<Response>
}
type ProxyEnv = { Variables: Env["Variables"] & { call: Call } }

/** Calls through the access proxy at once: per access key, and in total. The same numbers as the REST API and MCP. */
export const PROXY_CALLS = { perConnection: 4, total: 16 }
const proxySlotsOf = new WeakMap<Ctx, ReturnType<typeof slots>>()
const proxySlotsFor = (ctx: Ctx) => {
  const found = proxySlotsOf.get(ctx)
  if (found) return found
  const made = slots(PROXY_CALLS)
  proxySlotsOf.set(ctx, made)
  return made
}

/** The access a key gives on the instance a call names, as it stands now, or why it gives none. */
async function accessFor(ctx: Ctx, key: string, ref: string) {
  const found = await grantForKey(ctx, key, ref)
  if (!found) return { refused: 401, message: "The access key is unknown, expired, released or revoked." } as const
  const { request, grant, instance } = found
  if (!grant || !instance) return { refused: 403, message: `This key is not for ${ref}.` } as const
  // Temporary access turned off on the instance (or its key removed) ends every call not yet forwarded through it.
  if (!openToAgents(instance) || !instance.apiKeyEnc)
    return { refused: 403, message: `Temporary access to ${instance.name} is turned off.` } as const
  return { refused: null, request, grant, instance, apiKeyEnc: instance.apiKeyEnc } as const
}

/**
 * The access proxy: /n8n/<instance>/api/v1/... with a temporary key in X-N8N-API-KEY, the same header n8n uses,
 * so n8n API clients work by pointing their base URL here. Every call is checked against the grant and the
 * instance's own API description, forwarded with the instance's key, and recorded on the request. A change (any
 * method but GET, HEAD and OPTIONS) is recorded before it is sent, so it is listed whatever happens next; an access
 * sends at most MAX_CHANGES of them. The access is read again as the last step before a call is forwarded, so a call
 * whose access ended while it was still arriving never reaches n8n. A body is read only once the call passed its
 * checks, and one larger than PROXY_BODY_BYTES is refused (413) and never sent. An access key runs at most
 * PROXY_CALLS.perConnection calls at once, and the proxy PROXY_CALLS.total; more are refused (429) and never sent.
 */
export function n8nProxyRoutes(ctx: Ctx) {
  const app = new Hono<ProxyEnv>()

  /** The access, the operation and the instance's own checks, all before any of the body is read. */
  const allowed = createMiddleware<ProxyEnv>(async (c, next) => {
    const header = c.req.header("x-n8n-api-key") ?? ""
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    const key = header || bearer
    const ref = c.req.param("instance") ?? ""
    const access = await accessFor(ctx, key, ref)
    if (access.refused !== null) return c.json({ message: access.message }, access.refused)
    const { request, grant, instance } = access

    const url = new URL(c.req.url)
    const prefix = url.pathname.indexOf("/api/v1")
    const path = url.pathname.slice(prefix + "/api/v1".length) || "/"
    const method = c.req.method.toUpperCase()
    const refuse = async (status: number, message: string) => {
      await logCall(ctx, request.id, { instanceId: instance.id, method, path, status, refused: message })
      return c.json({ message }, status as 403)
    }

    // Calls at once per access and in total, counted from here until the call is answered: a busy access is refused
    // before any of its body is read.
    const calls = proxySlotsFor(ctx)
    if (!calls.take(request.id))
      return await refuse(429, "This access key runs too many calls at once. Nothing was sent to n8n; try again.")
    try {
      let ops: Awaited<ReturnType<typeof instanceSpec>>
      try {
        ops = await instanceSpec(ctx, instance)
      } catch (e) {
        return await refuse(502, e instanceof AccessError ? e.message : "The n8n instance did not answer.")
      }
      const decision = checkCall(ops, grant, method, path, url.searchParams)
      if (!decision.allowed) return await refuse(403, decision.reason)

      const apiKey = ctx.secrets.decrypt(access.apiKeyEnc)
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
        if (!execution?.workflowId)
          return await refuse(
            403,
            `Could not check that execution ${decision.executionId} belongs to a workflow in this access. Try again, or ask the owner to check the instance.`,
          )
        if (!grant.workflowIds.includes(execution.workflowId))
          return await refuse(403, `Execution ${decision.executionId} is not of a workflow in this access.`)
      }
      c.set("call", { key, ref, request, grant, instance, url, path, method, decision, refuse, n8n })
      await next()
    } finally {
      calls.give(request.id)
    }
  })

  // The body is read only for a call that passed every check above, and never beyond the limit.
  const bounded = bodyLimit({
    maxSize: PROXY_BODY_BYTES,
    onError: (c) =>
      (c.get("call") as Call).refuse(
        413,
        `The request body is larger than ${PROXY_BODY_BYTES / 1024 ** 2} MiB, the most the access proxy forwards.`,
      ),
  })

  app.all("/:instance/api/v1/*", allowed, bounded, async (c) => {
    const { key, ref, request, grant, instance, url, path, method, decision, refuse, n8n } = c.get("call")
    const target = `${instance.baseUrl.replace(/\/+$/, "")}/api/v1${path}${url.search}`
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
    let change: string | null = null
    if (isChange(method)) {
      change = await reserveChange(ctx, request.id, { instanceId: instance.id, method, path })
      if (!change)
        return refuse(
          403,
          `This access has made ${MAX_CHANGES.toLocaleString("en-US")} changes, the most one access may make. Ask for new access to make more.`,
        )
    }
    // A call refused after all before it was sent: its recorded change becomes a refused call.
    const refuseUnsent = async (status: number, message: string) => {
      if (!change) return refuse(status, message)
      await refuseChange(ctx, request.id, change, status, message)
      return c.json({ message }, status as 403)
    }
    // The access may have ended, or the instance closed, while the call arrived or waited for the changes before it:
    // n8n sees the call only if it still holds, for the same instance.
    const now = await accessFor(ctx, key, ref)
    if (now.refused !== null) return refuseUnsent(now.refused, now.message)
    if (now.request.id !== request.id || now.instance.id !== instance.id)
      return refuseUnsent(403, `This key is not for ${ref}.`)
    let res: Response
    try {
      res = await n8n(method, target, body)
    } catch {
      // n8n may have made the change without answering: it stays recorded, with no answer.
      if (change) return c.json({ message: "The n8n instance did not answer." }, 502)
      return refuse(502, "The n8n instance did not answer.")
    }

    if (decision.workflowFilter && res.ok) {
      const data = (await res.json()) as { data?: { id: string }[]; nextCursor?: string | null }
      const allowed = new Set(grant.workflowIds)
      await logCall(ctx, request.id, { instanceId: instance.id, method, path, status: res.status })
      return c.json({ ...data, data: (data.data ?? []).filter((w) => allowed.has(w.id)) }, res.status as 200)
    }
    if (change) await finishChange(ctx, change, res.status)
    else await logCall(ctx, request.id, { instanceId: instance.id, method, path, status: res.status })
    // The map shows the agent's change now, not at its next refresh; the answer does not wait for it.
    if (changesWorkflowMap(method, path, res.status)) syncWorkflowsSoon(ctx, instance)
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
