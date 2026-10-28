import {
  capabilityKeys,
  capabilityProblems,
  capabilityStatus,
  chosenCapabilitiesSchema,
  missingScopes,
  requirementsOf,
} from "@n8n-ops/shared"
import { asc, desc, eq, inArray } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import {
  backupDestinations,
  backupRuns,
  instanceBackupDestinations,
  instances,
  workers,
  workflows,
} from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { instanceOverridesSchema } from "../lib/settings.ts"
import { policyScopes } from "../services/access.ts"
import { canReach } from "../services/backups.ts"
import { currentHealth, healthNow } from "../services/collection.ts"
import { checkDirect } from "../services/health.ts"
import { RevisionChanged, TargetProblem, targetProblem, updateInstance } from "../services/instance-update.ts"
import {
  can,
  effectiveScopes,
  type Instance,
  isActive,
  latestN8nVersion,
  mainTarget,
  metricsUrlOf,
  refreshInstanceMeta,
  testKey,
  unsupportedVersion,
} from "../services/instances.ts"
import { openProblemCount, openProblemsByInstance } from "../services/problem-view.ts"
import { deleteInstance, pollInstance } from "../services/problems.ts"
import { currentDetail, instanceProxyFix } from "../services/proxy-fix.ts"
import {
  activate,
  checkApi,
  checkBackup,
  checkHealthDirect,
  checkWorker,
  proposal,
  RequirementNotMet,
  removeCapability,
  SetupRefused,
  setupState,
} from "../services/setup.ts"
import { WORKER_ONLINE_MS } from "./overview.ts"

const url = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must start with http:// or https://")

const baseFields = {
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash and underscore only"),
  baseUrl: url,
  containerName: z.string().max(128).nullish(),
  // The main as a Compose project and service (Compose's project rule; a plain service name), instead of a name.
  composeProject: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,62}$/,
      "lowercase letters, digits, dash and underscore, starting with a letter or digit",
    )
    .nullish(),
  composeService: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, "letters, digits, dot, dash and underscore only")
    .nullish(),
  queueMode: z.boolean().default(false),
  metricsUrl: url.nullish().or(z.literal("")),
  workerHealthUrls: z.array(url).default([]),
  collection: z.enum(["direct", "worker"]).default("direct"),
  workerId: z.string().uuid().nullish(),
}
const backupVia = z.enum(["worker", "api"])
/** A draft: what it is chosen for and where it is; the key and the checks come in its setup. */
const createSchema = z.object({ ...baseFields, chosen: chosenCapabilitiesSchema, backupVia: backupVia.default("api") })
export const updateSchema = z
  .object({
    ...baseFields,
    // Without their defaults: Zod 4 fills a default in also under .partial(), so a change of one field (a setup
    // step, the overrides) would otherwise put the collection, the queue mode and the worker URLs back to theirs.
    queueMode: z.boolean(),
    workerHealthUrls: z.array(url),
    collection: z.enum(["direct", "worker"]),
    /** A new key, tested before it is stored; null removes the stored key. */
    apiKey: z.string().min(10).nullable().optional(),
    /** Only while the instance is a draft; an active one adds and removes capabilities on their own. */
    chosen: chosenCapabilitiesSchema.optional(),
    backupVia: backupVia.optional(),
    overrides: instanceOverridesSchema.optional(),
    agentAccess: z.object({ enabled: z.boolean(), scopes: z.array(z.string().max(80)).max(300) }).optional(),
  })
  .partial()
const capability = z.enum(capabilityKeys)

/** `?add=monitor,map`: the capabilities a setup page proposes to add; undefined when not given. */
function addOf(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, add: undefined }
  const parsed = z.array(capability).safeParse(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return parsed.success ? { ok: true as const, add: parsed.data } : { ok: false as const }
}

