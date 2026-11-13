import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { type AccessChannel, accessChannels } from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { apiTokens } from "../db/schema.ts"
import { requireToken } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { idleSince, issuerOf } from "../oauth/agents.ts"
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
import { agentWorkers, refusal, WorkerHealthError, workerHealth } from "../services/worker-health.ts"
import {
  AREAS,
  type Area,
  areasOf,
  DATA_SENTENCE,
  honoPath,
  type Kind,
  listing,
  NEVER,
  OPEN,
  type OpenRoute,
  REVISION,
  updateSkillNotice,
} from "./agent-policy.ts"

const isUuid = (value: string) => z.string().uuid().safeParse(value).success

/** A page of workflows: at most WORKFLOWS_MAX, from `offset` on. */
const workflowPage = z.object({
  limit: z.coerce.number().int().min(1).max(WORKFLOWS_MAX).default(WORKFLOWS_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
})

/** Limits shared by the REST API and MCP (the agent-access standard): body, answer, time, calls at once. */
export const LIMITS = {
  bodyBytes: 256 * 1024,
  answerBytes: 16 * 1024 * 1024,
  deadlineMs: 60_000,
  perConnection: 4,
  total: 16,
}

/** The headers the client skill sends; named for the product. */
export const HEADERS = { skill: "x-n8n-ops-skill", policy: "x-n8n-ops-policy", kind: "x-n8n-ops-kind" } as const

type Outcome = "ok" | "error" | "denied" | "unknown"
type TokenActor = Extract<Env["Variables"]["actor"], { kind: "token" }>

/**
 * Calls running now, per connection and in total. A call keeps its slot until its work ends, also after its answer
 * went out as outcome_unknown, so slow calls cannot pile up beyond the limits.
 */
function slots() {
  const per = new Map<string, number>()
  let total = 0
  return {
    take(id: string) {
      const mine = per.get(id) ?? 0
      if (mine >= LIMITS.perConnection || total >= LIMITS.total) return false
      per.set(id, mine + 1)
      total++
      return true
    },
    give(id: string) {
      const mine = (per.get(id) ?? 1) - 1
      if (mine > 0) per.set(id, mine)
      else per.delete(id)
      total = Math.max(0, total - 1)
    },
  }
}
const slotsOf = new WeakMap<Ctx, ReturnType<typeof slots>>()
const slotsFor = (ctx: Ctx) => {
  const found = slotsOf.get(ctx)
  if (found) return found
  const made = slots()
  slotsOf.set(ctx, made)
  return made
}

/** Resolves "late" if the work has not ended within the deadline; the work goes on either way. */
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work.then((value) => ({ late: false as const, value })),
    wait(ms).then(() => ({ late: true as const })),
  ])
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())

const busy = { error: "busy", message: "This connection runs too many calls at once. Nothing was sent; try again." }
const unknown = {
  error: "outcome_unknown",
  message: "The call took too long, and it may still be running. Read the state it was to change before you try again.",
}

/** What an agent may do through this token, for `access` and the MCP tool get_access. */
async function accessAnswer(ctx: Ctx, who: TokenActor, skillHeader: string | undefined) {
  const [row] = await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, who.id))
  const { idleDays } = await ctx.settings.get("agents")
  const base = issuerOf((await ctx.settings.get("general")).publicUrl) ?? ""
  const areas = areasOf(who.canRequestAccess)
  const notice = row?.kind === "agent" ? updateSkillNotice(skillHeader, ctx.agents?.skillVersion ?? null, base) : null
  const area = (a: Area) => ({ area: a, kinds: AREAS[a].kinds, sentence: AREAS[a].sentence })
  return {
    account: row?.approvedBy ?? null,
    name: row?.name ?? who.name,
    connection: who.manual ? "token made by hand in n8n-ops" : "agent connected by approval",
    areas: areas.map(area),
    notGranted: (Object.keys(AREAS) as Area[]).filter((a) => !areas.includes(a)).map(area),
    never: NEVER,
    ends: who.manual
      ? { rule: "When a person revokes the token in n8n-ops." }
      : {
          rule: `After ${idleDays} days without use, or when a person disconnects it.`,
          lastUsedAt: row?.lastUsedAt ?? null,
          endsAt: row ? new Date(idleSince(row) + idleDays * 86_400_000) : null,
        },
    version: ctx.version,
    ...(notice ? { update_skill: notice } : {}),
  }
}

