import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { requireToken } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  agentBackups,
  agentFailure,
  agentInstances,
  agentProblem,
  agentProblems,
  agentQueues,
  agentWorkflows,
} from "../services/agent.ts"

/** Read-only REST API for scripts and agents (requirement E1). Bearer token of kind "rest". */
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
  app.all("/*", (c) => c.json({ error: "not_found" }, 404))
  return app
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] })
const readOnly = { readOnlyHint: true, openWorldHint: false }

/** One stateless MCP server per request. Every tool is read-only (requirement E3). */
export function buildMcpServer(ctx: Ctx, audit: (tool: string, args: unknown) => Promise<void>) {
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
    "Search workflows by name across all instances, with trigger, last run and 30-day run and error counts.",
    {
      query: z.string().optional(),
      instance: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    (a) => agentWorkflows(ctx, { q: a.query, instance: a.instance, limit: a.limit }),
  )
  return server
}

/** MCP over Streamable HTTP at /mcp (requirement E2). Bearer token of kind "mcp". */
export function mcpRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireToken(ctx, "mcp"))
  app.all("/", async (c) => {
    const actor = actorName(c.get("actor"))
    const server = buildMcpServer(ctx, async (tool, args) => {
      await ctx.audit({
        actor,
        action: "MCP read",
        target: `${tool} ${JSON.stringify(args)}`.slice(0, 300),
        via: "mcp",
      })
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