export function instanceView(instance: Instance, extra: { openProblems?: number; hasWorker: boolean }) {
  // The check counters and the backlog start are bookkeeping of the health checks, not part of the instance; the
  // setup checks are read through GET /:id/setup.
  const {
    apiKeyEnc,
    executionCursor: _cursor,
    healthCheckSeq: _seq,
    healthAppliedSeq: _applied,
    collectionRevision: _revision,
    backlogSince: _backlog,
    setupChecks: _checks,
    setupAttemptSeq: _attempts,
    chosenCapabilities,
    ...rest
  } = instance
  const scopes = effectiveScopes(instance)
  const unsupported = unsupportedVersion(instance)
  const grantable = policyScopes(instance).length
  return {
    ...rest,
    hasApiKey: Boolean(apiKeyEnc),
    chosen: chosenCapabilities,
    unsupportedVersion: unsupported,
    effectiveScopes: scopes,
    effectiveMetricsUrl: metricsUrlOf(instance),
    capabilities: capabilityStatus(scopes, extra.hasWorker, grantable),
    // Each chosen capability with what keeps it from working now (empty when nothing does).
    chosenStatus: capabilityProblems(chosenCapabilities, {
      hasKey: Boolean(apiKeyEnc),
      scopes: instance.scopes,
      unsupported,
      collection: instance.collection,
      backupVia: instance.backupVia,
      worker: extra.hasWorker && mainTarget(instance) !== null,
      grantable,
    }),
    openProblems: extra.openProblems ?? 0,
  }
}

/** A setup step's refusal as an answer; anything else is an internal error. */
function setupRefusal(c: Context<Env>, error: unknown) {
  if (error instanceof RevisionChanged) return c.json({ error: "revision_changed", message: error.message }, 409)
  if (error instanceof RequirementNotMet)
    return c.json({ error: "requirement_not_met", requirement: error.requirement, message: error.message }, 409)
  if (error instanceof SetupRefused) return c.json({ error: "invalid", message: error.message }, 400)
  throw error
}

/** The worker assigned to an instance as the pages show it. In collection mode "worker", only one online checks. */
function workerSummary(worker: typeof workers.$inferSelect | undefined) {
  if (!worker) return null
  const { id, name, lastSeenAt, revokedAt } = worker
  return {
    id,
    name,
    lastSeenAt,
    online: Boolean(!revokedAt && lastSeenAt && Date.now() - lastSeenAt.getTime() < WORKER_ONLINE_MS),
  }
}

