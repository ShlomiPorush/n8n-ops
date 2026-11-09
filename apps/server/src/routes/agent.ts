import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { type AccessChannel, accessChannels } from "@n8n-ops/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { requireToken } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  AccessError,
  type AccessRequestInput,
  collectAccess,
  releaseAccess,
  requestAccess,
  SUMMARY_MAX,
} from "../services/access.ts"
import {
  agentBackups,
  agentFailure,
  agentInstances,
  agentProblem,
  agentProblems,
  agentQueues,
  agentWorkflows,
  WORKFLOWS_DEFAULT,
  WORKFLOWS_MAX,
} from "../services/agent.ts"
import {
  HistoryError,
  HOURS_MAX,
  healthHistory,
  historyQuery,
  OFFSET_MAX,
  RUNS_MAX,
} from "../services/health-history.ts"

const isUuid = (value: string) => z.string().uuid().safeParse(value).success

/** A page of workflows: at most WORKFLOWS_MAX, from `offset` on. */
const workflowPage = z.object({
  limit: z.coerce.number().int().min(1).max(WORKFLOWS_MAX).default(WORKFLOWS_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * REST API for scripts and agents (requirement E1), bearer token of kind "rest". Read-only, except asking for
 * temporary access to an n8n instance, which a token may do only when allowed, and a person approves each time.
 */
export function restRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireToken(ctx, "rest"))
  // Reads leave the same trail as MCP tool calls.
  app.use("*", async (c, next) => {
    if (c.req.method === "GET") {
      const url = new URL(c.req.url)
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: "API read",
        target: `${url.pathname}${url.search}`.slice(0, 300),
        via: "rest",
      })
    }
    await next()
  })
  app.get("/problems", async (c) =>
    c.json({
      data: await agentProblems(ctx, {
        status: c.req.query("status"),
        instance: c.req.query("instance"),
        q: c.req.query("q"),
        limit: Number(c.req.query("limit") ?? 50),
      }),
    }),
  )
  app.get("/problems/:id", async (c) => {
    const workflow = c.req.query("workflow")
    if (!isUuid(c.req.param("id")) || (workflow && !isUuid(workflow))) return c.json({ error: "not_found" }, 404)
    const p = await agentProblem(ctx, c.req.param("id"), workflow)
    return p ? c.json({ data: p }) : c.json({ error: "not_found" }, 404)
  })
  app.get("/problems/:id/execution", async (c) => {
    const failure = c.req.query("failure")
    const workflow = c.req.query("workflow")
    if (!isUuid(c.req.param("id")) || (failure && !isUuid(failure)) || (workflow && !isUuid(workflow)))
      return c.json({ error: "not_found" }, 404)
    const f = await agentFailure(ctx, c.req.param("id"), failure, workflow)
    return f ? c.json({ data: f }) : c.json({ error: "not_found" }, 404)
  })
  app.get("/instances", async (c) => c.json({ data: await agentInstances(ctx) }))
  app.get("/health", async (c) => {
    const instance = c.req.query("instance")
    if (!instance) return c.json({ error: "invalid", message: "instance (its name) is required." }, 400)
    const parsed = historyQuery.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    try {
      const { runs, ...rest } = await healthHistory(ctx, { name: instance }, parsed.data)
      return c.json({ data: runs, ...rest })
    } catch (e) {
      if (!(e instanceof HistoryError)) throw e
      return c.json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : 400)
    }
  })
  app.get("/queues", async (c) => c.json({ data: await agentQueues(ctx) }))
  app.get("/backups", async (c) => c.json({ data: await agentBackups(ctx) }))
  app.get("/workflows", async (c) => {
    const parsed = workflowPage.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const { workflows, ...page } = await agentWorkflows(ctx, {
      q: c.req.query("q"),
      instance: c.req.query("instance"),
      ...parsed.data,
    })
    return c.json({ data: workflows, ...page })
  })

  // Temporary access to n8n instances, for tokens allowed to ask for it.
  const allowedToken = (who: Env["Variables"]["actor"]) =>
    who.kind === "token" && who.canRequestAccess ? who.id : null
  const refused = {
    error: "not_allowed",
    message: "This agent may not request access to n8n instances. Ask a person to allow it in n8n-ops.",
  }
  // An agent connected without ops:access learns which scope it lacks (RFC 6750); it connects again to get it.
  const refuse = (c: Context) => {
    c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="ops:read ops:access"`)
    return c.json(refused, 403)
  }
  const accessError = (e: unknown) => {
    if (!(e instanceof AccessError)) throw e
    const status =
      e.code === "not_found"
        ? 404
        : e.code === "not_allowed"
          ? 403
          : e.code === "request_in_progress"
            ? 409
            : e.code === "busy"
              ? 503
              : e.code.startsWith("spec")
                ? 502
                : 400
    return [{ error: e.code, message: e.message }, status] as const
  }
  app.post("/access-requests", async (c) => {
    const tokenId = allowedToken(c.get("actor"))
    if (!tokenId) return refuse(c)
    const parsed = z.object(accessRequestShape).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const input = accessInput(parsed.data)
    if (typeof input === "string") return c.json({ error: "invalid", message: input }, 400)
    try {
      return c.json({ data: await requestAccess(ctx, tokenId, input) }, 201)
    } catch (e) {
      const [body, status] = accessError(e)
      return c.json(body, status)
    }
  })
  app.get("/access-requests/:id", async (c) => {
    const tokenId = allowedToken(c.get("actor"))
    if (!tokenId) return refuse(c)
    try {
      return c.json({ data: await collectAccess(ctx, tokenId, c.req.param("id"), await publicBase(ctx, c.req.url)) })
    } catch (e) {
      const [body, status] = accessError(e)
      return c.json(body, status)
    }
  })
  app.post("/access-requests/:id/release", async (c) => {
    const tokenId = allowedToken(c.get("actor"))
    if (!tokenId) return refuse(c)
    // Without a body, as earlier skills send it, the access is released without a summary.
    const text = await c.req.text()
    let body: unknown = {}
    if (text.trim()) {
      try {
        body = JSON.parse(text)
      } catch {
        return c.json({ error: "invalid", message: "The body is not JSON." }, 400)
      }
    }
    const parsed = z.object(releaseShape).safeParse(body)
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    try {
      return c.json({ data: await releaseAccess(ctx, tokenId, c.req.param("id"), parsed.data.summary) })
    } catch (e) {
      const [body, status] = accessError(e)
      return c.json(body, status)
    }
  })
  app.all("/*", (c) => c.json({ error: "not_found" }, 404))
  return app
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] })
const readOnly = { readOnlyHint: true, openWorldHint: false }

/** The public address agents use for the access proxy: Settings, N8N_OPS_PUBLIC_URL, or this request's origin. */
async function publicBase(ctx: Ctx, requestUrl: string) {
  const { publicUrl } = await ctx.settings.get("general")
  return publicUrl || new URL(requestUrl).origin
}

/** What a release may say; longer summaries are clipped, never refused, so the release always ends the access. */
const releaseShape = {
  summary: z
    .string()
    .optional()
    .describe(
      `What you did with the access and the result, for the person who approved it; up to ${SUMMARY_MAX} characters.`,
    ),
}

const scopesShape = z
  .array(z.string())
  .min(1)
  .describe("n8n API key scopes you need there, for example workflow:read, workflow:update, execution:read.")
const workflowIdsShape = z
  .array(z.string())
  .max(50)
  .optional()
  .describe("Limit the access there to these workflows. Omit only when the task needs the whole instance.")
const instanceName = z.string().min(1).describe("Instance name, as listed by get_instance_health or search_workflows.")

/**
 * An access request: several instances in `instances`, or one in `instance`, `scopes` and `workflowIds` (the form
 * agents of earlier skills send). `accessInput` takes either.
 */
const accessRequestShape = {
  instances: z
    .array(z.object({ instance: instanceName, scopes: scopesShape, workflowIds: workflowIdsShape }))
    .min(1)
    .optional()
    .describe(
      "The instances you need, each with its own scopes and workflows. Use this to ask for several instances in one request.",
    ),
  instance: instanceName.optional().describe("For one instance only, instead of instances: its name."),
  scopes: scopesShape.optional().describe("With instance: the n8n API key scopes you need there."),
  workflowIds: workflowIdsShape.describe("With instance: limit the access to these workflows."),
  reason: z.string().min(10).max(500).describe("What you will do and why; the approver reads this."),
  minutes: z.number().int().min(1).describe("How long you need the access. The approver sees it; keep it short."),
  notify: z
    .array(z.enum(accessChannels))
    .min(1)
    .optional()
    .describe(
      "Where to tell the approvers: telegram, email, or both. Only when the person asked you for a channel; omit it otherwise and n8n-ops uses its default. A channel that is off or not set up is replaced by the default. The answer's notify says where the request is to be sent.",
    ),
}

type AccessRequestBody = {
  instances?: { instance: string; scopes: string[]; workflowIds?: string[] }[]
  instance?: string
  scopes?: string[]
  workflowIds?: string[]
  reason: string
  minutes: number
  notify?: AccessChannel[]
}

/** The request in one form, or what is wrong with the body. */
export function accessInput(body: AccessRequestBody): AccessRequestInput | string {
  const single = body.instance !== undefined || body.scopes !== undefined || body.workflowIds !== undefined
  if (body.instances && single) return "Use either instances, or instance with scopes, not both."
  const notify = body.notify ? { notify: body.notify } : {}
  if (body.instances) return { reason: body.reason, minutes: body.minutes, instances: body.instances, ...notify }
  if (!body.instance || !body.scopes) return "Name the instances you need, each with its scopes."
  return {
    reason: body.reason,
    minutes: body.minutes,
    instances: [{ instance: body.instance, scopes: body.scopes, workflowIds: body.workflowIds }],
    ...notify,
  }
}

/**
 * One stateless MCP server per request. Every tool is read-only (requirement E3), except the access tools,
 * offered only to tokens allowed to ask for temporary access to n8n instances (which a person must approve).
 */
export function buildMcpServer(
  ctx: Ctx,
  audit: (tool: string, args: unknown) => Promise<void>,
  access?: { tokenId: string; publicUrl: string },
) {
  const server = new McpServer({ name: "n8n-ops", version: ctx.version })
  // Arguments are validated by the SDK against inputSchema before run() is called.
  // biome-ignore lint/suspicious/noExplicitAny: tool arguments are typed by each tool's zod schema
  type Args = Record<string, any>
  const tool = (name: string, description: string, inputSchema: z.ZodRawShape, run: (args: Args) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema, annotations: readOnly }, (async (args: Args) => {
      await audit(name, args)
      const result = await run(args)
      return result === null ? { ...json({ error: "not found" }), isError: true } : json(result)
    }) as never)

  tool(
    "list_open_problems",
    'Open problems on all n8n instances: one per cause, what the failing node talked to and what went wrong there (title "target · reason", with target, reason, kind and hint), with the workflows it hit (affectedWorkflows: instance, workflow, node, state, failures; affectedTotal counts them all) and failure counts. errorMessage is n8n\'s latest error text. A problem is open while any of its workflows is. Filter by instance name (the state is then the state on that instance) or text.',
    {
      instance: z.string().optional(),
      query: z.string().optional(),
      status: z.enum(["open", "muted", "resolved"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    (a) => agentProblems(ctx, { instance: a.instance, q: a.query, status: a.status, limit: a.limit }),
  )
  tool(
    "get_problem",
    "Details of one problem: every workflow it hit (affectedWorkflows), and for one of them (selected: the most recently failed, or the one affectedWorkflowId names) the error, stack, the failed node's input, the workflow graph with the failed node and recent executions; sameTarget lists other problems at the same target (credential, host, called workflow or node) that failed for another reason or were split off by hand, open ones first, at most 50; sameTargetTotal counts them all. problemId may also be an affected workflow id, which is then the one selected.",
    { problemId: z.string().uuid(), affectedWorkflowId: z.string().uuid().optional() },
    (a) => agentProblem(ctx, a.problemId, a.affectedWorkflowId),
  )
  tool(
    "get_failed_execution",
    "A full stored failed execution of a problem: n8n run data, error and input, plus a link to it in n8n. The latest of the workflow affectedWorkflowId names (or that problemId names, when it is an affected workflow id), else the latest of the whole problem; failureId picks one of them.",
    {
      problemId: z.string().uuid(),
      failureId: z.string().uuid().optional(),
      affectedWorkflowId: z.string().uuid().optional(),
    },
    (a) => agentFailure(ctx, a.problemId, a.failureId, a.affectedWorkflowId),
  )
  tool(
    "get_instance_health",
    "Health, version and last check of every n8n instance. health is unknown when the last collection could not read it or no collection runs now (unknownReason or healthDetail.notCollected says why); then lastKnownHealth and lastKnownAt are the last check that read it.",
    {},
    () => agentInstances(ctx),
  )
  tool(
    "get_health_history",
    `The health history of one instance's main, to explain outages and repeated down alerts. check: how it is checked now (interval, timeouts, downAfterFailures, mode, collection; today's configuration, not that of past checks). summary: checks, failed, notCollected and response times (p50, p95, max of passing checks that measured one) in the window. series: buckets (5 minutes up to 48 hours, 1 hour beyond) with checks, failed and min/avg/max ms. runs: failed checks in a row, newest first, overlapping the window, each with lastFailure (its kind, status, code, error, how it was checked, mode, the alert threshold then, and a hint: what was observed, then possible causes), alertQueued (a down alert was queued; null when unknown), recoverySeen (a passing check came after it before the window end; recoverySeenAt is when it was seen, not when n8n recovered), startTruncated (history kept starts inside it; checks is then at least). Paged: limit (default 50, up to ${RUNS_MAX}), offset, total, nextOffset; pass the returned window.to as to for the next pages.`,
    {
      instance: z.string().min(1),
      hours: z.number().int().min(1).max(HOURS_MAX).optional(),
      limit: z.number().int().min(1).max(RUNS_MAX).optional(),
      offset: z.number().int().min(0).max(OFFSET_MAX).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    },
    async (a) => {
      // The SDK checked the arguments against the schema above; a thrown error becomes a tool error.
      const parsed = historyQuery.parse({ hours: a.hours, limit: a.limit, offset: a.offset, to: a.to })
      try {
        return await healthHistory(ctx, { name: a.instance }, parsed)
      } catch (e) {
        if (!(e instanceof HistoryError)) throw e
        if (e.code === "not_found") return null
        throw new Error(e.message)
      }
    },
  )
  tool(
    "get_queue_status",
    "Queue metrics and queue worker health of instances in queue mode. With health unknown, the figures are from checkedAt, the last check. Each queue worker has, when its check read them: version, uptimeSec (of its container), memory {used, limit} in bytes (limit null: none set on the container) and concurrency {value, from: env, flag or default}; they are missing for workers of earlier releases.",
    {},
    () => agentQueues(ctx),
  )
  tool(
    "get_backup_status",
    "The last backup run of every instance, and the last one that ended ok or partial.",
    {},
    () => agentBackups(ctx),
  )
  tool(
    "search_workflows",
    `Find workflows across all instances by name, workflow ID, webhook path or tag, by name, then instance, then ID. Each result says which instance it is on, and whether access to that instance can be requested and with which scopes. Returns { workflows, total, nextOffset }: at most limit (default ${WORKFLOWS_DEFAULT}, up to ${WORKFLOWS_MAX}) from offset on; total counts every match. To see them all, call again with offset set to nextOffset until it is null. The pages hold every match only while the list does not change: a sync between calls can move a workflow across pages, even when total stays the same. If total changes between calls, start again from offset 0.`,
    {
      query: z.string().optional(),
      instance: z.string().optional(),
      limit: z.number().int().min(1).max(WORKFLOWS_MAX).optional(),
      offset: z.number().int().min(0).optional(),
    },
    (a) => agentWorkflows(ctx, { q: a.query, instance: a.instance, limit: a.limit, offset: a.offset }),
  )
  if (!access) return server

  const accessTool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    annotations: Record<string, boolean>,
    run: (args: Args) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: Args) => {
      try {
        return json(await run(args))
      } catch (e) {
        if (e instanceof AccessError) return { ...json({ error: e.code, message: e.message }), isError: true }
        throw e
      }
    }) as never)

  accessTool(
    "request_instance_access",
    "Ask for temporary access to the API of one or more n8n instances, for a task: several in instances, each with its own scopes and workflows, or one in instance with scopes. A person approves, possibly after changing the instances, scopes, workflows or minutes, or denies; poll get_access_request for the result and the key. Approvers hear of it on the default channels, or in notify on the ones the person asked you for. If you do not know which instance has the workflow, find it with search_workflows first. Ask only for the instances, scopes, workflows and minutes the task needs.",
    accessRequestShape,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    (a) => {
      const input = accessInput(a as AccessRequestBody)
      if (typeof input === "string") throw new AccessError("invalid", input)
      return requestAccess(ctx, access.tokenId, input)
    },
  )
  accessTool(
    "get_access_request",
    "Status of an access request; notifiedVia lists the channels the approvers were told on so far. Once approved it returns, in instances, what was granted on each instance with its baseUrl (the approver may have changed what you asked for), and the key one time only: one key for every granted instance. Call the n8n public API at an instance's baseUrl with the key in the X-N8N-API-KEY header, exactly as with n8n.",
    { requestId: z.string().uuid() },
    { readOnlyHint: true, openWorldHint: false },
    (a) => collectAccess(ctx, access.tokenId, a.requestId, access.publicUrl),
  )
  accessTool(
    "release_instance_access",
    "End your access once the task is finished and checked, or cancelled or given up; the key stops working at once. In summary, tell the person what you did with the access and the result, in a few sentences.",
    { requestId: z.string().uuid(), ...releaseShape },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    (a) => releaseAccess(ctx, access.tokenId, a.requestId, a.summary),
  )
  return server
}

/** MCP over Streamable HTTP at /mcp (requirement E2). Bearer token of kind "mcp". */
export function mcpRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireToken(ctx, "mcp"))
  app.all("/", async (c) => {
    const who = c.get("actor")
    const actor = actorName(who)
    const access =
      who.kind === "token" && who.canRequestAccess
        ? { tokenId: who.id, publicUrl: await publicBase(ctx, c.req.url) }
        : undefined
    const server = buildMcpServer(
      ctx,
      async (tool, args) => {
        await ctx.audit({
          actor,
          action: "MCP read",
          target: `${tool} ${JSON.stringify(args)}`.slice(0, 300),
          via: "mcp",
        })
      },
      access,
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