/**
 * The policy check of one open REST route, before its code runs: the connection holds its area; an agent's call
 * carries the policy revision it used and the kind it found for this route, both as the server has them (409
 * policy_changed otherwise, after which the client may send it again); a free slot (429 busy). Tokens made by hand
 * are a separate channel without the client skill: they skip the headers. Then the route runs within the deadline,
 * its answer within the cap, and every call leaves an audit entry with its outcome.
 */
export function policy(ctx: Ctx, route: OpenRoute): MiddlewareHandler<Env> {
  return async (c, next) => {
    const who = c.get("actor") as TokenActor
    const url = new URL(c.req.url)
    const record = async (outcome: Outcome, status: number) =>
      ctx.audit({
        actor: actorName(who),
        action: route.kind === "read" ? "API read" : "API action",
        target: `${url.pathname}${url.search}`.slice(0, 300),
        via: "rest",
        details: { route: `${route.method} ${route.path}`, outcome, status },
      })
    if (route.area && !areasOf(who.canRequestAccess).includes(route.area)) {
      await record("denied", 403)
      // An agent connected without ops:access learns which scope it lacks (RFC 6750); it connects again to get it.
      c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="ops:read ops:access"`)
      return c.json(
        {
          error: "not_allowed",
          message: "This agent may not request access to n8n instances. Ask a person to allow it in n8n-ops.",
        },
        403,
      )
    }
    if (!route.exempt && !who.manual) {
      const policyHeader = c.req.header(HEADERS.policy)
      const kindHeader = c.req.header(HEADERS.kind)
      if (policyHeader !== REVISION || kindHeader !== route.kind) {
        await record("denied", 409)
        const base = issuerOf((await ctx.settings.get("general")).publicUrl) ?? ""
        return c.json(
          {
            error: "policy_changed",
            message: `The calls of n8n-ops changed, or this skill is older than n8n-ops. Run \`n8n-ops endpoints\` and take the path from it; if this keeps happening, install the skill again from ${base}/connect/skill/.`,
          },
          409,
        )
      }
    }
    const s = slotsFor(ctx)
    if (!s.take(who.id)) {
      await record("denied", 429)
      return c.json(busy, 429)
    }
    const work = next().finally(() => s.give(who.id))
    const done = await within(work, LIMITS.deadlineMs)
    if (done.late) {
      work.catch(() => undefined)
      await record("unknown", 504)
      return c.json(unknown, 504)
    }
    const status = c.res.status
    const length = Number(c.res.headers.get("content-length") ?? NaN)
    const size = Number.isFinite(length) ? length : (await c.res.clone().arrayBuffer()).byteLength
    if (size > LIMITS.answerBytes) {
      await record(status < 400 ? "error" : "error", status)
      c.res = new Response(
        JSON.stringify({
          error: "answer_too_large",
          message: `The answer is larger than ${LIMITS.answerBytes / 1024 / 1024} MB. Ask for less (a filter, a smaller limit).${route.kind === "act" ? " The action ran." : ""}`,
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      )
      return
    }
    await record(status < 400 ? "ok" : status === 401 || status === 403 ? "denied" : "error", status)
  }
}

/**
 * REST API for scripts and agents (requirement E1), bearer token of kind "rest". Every route is open by the table in
 * agent-policy.ts: read-only, except asking for temporary access to n8n instances, which a connection may do only
 * when the person allowed it, and a person approves each time.
 */
