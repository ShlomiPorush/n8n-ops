import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { requireToken } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { AccessError, collectAccess, releaseAccess, requestAccess } from "../services/access.ts"
import {
  agentBackups,
  agentFailure,
  agentInstances,
  agentProblem,
  agentProblems,
  agentQueues,
  agentWorkflows,
} from "../services/agent.ts"

/**
 * REST API for scripts and agents (requirement E1), bearer token of kind "rest". Read-only, except asking for
 * temporary access to an n8n instance, which a token may do only when allowed, and a person approves each time.
 */
export function restRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireToken(ctx, "rest"))
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
    const p = await agentProblem(ctx, c.req.param("id"))
    return p ? c.json({ data: p }) : c.json({ error: "not_found" }, 404)
  })
  app.get("/problems/:id/execution", async (c) => {
    const f = await agentFailure(ctx, c.req.param("id"), c.req.query("failure"))
    return f ? c.json({ data: f }) : c.json({ error: "not_found" }, 404)
  })
  app.get("/instances", async (c) => c.json({ data: await agentInstances(ctx) }))
  app.get("/queues", async (c) => c.json({ data: await agentQueues(ctx) }))
  app.get("/backups", async (c) => c.json({ data: await agentBackups(ctx) }))
  app.get("/workflows", async (c) =>
    c.json({ data: await agentWorkflows(ctx, { q: c.req.query("q"), instance: c.req.query("instance") }) }),
  )

  // Temporary access to n8n instances, for tokens allowed to ask for it.
  const allowedToken = (who: Env["Variables"]["actor"]) =>
    who.kind === "token" && who.canRequestAccess ? who.id : null
  const refused = { error: "not_allowed", message: "This token may not request access to n8n instances." }
  // An agent connected without ops:access learns which scope it lacks (RFC 6750); it connects again to get it.
  const refuse = (c: Context) => {
    c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="ops:read ops:access"`)
    return c.json(refused, 403)
  }
  const accessError = (e: unknown) => {
    if (!(e instanceof AccessError)) throw e
    const status = e.code === "not_found" ? 404 : e.code === "not_allowed" ? 403 : e.code.startsWith("spec") ? 502 : 400
    return [{ error: e.code, message: e.message }, status] as const
  }
  app.post("/access-requests", async (c) => {
    const tokenId = allowedToken(c.get("actor"))
    if (!tokenId) return refuse(c)
    const parsed = z.object(accessRequestShape).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    try {
      return c.json({ data: await requestAccess(ctx, tokenId, parsed.data) }, 201)
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
    try {
      return c.json({ data: await releaseAccess(ctx, tokenId, c.req.param("id")) })
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

const accessRequestShape = {
  instance: z.string().min(1).describe("Instance name, as listed by get_instance_health or search_workflows."),
  reason: z.string().min(10).max(500).describe("What you will do and why; the approver reads this."),
  scopes: z
    .array(z.string())
    .min(1)
    .describe("n8n API key scopes you need, for example workflow:read, workflow:update, execution:read."),
  workflowIds: z
    .array(z.string())
    .max(50)
    .optional()
    .describe("Limit the access to these workflows. Omit only when the task needs the whole instance."),
  minutes: z.number().int().min(1).describe("How long you need the access. The approver sees it; keep it short."),
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
    "Open problems on all n8n instances: one per workflow + node + exact error, with failure counts. Filter by instance name or text.",
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
    "Details of one problem: error, stack, the failed node's input, the workflow graph with the failed node, recent executions and the same error elsewhere.",
    { problemId: z.string().uuid() },
    (a) => agentProblem(ctx, a.problemId),
  )
  tool(
    "get_failed_execution",
    "The full stored failed execution of a problem (latest by default): n8n run data, error and input, plus a link to it in n8n.",
    { problemId: z.string().uuid(), failureId: z.string().uuid().optional() },
    (a) => agentFailure(ctx, a.problemId, a.failureId),
  )
  tool("get_instance_health", "Health, version and last check of every n8n instance.", {}, () => agentInstances(ctx))
  tool("get_queue_status", "Queue metrics and worker health of instances in queue mode.", {}, () => agentQueues(ctx))
  tool("get_backup_status", "Last backup and last successful backup of every instance.", {}, () => agentBackups(ctx))
  tool(
    "search_workflows",
    "Find workflows across all instances by name, workflow ID, webhook path or tag. Each result says which instance it is on, and whether access to that instance can be requested and with which scopes.",
    {
      query: z.string().optional(),
      instance: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    (a) => agentWorkflows(ctx, { q: a.query, instance: a.instance, limit: a.limit }),
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
    "Ask for temporary access to one n8n instance's API, for a task. A person approves or denies it; poll get_access_request for the result and the key. If you do not know which instance has the workflow, find it with search_workflows first. Ask only for the scopes, workflows and minutes the task needs.",
    accessRequestShape,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    (a) =>
      requestAccess(ctx, access.tokenId, {
        instance: a.instance,
        reason: a.reason,
        scopes: a.scopes,
        workflowIds: a.workflowIds,
        minutes: a.minutes,
      }),
  )
  accessTool(
    "get_access_request",
    "Status of an access request. Once approved it returns, one time only, the key and the base URL: call the n8n public API there with the key in the X-N8N-API-KEY header, exactly as with n8n.",
    { requestId: z.string().uuid() },
    { readOnlyHint: true, openWorldHint: false },
    (a) => collectAccess(ctx, access.tokenId, a.requestId, access.publicUrl),
  )
  accessTool(
    "release_instance_access",
    "End your access as soon as the task is done; the key stops working at once.",
    { requestId: z.string().uuid() },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    (a) => releaseAccess(ctx, access.tokenId, a.requestId),
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