export function instanceRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(instances).orderBy(asc(instances.name))
    const open = await openProblemsByInstance(ctx)
    const lastBackups = await Promise.all(
      rows.map(async (r) => {
        const [b] = await ctx.db
          .select({ status: backupRuns.status, at: backupRuns.startedAt })
          .from(backupRuns)
          .where(eq(backupRuns.instanceId, r.id))
          .orderBy(desc(backupRuns.startedAt))
          .limit(1)
        return b ?? null
      }),
    )
    const assigned = await ctx.db.select().from(workers)
    const now = await currentHealth(ctx, rows)
    return c.json({
      latestVersion: await latestN8nVersion(),
      instances: rows.map((r, i) => ({
        ...instanceView(r, {
          openProblems: open.find((o) => o.instanceId === r.id)?.n ?? 0,
          hasWorker: Boolean(r.workerId),
        }),
        ...now.get(r.id),
        worker: workerSummary(assigned.find((w) => w.id === r.workerId)),
        lastBackup: lastBackups[i],
      })),
    })
  })

  app.post("/test", async (c) => {
    const body = z.object({ baseUrl: url, apiKey: z.string().min(10) }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    return c.json(await testKey(body.data.baseUrl, body.data.apiKey))
  })

  /** Creates a draft (Setup incomplete): it does nothing in the background until its setup is completed. */
  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const problem = targetProblem(parsed.data)
    if (problem) return c.json({ error: "invalid", message: problem }, 400)
    const { metricsUrl, chosen, ...data } = parsed.data
    const [existing] = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.name, data.name))
    if (existing) return c.json({ error: "invalid", issues: [{ path: ["name"], message: "already used" }] }, 400)
    const [row] = await ctx.db
      .insert(instances)
      .values({
        ...data,
        metricsUrl: metricsUrl || null,
        apiKeyEnc: null,
        setupState: "incomplete",
        chosenCapabilities: chosen,
      })
      .returning()
    if (!row) return c.json({ error: "internal_error" }, 500)
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Instance added (setup incomplete)",
      target: row.name,
      via: "web",
      details: { chosen },
    })
    changed(ctx, "instances")
    return c.json({ id: row.id, configRevision: row.configRevision })
  })

  app.get("/:id", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const open = { n: await openProblemCount(ctx, { instanceId: row.id }) }
    const worker = row.workerId
      ? (await ctx.db.select().from(workers).where(eq(workers.id, row.workerId)))[0]
      : undefined
    const wfs = await ctx.db
      .select({ active: workflows.active, runs: workflows.runs30d })
      .from(workflows)
      .where(eq(workflows.instanceId, row.id))
    const effectiveSettings = await ctx.settings.forInstance(row.overrides)
    return c.json({
      ...instanceView(row, { openProblems: open?.n ?? 0, hasWorker: Boolean(worker && !worker.revokedAt) }),
      // The health now, beside the stored one it may only be the last known of.
      ...healthNow(row, worker, effectiveSettings.healthIntervalSec),
      worker: workerSummary(worker),
      // What the socket proxy refused in the current report, with the exact lines that allow it.
      proxyFix: await instanceProxyFix(ctx, row, worker),
      // A Compose service needs a worker of a release that follows one (services/backups.ts canReach).
      composeNeedsUpdate: Boolean(row.composeProject && worker && !worker.revokedAt && !canReach(worker, row)),
      // The container the service resolved to, from a report of the current settings only (none after a change).
      resolvedContainer: row.composeProject ? (currentDetail(row)?.resolvedContainer ?? null) : null,
      workflowCounts: {
        total: wfs.length,
        active: wfs.filter((w) => w.active).length,
        runs30d: wfs.reduce((n, w) => n + w.runs, 0),
      },
      effectiveSettings,
      latestVersion: await latestN8nVersion(),
      backupDestinationIds: (
        await ctx.db
          .select({ id: instanceBackupDestinations.destinationId })
          .from(instanceBackupDestinations)
          .where(eq(instanceBackupDestinations.instanceId, row.id))
      ).map((r) => r.id),
    })
  })

  /** Where this instance's backups go: the default destinations as they change, or the ones chosen here. */
  app.put("/:id/backup-destinations", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const body = z
      .object({ mode: z.enum(["default", "custom"]), destinationIds: z.array(z.string().uuid()).max(50).default([]) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    const ids = [...new Set(body.data.destinationIds)]
    const known = ids.length
      ? await ctx.db
          .select({ id: backupDestinations.id })
          .from(backupDestinations)
          .where(inArray(backupDestinations.id, ids))
      : []
    if (known.length !== ids.length)
      return c.json({ error: "invalid", message: "A chosen destination no longer exists." }, 400)
    await ctx.db.transaction(async (tx) => {
      // A backup check compares the destinations it tested with those in use now, so it notices this change.
      await tx
        .update(instances)
        .set({ backupDestinations: body.data.mode, updatedAt: new Date() })
        .where(eq(instances.id, row.id))
      await tx.delete(instanceBackupDestinations).where(eq(instanceBackupDestinations.instanceId, row.id))
      // The choice is kept while defaults are used, so switching back restores it.
      if (ids.length)
        await tx
          .insert(instanceBackupDestinations)
          .values(ids.map((destinationId) => ({ instanceId: row.id, destinationId })))
    })
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Instance backup destinations changed",
      target: row.name,
      via: "web",
      details: { mode: body.data.mode, destinations: ids.length },
    })
    return c.json({ ok: true })
  })

  app.patch("/:id", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const { apiKey, metricsUrl, chosen, ...data } = parsed.data
    if (chosen && isActive(row))
      return c.json(
        {
          error: "invalid",
          message: "An active instance adds a capability through its setup, and removes one on its own.",
        },
        400,
      )
    // The stored key was tested against the old address: a new one needs the key again, or no key.
    const urlChanged = data.baseUrl !== undefined && data.baseUrl !== row.baseUrl
    if (urlChanged && row.apiKeyEnc && apiKey === undefined)
      return c.json(
        { error: "key_required", message: "A new base URL needs the API key again. Enter it, or remove the key." },
        400,
      )
    // Any valid key is stored; the capabilities it lacks scopes for show on the instance's page.
    const test = apiKey ? await testKey(data.baseUrl ?? row.baseUrl, apiKey) : null
    if (test && !test.ok) return c.json({ error: "connection_failed", code: test.code, message: test.error }, 400)
    let updated: Awaited<ReturnType<typeof updateInstance>>
    try {
      updated = await updateInstance(
        ctx,
        row.id,
        {
          ...data,
          ...(chosen ? { chosenCapabilities: chosen } : {}),
          ...(metricsUrl !== undefined ? { metricsUrl: metricsUrl || null } : {}),
          ...(apiKey && test?.ok
            ? { apiKeyEnc: ctx.secrets.encrypt(apiKey), scopes: test.scopes, scopesCheckedAt: new Date() }
            : {}),
          ...(apiKey === null ? { apiKeyEnc: null, scopes: null, scopesCheckedAt: null } : {}),
        },
        // A tested key is stored only for the configuration it was tested with.
        test ? row.configRevision : undefined,
      )
    } catch (error) {
      if (error instanceof TargetProblem) return c.json({ error: "invalid", message: error.message }, 400)
      if (error instanceof RevisionChanged) return c.json({ error: "revision_changed", message: error.message }, 409)
      throw error
    }
    if (updated && (apiKey || urlChanged))
      await refreshInstanceMeta(ctx, updated).catch((e: Error) =>
        ctx.log.warn("reading the version and scopes failed", { instance: row.name, error: e.message }),
      )
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: apiKey ? "Instance API key replaced" : apiKey === null ? "Instance API key removed" : "Instance changed",
      target: row.name,
      via: "web",
      details: { fields: Object.keys(parsed.data).filter((k) => k !== "apiKey") },
    })
    return c.json({ ok: true, configRevision: updated?.configRevision ?? row.configRevision })
  })

  app.delete("/:id", async (c) => {
    const id = c.req.param("id")
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404)
    // With its workflows, failures and the Problems it leaves without a workflow.
    const row = await deleteInstance(ctx, id)
    if (!row) return c.json({ error: "not_found" }, 404)
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Instance removed", target: row.name, via: "web" })
    return c.json({ ok: true })
  })

  /** Re-reads version and scopes, checks health and polls failures now: each only where it was chosen. */
  app.post("/:id/refresh", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    if (!isActive(row))
      return c.json({ error: "setup_incomplete", message: `Finish the setup of ${row.name} first.` }, 409)
    const fresh = (await refreshInstanceMeta(ctx, row)) ?? row
    const skipped: string[] = []
    if (!can(fresh, "health")) skipped.push("Health is not chosen, so it was not checked.")
    else if (fresh.collection === "direct") await checkDirect(ctx, fresh.id)
    if (!can(fresh, "monitor")) skipped.push("Monitoring is not chosen, so failures were not read.")
    const poll = can(fresh, "monitor")
      ? await pollInstance(ctx, fresh).catch((e: Error) => ({ error: e.message }))
      : null
    return c.json({ ok: true, poll, skipped })
  })

  // --- Setup (docs/adr/0002): the checks of a draft, or of capabilities added to an active instance.

  const load = async (id: string) => {
    if (!z.string().uuid().safeParse(id).success) return null
    const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
    return row ?? null
  }

  /** The selection (`?add=` proposes one), its requirements and each check as it stands now. */
  app.get("/:id/setup", async (c) => {
    const add = addOf(c.req.query("add"))
    if (!add.ok) return c.json({ error: "invalid", message: "Unknown capability in add." }, 400)
    const row = await load(c.req.param("id"))
    if (!row) return c.json({ error: "not_found" }, 404)
    return c.json(await setupState(ctx, row, add.add))
  })

  app.post("/:id/setup/api", async (c) => {
    const body = z
      .object({ apiKey: z.string().min(10).optional(), add: z.array(capability).optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      const result = await checkApi(ctx, c.req.param("id"), body.data.apiKey)
      if (!result) return c.json({ error: "not_found" }, 404)
      const { check, keyStored, instance } = result
      if (keyStored)
        await ctx.audit({
          actor: actorName(c.get("actor")),
          action: instance.apiKeyEnc ? "Instance API key replaced" : "Instance API key added",
          target: instance.name,
          via: "web",
        })
      const scopes = (check.detail?.scopes as string[] | undefined) ?? []
      const { verify } = proposal(instance, body.data.add)
      const missing = check.ok ? missingScopes(requirementsOf(verify, instance).api, scopes) : {}
      return c.json({
        ok: check.ok,
        reason: check.reason ?? null,
        code: (check.detail?.code as string | undefined) ?? null,
        version: check.detail?.version ?? null,
        scopes: check.ok ? scopes : null,
        missingByCapability: missing,
        keyStored,
      })
    } catch (error) {
      return setupRefusal(c, error)
    }
  })

  app.post("/:id/setup/health", async (c) => {
    try {
      const check = await checkHealthDirect(ctx, c.req.param("id"))
      if (!check) return c.json({ error: "not_found" }, 404)
      return c.json({
        ok: check.ok,
        reason: check.reason ?? null,
        detail: check.detail,
      })
    } catch (error) {
      return setupRefusal(c, error)
    }
  })

  /** Starts the worker check, or answers with the one still running; GET /:id/setup tells how it ends. */
  app.post("/:id/setup/worker", async (c) => {
    try {
      const started = await checkWorker(ctx, c.req.param("id"))
      if (!started) return c.json({ error: "not_found" }, 404)
      return c.json(started)
    } catch (error) {
      return setupRefusal(c, error)
    }
  })

  app.post("/:id/setup/backup", async (c) => {
    try {
      const check = await checkBackup(ctx, c.req.param("id"))
      if (!check) return c.json({ error: "not_found" }, 404)
      return c.json({
        ok: check.ok,
        reason: check.reason ?? null,
        detail: check.detail,
      })
    } catch (error) {
      return setupRefusal(c, error)
    }
  })

  /** Activates a draft, or adds capabilities to an active instance, once every requirement has a current check. */
  app.post("/:id/activate", async (c) => {
    const body = z
      // A configRevision sent along is ignored: each check records the settings it was made for.
      .object({ add: z.array(capability).optional(), configRevision: z.number().int().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      const result = await activate(ctx, c.req.param("id"), body.data)
      if (!result) return c.json({ error: "not_found" }, 404)
      const { instance, added, wasDraft } = result
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: wasDraft ? "Instance setup completed" : "Capability added",
        target: instance.name,
        via: "web",
        details: { [wasDraft ? "chosen" : "added"]: wasDraft ? instance.chosenCapabilities : added },
      })
      return c.json({
        ok: true,
        setupState: instance.setupState,
        chosen: instance.chosenCapabilities,
        configRevision: instance.configRevision,
      })
    } catch (error) {
      return setupRefusal(c, error)
    }
  })

  /** Removes a capability and what needs it (removing the map removes Move workflows). No check is needed. */
  app.delete("/:id/capabilities/:capability", async (c) => {
    const key = capability.safeParse(c.req.param("capability"))
    if (!key.success) return c.json({ error: "invalid", message: "Unknown capability." }, 400)
    const row = await load(c.req.param("id"))
    if (!row) return c.json({ error: "not_found" }, 404)
    const result = await removeCapability(ctx, row.id, key.data)
    if (!result) return c.json({ error: "not_found" }, 404)
    if (result.removed.length) {
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: "Capability removed",
        target: row.name,
        via: "web",
        details: { removed: result.removed },
      })
      changed(ctx, "instances", "overview", "backups")
    }
    return c.json({
      ok: true,
      removed: result.removed,
      chosen: result.instance.chosenCapabilities,
      configRevision: result.instance.configRevision,
    })
  })

  return app
}