export function restRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireToken(ctx, "rest"))
  app.use(
    "*",
    bodyLimit({
      maxSize: LIMITS.bodyBytes,
      onError: (c) => c.json({ error: "too_large", message: "The body is larger than 256 KB." }, 413),
    }),
  )

  // Temporary access to n8n instances: the policy check let only connections allowed to ask reach these.
  const tokenOf = (c: Context<Env>) => (c.get("actor") as TokenActor).id
  const accessError = (e: unknown) => {
    if (!(e instanceof AccessError)) throw e
    const status =
      e.code === "not_found"
        ? 404
        : e.code === "not_allowed"
          ? 403
          : e.code === "request_in_progress"
            ? 409
            : // Nothing was stored in either case: a 4xx, so the client knows the request did not happen (a 5xx after an
              // action reads as an outcome unknown). Not 429: that is the limits layer's reserved busy.
              e.code === "busy"
              ? 409
              : e.code.startsWith("spec")
                ? 424
                : 400
    return [{ error: e.code, message: e.message }, status] as const
  }

  const handlers: Record<string, (c: Context<Env>) => Promise<Response>> = {
    "GET /api/v1/agent/access": async (c) =>
      c.json(await accessAnswer(ctx, c.get("actor") as TokenActor, c.req.header(HEADERS.skill))),
    "GET /api/v1/agent/endpoints": async (c) =>
      c.json(listing(areasOf((c.get("actor") as TokenActor).canRequestAccess), c.req.query("area"))),
    "GET /api/v1/problems": async (c) =>
      c.json({
        data: await agentProblems(ctx, {
          status: c.req.query("status"),
          instance: c.req.query("instance"),
          q: c.req.query("q"),
          limit: Number(c.req.query("limit") ?? 50),
        }),
      }),
    "GET /api/v1/problems/{id}": async (c) => {
      const workflow = c.req.query("workflow")
      if (!isUuid(c.req.param("id") ?? "") || (workflow && !isUuid(workflow)))
        return c.json({ error: "not_found" }, 404)
      const p = await agentProblem(ctx, c.req.param("id") as string, workflow)
      return p ? c.json({ data: p }) : c.json({ error: "not_found" }, 404)
    },
    "GET /api/v1/problems/{id}/execution": async (c) => {
      const failure = c.req.query("failure")
      const workflow = c.req.query("workflow")
      if (!isUuid(c.req.param("id") ?? "") || (failure && !isUuid(failure)) || (workflow && !isUuid(workflow)))
        return c.json({ error: "not_found" }, 404)
      const f = await agentFailure(ctx, c.req.param("id") as string, failure, workflow)
      return f ? c.json({ data: f }) : c.json({ error: "not_found" }, 404)
    },
    "GET /api/v1/instances": async (c) => c.json({ data: await agentInstances(ctx) }),
    "GET /api/v1/health": async (c) => {
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
    },
    "GET /api/v1/workers": async (c) => c.json({ data: await agentWorkers(ctx) }),
    "GET /api/v1/worker-health": async (c) => {
      const worker = c.req.query("worker")
      const id = c.req.query("id")
      if (!worker === !id)
        return c.json({ error: "invalid", message: "Give either worker (its name) or id (its id)." }, 400)
      const parsed = historyQuery.safeParse(c.req.query())
      if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
      try {
        const { events, ...rest } = await workerHealth(ctx, id ? { id } : { name: worker }, parsed.data)
        return c.json({ data: events, ...rest })
      } catch (e) {
        if (!(e instanceof WorkerHealthError)) throw e
        const [body, status] = refusal(e)
        return c.json(body, status)
      }
    },
    "GET /api/v1/queues": async (c) => c.json({ data: await agentQueues(ctx) }),
    "GET /api/v1/backups": async (c) => c.json({ data: await agentBackups(ctx) }),
    "GET /api/v1/workflows": async (c) => {
      const parsed = workflowPage.safeParse(c.req.query())
      if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
      const { workflows, ...page } = await agentWorkflows(ctx, {
        q: c.req.query("q"),
        instance: c.req.query("instance"),
        ...parsed.data,
      })
      return c.json({ data: workflows, ...page })
    },
    "POST /api/v1/access-requests": async (c) => {
      const parsed = z.object(accessRequestShape).safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
      const input = accessInput(parsed.data)
      if (typeof input === "string") return c.json({ error: "invalid", message: input }, 400)
      try {
        return c.json({ data: await requestAccess(ctx, tokenOf(c), input) }, 201)
      } catch (e) {
        const [body, status] = accessError(e)
        return c.json(body, status)
      }
    },
    "GET /api/v1/access-requests/{id}": async (c) => {
      try {
        return c.json({
          data: await collectAccess(ctx, tokenOf(c), c.req.param("id") as string, await publicBase(ctx, c.req.url)),
        })
      } catch (e) {
        const [body, status] = accessError(e)
        return c.json(body, status)
      }
    },
    "POST /api/v1/access-requests/{id}/release": async (c) => {
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
        return c.json({ data: await releaseAccess(ctx, tokenOf(c), c.req.param("id") as string, parsed.data.summary) })
      } catch (e) {
        const [body, status] = accessError(e)
        return c.json(body, status)
      }
    },
  }

  for (const route of OPEN) {
    const handler = handlers[`${route.method} ${route.path}`]
    if (!handler) throw new Error(`No handler for the open route ${route.method} ${route.path}`)
    app.on(route.method, honoPath(route.path).slice("/api/v1".length), policy(ctx, route), handler)
  }
  app.all("/*", (c) => c.json({ error: "not_found", message: "Take the path from `n8n-ops endpoints`." }, 404))
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

/** What the MCP server tells every agent that connects. */
export const MCP_INSTRUCTIONS = [
  "n8n-ops watches self-hosted n8n instances: failed executions grouped into problems by cause, instance health and its history, n8n-ops Workers, queues, backups, and where each workflow is.",
  "This connection acts for the person who approved it, within the areas they granted. Call get_access first: it says what this connection may do and when it ends.",
  `Agents never: ${NEVER.join(" ")}`,
  DATA_SENTENCE,
  "When an action's outcome is unknown, read its result before trying again.",
].join("\n\n")

/** Runs one tool call under the limits and the connection check, and records it; see mcpRoutes. */
export type ToolGuard = (
  tool: string,
  kind: Kind,
  args: unknown,
  run: () => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>

/** Without a guard (unit tests), a tool simply runs. */
const unguarded: ToolGuard = (_tool, _kind, _args, run) => run()

/**
 * One stateless MCP server per request. Every tool reads (requirement E3), except the access tools, offered only to
 * connections allowed to ask for temporary access to n8n instances (which a person must approve). Each tool carries
 * the area and kind of the policy table: read tools hint readOnly, the access tools are acts.
 */
export function buildMcpServer(
  ctx: Ctx,
  audit: (tool: string, args: unknown, outcome?: Outcome) => Promise<void>,
  access?: { tokenId: string; publicUrl: string },
  extra: { guard?: ToolGuard; getAccess?: () => Promise<unknown> } = {},
) {
  const server = new McpServer({ name: "n8n-ops", version: ctx.version }, { instructions: MCP_INSTRUCTIONS })
  const guard = extra.guard ?? unguarded
  // Arguments are validated by the SDK against inputSchema before run() is called.
  // biome-ignore lint/suspicious/noExplicitAny: tool arguments are typed by each tool's zod schema
  type Args = Record<string, any>
  const tool = (name: string, description: string, inputSchema: z.ZodRawShape, run: (args: Args) => Promise<unknown>) =>
    server.registerTool(
      name,
      { description: `${description} ${DATA_SENTENCE}`, inputSchema, annotations: readOnly },
      (async (args: Args) =>
        guard(name, "read", args, async () => {
          const result = await run(args)
          if (!extra.guard) await audit(name, args, "ok")
          return result === null ? { ...json({ error: "not found" }), isError: true } : json(result)
        })) as never,
    )

  server.registerTool(
    "get_access",
    {
      description:
        "What this connection may do: whose account it acts for, the areas granted and not granted, what agents never do in n8n-ops, and when the connection ends. Call it first.",
      inputSchema: {},
      annotations: readOnly,
    },
    (async () => guard("get_access", "read", {}, async () => json(await (extra.getAccess?.() ?? {})))) as never,
  )
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
    "get_workers",
    "The n8n-ops Workers (the agent n8n-ops runs on each n8n Docker host; not n8n queue workers): name, id, online (it called the server within the last 90 s), lastSeenAt, version, heartbeat (it reports round-trip time, failed calls, Docker checks and restarts) and the instances it serves. Names are not unique; use the id when two share one.",
    {},
    () => agentWorkers(ctx),
  )
  tool(
    "get_worker_health_history",
    `The health history of one n8n-ops Worker, to explain why it was offline or why its instances' health went unknown. Name it by worker (its name) or id. worker: online now, lastSeenAt, version, update (the image line when it runs an earlier release). check: how the history is made (description). historyStartsAt: time before it is not measured. summary: availability (online share of the time observed, which excludes time n8n-ops itself was not recording), offline time and periods, notRecordingMs (n8n-ops was not running or could not record; never the Worker's fault), restarts, Docker failing time, round-trip avg/max and failed calls as reported by the Worker. coverage: how much of the online time had round-trip and Docker measurements; heartbeat false means the Worker must be updated to report them. series: buckets (5 minutes up to 48 hours, 1 hour beyond). periods: the same, as spans for a chart. docker: the last Docker check (current when under 3 minutes old and the Worker is online). events, newest first: offline (with notRecordingMs and job: a job that was running then, a hint, never the cause), not-recording, restart (uptimeSecBefore: a lower bound of the earlier process's uptime) and docker (endUnknown: no check followed). to null: still going on. Paged: limit (default 50, up to ${RUNS_MAX}), offset, total, nextOffset; pass the returned window.to as to for the next pages, and start again when latestIds changes.`,
    {
      worker: z.string().min(1).optional(),
      id: z.string().uuid().optional(),
      hours: z.number().int().min(1).max(HOURS_MAX).optional(),
      limit: z.number().int().min(1).max(RUNS_MAX).optional(),
      offset: z.number().int().min(0).max(OFFSET_MAX).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    },
    async (a) => {
      if (!a.worker === !a.id) throw new Error("Give either worker (its name) or id (its id).")
      const parsed = historyQuery.parse({ hours: a.hours, limit: a.limit, offset: a.offset, to: a.to })
      try {
        return await workerHealth(ctx, a.id ? { id: a.id } : { name: a.worker }, parsed)
      } catch (e) {
        if (!(e instanceof WorkerHealthError)) throw e
        if (e.code === "not_found") return null
        throw new Error(e.code === "ambiguous" ? `${e.message} Ids: ${e.ids.join(", ")}.` : e.message)
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
    kind: Kind,
    run: (args: Args) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: kind === "read", destructiveHint: false, openWorldHint: false },
      },
      (async (args: Args) =>
        guard(name, kind, args, async () => {
          try {
            return json(await run(args))
          } catch (e) {
            if (e instanceof AccessError) return { ...json({ error: e.code, message: e.message }), isError: true }
            throw e
          }
        })) as never,
    )

  accessTool(
    "request_instance_access",
    "Ask for temporary access to the API of one or more n8n instances, for a task: several in instances, each with its own scopes and workflows, or one in instance with scopes. A person approves, possibly after changing the instances, scopes, workflows or minutes, or denies; poll get_access_request for the result and the key. Approvers hear of it on the default channels, or in notify on the ones the person asked you for. If you do not know which instance has the workflow, find it with search_workflows first. Ask only for the instances, scopes, workflows and minutes the task needs.",
    accessRequestShape,
    "act",
    (a) => {
      const input = accessInput(a as AccessRequestBody)
      if (typeof input === "string") throw new AccessError("invalid", input)
      return requestAccess(ctx, access.tokenId, input)
    },
  )
  accessTool(
    "get_access_request",
    "Status of an access request; notifiedVia lists the channels the approvers were told on so far. Once approved it returns, in instances, what was granted on each instance with its baseUrl (the approver may have changed what you asked for), and the key one time only: one key for every granted instance. Reading it once approved spends the key, so it is an action: if its answer is lost, the key is gone. Call the n8n public API at an instance's baseUrl with the key in the X-N8N-API-KEY header, exactly as with n8n.",
    { requestId: z.string().uuid() },
    "act",
    (a) => collectAccess(ctx, access.tokenId, a.requestId, access.publicUrl),
  )
  accessTool(
    "release_instance_access",
    "End your access once the task is finished and checked, or cancelled or given up; the key stops working at once. In summary, tell the person what you did with the access and the result, in a few sentences.",
    { requestId: z.string().uuid(), ...releaseShape },
    "act",
    (a) => releaseAccess(ctx, access.tokenId, a.requestId, a.summary),
  )
  return server
}

/**
 * MCP over Streamable HTTP at /mcp (requirement E2). Bearer token of kind "mcp". A browser's request is accepted only
 * from n8n-ops's own origin (the MCP transport specification; the SDK leaves Origin to middleware); a request without
 * Origin, from a program, passes. Every tool call is checked again against the connection, runs within the limits,
 * and leaves an audit entry with its outcome.
 */
export function mcpRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    if (origin !== undefined && origin !== issuerOf((await ctx.settings.get("general")).publicUrl))
      return c.json({ error: "forbidden", message: "This origin may not call the MCP server." }, 403)
    await next()
  })
  app.use("*", requireToken(ctx, "mcp"))
  app.all("/", async (c) => {
    const who = c.get("actor") as TokenActor
    const actor = actorName(who)
    const s = slotsFor(ctx)
    const record = (tool: string, kind: Kind, args: unknown, outcome: Outcome) =>
      ctx.audit({
        actor,
        action: kind === "read" ? "MCP read" : "MCP action",
        target: `${tool} ${JSON.stringify(args)}`.slice(0, 300),
        via: "mcp",
        details: { tool, outcome },
      })
    const guard: ToolGuard = async (tool, kind, args, run) => {
      const fail = (body: object) => ({ ...json(body), isError: true })
      // The call may have waited, and the connection may have ended since the request's token was checked.
      if (!who.manual && !(await ctx.agents?.stillLive(who.id))) {
        await record(tool, kind, args, "denied")
        return fail({ error: "connection_ended", message: "This connection has ended. Connect again." })
      }
      if (!s.take(who.id)) {
        await record(tool, kind, args, "denied")
        return fail(busy)
      }
      const work = run().finally(() => s.give(who.id))
      let done: Awaited<ReturnType<typeof within<Awaited<typeof work>>>>
      try {
        done = await within(work, LIMITS.deadlineMs)
      } catch (e) {
        await record(tool, kind, args, "error")
        throw e
      }
      if (done.late) {
        work.catch(() => undefined)
        await record(tool, kind, args, "unknown")
        return fail(unknown)
      }
      // The same answer cap as the REST API; the tool ran, and an action says so.
      const size = done.value.content.reduce((n, part) => n + Buffer.byteLength(part.text), 0)
      if (size > LIMITS.answerBytes) {
        await record(tool, kind, args, "error")
        return fail({
          error: "answer_too_large",
          message: `The answer is larger than ${LIMITS.answerBytes / 1024 / 1024} MB. Ask for less (a filter, a smaller limit).${kind === "act" ? " The action ran." : ""}`,
        })
      }
      await record(tool, kind, args, done.value.isError ? "error" : "ok")
      return done.value
    }
    const access = who.canRequestAccess ? { tokenId: who.id, publicUrl: await publicBase(ctx, c.req.url) } : undefined
    const server = buildMcpServer(ctx, async () => {}, access, {
      guard,
      getAccess: () => accessAnswer(ctx, who, undefined),
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: LIMITS.bodyBytes,
    })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
