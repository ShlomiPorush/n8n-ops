import { createHash } from "node:crypto"
import {
  belowMinimum,
  type CapabilityKey,
  capabilityLabels,
  missingScopes,
  type Requirements,
  requirementsOf,
  unsupportedVersionText,
  withDependencies,
  withoutDependents,
} from "@n8n-ops/shared"
import { and, eq, inArray, like, or, sql } from "drizzle-orm"
import type { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { alertState, instances, type SetupCheck, type SetupCheckKind, workerJobs, workers } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { policyScopes } from "./access.ts"
import { endRunsWithoutArchive } from "./backup-copies.ts"
import { canReach, jobTarget, probePayload } from "./backups.ts"
import { reportsSince } from "./collection.ts"
import { destinationsFor, testDestination } from "./destinations/index.ts"
import { collectDirect, probeReport } from "./health.ts"
import { RevisionChanged } from "./instance-update.ts"
import { healthTurn, type Instance, isActive, mainTarget, refreshInstanceMeta, testKey } from "./instances.ts"
import type { DbLike } from "./problems.ts"
import { jobProxyFix } from "./proxy-fix.ts"
import { enqueueJob } from "./workers.ts"

/*
 * The setup of an instance (docs/adr/0002): each check proves one requirement of the chosen capabilities and
 * stores its result in `setup_checks`, bound to the configuration revision it was made for. Checks never apply
 * health or alerts. Activation verifies the stored results under the row's lock.
 */

/** A setup check that has not ended by then has failed. */
export const SETUP_DEADLINE_MS = 90_000
/** An API, health or worker result older than this is checked again before it counts. */
export const EVIDENCE_FRESH_MS = 15 * 60_000

/** A setup step that cannot run as asked; its message says what to do. */
export class SetupRefused extends Error {}

/** Activation refused: a requirement is not met by a current check. */
export class RequirementNotMet extends Error {
  constructor(
    readonly requirement: SetupCheckKind | "access",
    message: string,
  ) {
    super(message)
  }
}

/**
 * What a setup page verifies, and the selection after activation. A draft verifies its whole selection (`add`
 * when given, else what it stored); an active instance only what `add` brings that it does not have yet.
 */
export function proposal(instance: Pick<Instance, "setupState" | "chosenCapabilities">, add?: CapabilityKey[]) {
  if (!isActive(instance)) {
    const after = add ? withDependencies(add) : instance.chosenCapabilities
    return { verify: after, after }
  }
  const after = withDependencies([...instance.chosenCapabilities, ...(add ?? [])])
  return { verify: after.filter((k) => !instance.chosenCapabilities.includes(k)), after }
}

/** Takes the instance's next attempt number, and the row as it is in that same statement. */
async function startAttempt(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .update(instances)
    .set({ setupAttemptSeq: sql`${instances.setupAttemptSeq} + 1` })
    .where(eq(instances.id, id))
    .returning()
  return row ? { instance: row, attempt: row.setupAttemptSeq, startedAt: new Date().toISOString() } : null
}

const attemptOf = (kind: SetupCheckKind) =>
  sql`coalesce((${instances.setupChecks} -> ${sql.raw(`'${kind}'`)} ->> 'attempt')::bigint, 0)`

/**
 * Stores a check's result, only while no later attempt of the same kind was stored and the configuration revision
 * is still `readRevision`, the one read before the check's I/O. `extra` is written in the same statement.
 */
async function storeCheck(
  db: DbLike,
  id: string,
  kind: SetupCheckKind,
  check: SetupCheck,
  readRevision = check.configRevision,
  extra: Partial<typeof instances.$inferInsert> = {},
) {
  const [saved] = await db
    .update(instances)
    .set({ ...extra, setupChecks: sql`${instances.setupChecks} || ${JSON.stringify({ [kind]: check })}::jsonb` })
    .where(
      and(
        eq(instances.id, id),
        eq(instances.configRevision, readRevision),
        sql`${attemptOf(kind)} <= ${check.attempt}`,
      ),
    )
    .returning({ id: instances.id })
  return Boolean(saved)
}

/** A result that was not stored: RevisionChanged when the configuration moved; a later attempt is no error. */
async function notStored(ctx: Ctx, id: string, revision: number) {
  const [now] = await ctx.db
    .select({ configRevision: instances.configRevision })
    .from(instances)
    .where(eq(instances.id, id))
  if (!now || now.configRevision !== revision) throw new RevisionChanged()
}

const done = (started: { attempt: number; startedAt: string }, revision: number) => ({
  attempt: started.attempt,
  startedAt: started.startedAt,
  configRevision: revision,
  status: "done" as const,
  at: new Date().toISOString(),
})

/**
 * The API check: n8n answers, accepts the key and is 2.14.0 or later, with the key's scopes. A typed key is
 * stored only when it passes, in one statement with its result and the next revision, and only while the
 * revision is still the one read before the test; otherwise RevisionChanged and nothing is stored.
 */
export async function checkApi(ctx: Ctx, id: string, typedKey?: string) {
  const started = await startAttempt(ctx, id)
  if (!started) return null
  const row = started.instance
  const revision = row.configRevision
  const key = typedKey ?? (row.apiKeyEnc ? ctx.secrets.decrypt(row.apiKeyEnc) : null)
  if (!key) throw new SetupRefused("Enter the API key of this n8n instance.")
  const test = await testKey(row.baseUrl, key)
  const check: SetupCheck = test.ok
    ? { ...done(started, revision), ok: true, detail: { version: test.version, scopes: test.scopes } }
    : {
        ...done(started, revision),
        ok: false,
        reason: test.error,
        detail: { version: test.version, code: test.code },
      }
  if (typedKey && test.ok) {
    const stored = { ...check, configRevision: revision + 1 }
    const saved = await storeCheck(ctx.db, id, "api", stored, revision, {
      apiKeyEnc: ctx.secrets.encrypt(typedKey),
      configRevision: revision + 1,
      scopes: test.scopes,
      scopesCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    if (!saved) throw new RevisionChanged()
    return { check: stored, keyStored: true, instance: row }
  }
  const extra = test.ok ? { scopes: test.scopes, scopesCheckedAt: new Date() } : {}
  if (!(await storeCheck(ctx.db, id, "api", check, revision, extra))) await notStored(ctx, id, revision)
  return { check, keyStored: false, instance: row }
}

/** The direct health check: the probes the server makes, with their detail; nothing is applied. */
export async function checkHealthDirect(ctx: Ctx, id: string) {
  const started = await startAttempt(ctx, id)
  if (!started) return null
  const row = started.instance
  const { via: _via, ...report } = await collectDirect(row)
  const main = report.main
  const check: SetupCheck = {
    ...done(started, row.configRevision),
    ok: main.ok,
    ...(main.ok
      ? {}
      : {
          reason: `n8n did not answer at ${row.baseUrl.replace(/\/+$/, "")}/healthz: ${main.error ?? `HTTP ${main.status}`}`,
        }),
    detail: report,
  }
  if (!(await storeCheck(ctx.db, id, "health", check))) await notStored(ctx, id, row.configRevision)
  return check
}

/**
 * The worker check: one probe that reads inside the main, whatever the collection mode. Made in the instance's
 * turn; a probe of the current attempt (same revision and worker, inside its deadline, not lost to a restart) is
 * reused, older queued ones are deleted. The result comes back through setupWorkerResult; pages poll the setup.
 */
export function checkWorker(ctx: Ctx, id: string) {
  return oneAtATime(healthTurn(id), async () => {
    const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
    if (!row) return null
    if (!row.workerId) throw new SetupRefused("Choose the worker on this instance's host first.")
    if (!mainTarget(row))
      throw new SetupRefused("Set the main: its container name, or its Compose project and service.")
    const [worker] = await ctx.db.select().from(workers).where(eq(workers.id, row.workerId))
    if (!worker || worker.revokedAt) throw new SetupRefused("The chosen worker was removed. Choose another one.")
    if (!canReach(worker, row))
      throw new SetupRefused(
        `${worker.name} runs a release that cannot follow a Compose service. Update its image, or name the main container.`,
      )
    const previous = row.setupChecks.worker
    if (
      previous?.status === "running" &&
      previous.jobId &&
      previous.configRevision === row.configRevision &&
      previous.workerId === row.workerId &&
      Date.now() - Date.parse(previous.startedAt) < SETUP_DEADLINE_MS
    ) {
      const [job] = await ctx.db
        .select()
        .from(workerJobs)
        .where(and(eq(workerJobs.id, previous.jobId), inArray(workerJobs.status, ["queued", "running"])))
      if (job && !(job.startedAt && job.startedAt < reportsSince(job.workerId)))
        return { jobId: job.id, attempt: previous.attempt, deadline: deadlineOf(previous), reused: true }
    }
    // Older setup probes nobody took yet are not wanted any more.
    await ctx.db
      .delete(workerJobs)
      .where(
        and(
          eq(workerJobs.instanceId, id),
          eq(workerJobs.kind, "probe"),
          eq(workerJobs.status, "queued"),
          sql`${workerJobs.payload} ? 'setup'`,
        ),
      )
    const started = await startAttempt(ctx, id)
    if (!started) return null
    const now = started.instance
    if (now.workerId !== worker.id || !mainTarget(now)) throw new RevisionChanged()
    const job = await enqueueJob(
      ctx,
      worker.id,
      "probe",
      { ...probePayload(now, undefined, true), setup: { attempt: started.attempt } },
      id,
    )
    const check: SetupCheck = {
      attempt: started.attempt,
      startedAt: started.startedAt,
      configRevision: now.configRevision,
      status: "running",
      workerId: worker.id,
      jobId: job.id,
      detail: { inside: jobTarget(now) },
    }
    if (!(await storeCheck(ctx.db, id, "worker", check))) {
      await ctx.db.delete(workerJobs).where(and(eq(workerJobs.id, job.id), eq(workerJobs.status, "queued")))
      await notStored(ctx, id, now.configRevision)
      return null
    }
    return { jobId: job.id, attempt: started.attempt, deadline: deadlineOf(check), reused: false }
  })
}

const deadlineOf = (check: Pick<SetupCheck, "startedAt">) =>
  new Date(Date.parse(check.startedAt) + SETUP_DEADLINE_MS).toISOString()

type ProbeReport = z.infer<typeof probeReport>

/**
 * What a worker check found. A command in the main works only when the report was read inside it, was collected
 * and the main is running (apps/worker inside.ts); the main is healthy when its /healthz also answered. A version
 * below 2.14.0 fails it.
 */
export function readWorkerReport(report: ProbeReport) {
  const failed = (reason: string) => ({ exec: false, healthy: false, reason, healthReason: reason })
  if (report.source !== "inside")
    return failed(
      report.fallback
        ? `The worker could not run a command in the main: ${report.fallback}`
        : "The worker read the main over the network, not inside it. Update the worker to this release.",
    )
  if (report.notCollected) return failed(`The check in the main did not finish: ${report.notCollected}`)
  if (report.mainState !== "running")
    return failed(
      report.mainState === "paused" ? "The main container is paused." : "The main container is not running.",
    )
  if (report.version && belowMinimum(report.version)) return failed(unsupportedVersionText(report.version))
  const healthy = report.main.ok
  return {
    exec: true,
    healthy,
    reason: null,
    healthReason: healthy
      ? null
      : `The main answered /healthz with ${report.main.error ?? `HTTP ${report.main.status}`}.`,
  }
}

/**
 * The worker's answer to a setup probe. Stored only for the attempt that is still the instance's latest, within its
 * deadline, for the revision it was made for, and from a worker that has not restarted since it took the job; a
 * late answer never revives an attempt that expired or was replaced. Returns what the job row keeps.
 */
export async function setupWorkerResult(
  ctx: Ctx,
  job: typeof workerJobs.$inferSelect,
  outcome: { ok: boolean; result: Record<string, unknown>; error?: string; current: boolean },
): Promise<Record<string, unknown>> {
  const parsed = outcome.ok ? probeReport.safeParse(outcome.result) : null
  const stored = parsed?.success ? parsed.data : {}
  if (!job.instanceId) return stored
  const [row] = await ctx.db.select().from(instances).where(eq(instances.id, job.instanceId))
  const check = row?.setupChecks.worker
  if (!row || !check || check.jobId !== job.id || check.status !== "running" || !outcome.current) return stored
  if (Date.now() - Date.parse(check.startedAt) >= SETUP_DEADLINE_MS) return stored
  const finished: SetupCheck = parsed?.success
    ? (() => {
        const read = readWorkerReport(parsed.data)
        return {
          ...check,
          status: "done",
          at: new Date().toISOString(),
          ok: read.exec,
          ...(read.reason ? { reason: read.reason } : {}),
          detail: { ...check.detail, report: parsed.data },
        }
      })()
    : {
        ...check,
        status: "done",
        at: new Date().toISOString(),
        ok: false,
        reason: outcome.error ?? "The worker sent a report n8n-ops could not read.",
      }
  await storeCheck(ctx.db, row.id, "worker", finished)
  changed(ctx, "instances")
  return stored
}

/** A short fingerprint of the backup key, so the check knows the key it tested is still the one in use. */
const fingerprint = (recipient: string) => createHash("sha256").update(recipient).digest("hex").slice(0, 16)

/** The backup check: the backup key, and a test of each destination the instance backs up to now. */
export async function checkBackup(ctx: Ctx, id: string) {
  const started = await startAttempt(ctx, id)
  if (!started) return null
  const row = started.instance
  const { backupRecipient } = await ctx.settings.get("keys")
  const destinations = await destinationsFor(ctx, row)
  const results = await Promise.all(
    destinations.map(async (d) => {
      const brief = { id: d.id, name: d.name, kind: d.kind, updatedAt: d.updatedAt.toISOString() }
      try {
        return { ...brief, ok: true, notes: await testDestination(ctx, d) }
      } catch (error) {
        return { ...brief, ok: false, error: (error as Error).message }
      }
    }),
  )
  const failing = results.filter((r) => !r.ok)
  const reason = !backupRecipient
    ? "No backup key. Generate one in Settings → Encryption Keys."
    : !destinations.length
      ? `${row.name} has no backup destination that is on. Create one in Settings → Backup Destinations, or choose others.`
      : failing.length
        ? `The test failed for ${failing.map((f) => `${f.name}: ${"error" in f ? f.error : "failed"}`).join("; ")}`
        : null
  const check: SetupCheck = {
    ...done(started, row.configRevision),
    ok: reason === null,
    ...(reason ? { reason } : {}),
    detail: {
      mode: row.backupDestinations,
      destinations: results,
      recipient: backupRecipient ? fingerprint(backupRecipient) : null,
    },
  }
  if (!(await storeCheck(ctx.db, id, "backup", check))) await notStored(ctx, id, row.configRevision)
  return check
}

/** One requirement on the setup page. */
export type CheckView = {
  /** ok: passed for the current configuration; failed: ran for it and did not pass; running: waiting for the
   * worker; stale: made for an earlier configuration, or too long ago; missing: never ran. */
  state: "ok" | "failed" | "running" | "stale" | "missing"
  /** The result is about the configuration as it is now (a running check is current until its deadline). */
  current: boolean
  ok: boolean
  reason: string | null
  attempt: number | null
  startedAt: string | null
  at: string | null
  deadline: string | null
  detail: Record<string, unknown> | null
}

const view = (check: SetupCheck | undefined, extra: Partial<CheckView>): CheckView => ({
  state: "missing",
  current: false,
  ok: false,
  reason: "Not checked yet.",
  attempt: check?.attempt ?? null,
  startedAt: check?.startedAt ?? null,
  at: check?.at ?? null,
  deadline: check ? deadlineOf(check) : null,
  detail: check?.detail ?? null,
  ...extra,
})

/** Why a stored result no longer counts, or null when it does. */
function staleness(row: Instance, kind: SetupCheckKind, check: SetupCheck, now: number) {
  if (check.configRevision !== row.configRevision) return "Checked before the instance's settings changed. Check again."
  if (kind !== "backup" && check.at && now - Date.parse(check.at) >= EVIDENCE_FRESH_MS)
    return "Checked more than 15 minutes ago. Check again."
  return null
}

type Options = { recipient: string | null; fixes: boolean }

/**
 * Each requirement of `verify` with its current check, from the stored results and the instance as it is now.
 * Reads through `ctx.db`, which activation sets to its transaction.
 */
export async function evaluate(ctx: Ctx, row: Instance, verify: CapabilityKey[], options: Options) {
  const requirements = requirementsOf(verify, row)
  const checks = row.setupChecks
  const now = Date.now()

  const finished = (kind: SetupCheckKind, judge: (check: SetupCheck) => { ok: boolean; reason: string | null }) => {
    const check = checks[kind]
    if (!check) return view(undefined, {})
    const stale = staleness(row, kind, check, now)
    if (stale) return view(check, { state: "stale", reason: stale })
    const judged = judge(check)
    return view(check, {
      state: judged.ok ? "ok" : "failed",
      current: true,
      ok: judged.ok,
      reason: judged.ok ? null : judged.reason,
    })
  }

  const api = requirements.api
    ? (() => {
        const result = finished("api", (check) => {
          if (!check.ok) return { ok: false, reason: check.reason ?? "The API check failed." }
          const missing = missingScopes(requirements.api, (check.detail?.scopes as string[] | undefined) ?? [])
          const lacks = Object.entries(missing).map(
            ([k, s]) => `${capabilityLabels[k as CapabilityKey]} needs ${s.join(", ")}`,
          )
          return lacks.length
            ? { ok: false, reason: `The API key lacks scopes. ${lacks.join("; ")}.` }
            : { ok: true, reason: null }
        })
        const scopes = (result.detail?.scopes as string[] | undefined) ?? []
        return {
          ...result,
          detail: {
            ...result.detail,
            missingByCapability: result.current ? missingScopes(requirements.api, scopes) : {},
          },
        }
      })()
    : null

  const health = requirements.health
    ? finished("health", (c) => ({ ok: Boolean(c.ok), reason: c.reason ?? null }))
    : null

  const worker = requirements.worker ? await workerView(ctx, row, requirements.worker, options, now) : null

  const backup = requirements.backup ? await backupView(ctx, row, options.recipient, now) : null

  const access = requirements.access
    ? (() => {
        const ok = policyScopes(row).length > 0
        return view(undefined, {
          state: ok ? "ok" : "failed",
          current: true,
          ok,
          reason: ok ? null : "Turn on Temporary access and allow at least one scope the API key grants.",
          deadline: null,
          detail: { enabled: row.agentAccess.enabled, grantable: policyScopes(row) },
        })
      })()
    : null

  const all = { api, health, worker, backup, access }
  const failing = (Object.entries(all) as [SetupCheckKind | "access", CheckView | null][]).find(([, v]) => v && !v.ok)
  return {
    requirements,
    checks: all,
    ready: !failing,
    failing: failing ? { kind: failing[0], view: failing[1] } : null,
  }
}

async function workerView(
  ctx: Ctx,
  row: Instance,
  need: NonNullable<Requirements["worker"]>,
  options: Options,
  now: number,
) {
  const check = row.setupChecks.worker
  if (!check) return view(undefined, {})
  const stale = staleness(row, "worker", check, now)
  if (stale) return view(check, { state: "stale", reason: stale })
  const [worker] = check.workerId ? await ctx.db.select().from(workers).where(eq(workers.id, check.workerId)) : []
  if (!worker || worker.revokedAt || row.workerId !== check.workerId || !canReach(worker, row))
    return view(check, { state: "stale", reason: "The worker changed or was removed since the check. Check again." })
  if (check.status === "running") {
    const [job] = check.jobId ? await ctx.db.select().from(workerJobs).where(eq(workerJobs.id, check.jobId)) : []
    const lost =
      !job ||
      job.status === "done" ||
      job.status === "failed" ||
      Boolean(job.startedAt && job.startedAt < reportsSince(job.workerId))
    if (lost || now >= Date.parse(deadlineOf(check)))
      return view(check, {
        state: "failed",
        current: true,
        reason:
          job?.status === "failed" && job.error
            ? job.error
            : lost
              ? `${worker.name} restarted or went offline before it answered. Check again.`
              : `${worker.name} did not answer within 90 seconds. Is it online?`,
      })
    return view(check, { state: "running", current: true, reason: null })
  }
  const report = check.detail?.report as ProbeReport | undefined
  const read = report ? readWorkerReport(report) : null
  const ok = Boolean(read && (need.healthy ? read.healthy : read.exec))
  const reason = ok
    ? null
    : read
      ? need.healthy
        ? read.healthReason
        : read.reason
      : (check.reason ?? "The worker check failed.")
  // What the socket proxy refused, with the lines that allow it, while the instance still has this worker and main.
  const refused = report?.access?.refused?.[0]
  const inside = (check.detail?.inside ?? {}) as { container?: string; target?: { project: string; service: string } }
  const proxyFix =
    !ok && refused && options.fixes && check.workerId
      ? await jobProxyFix(ctx, row, {
          workerId: check.workerId,
          container: inside.container ?? null,
          refused,
          ...(inside.target ? { target: inside.target } : {}),
        })
      : null
  return view(check, {
    state: ok ? "ok" : "failed",
    current: true,
    ok,
    reason,
    detail: {
      ...check.detail,
      exec: read?.exec ?? false,
      healthy: read?.healthy ?? false,
      ...(proxyFix ? { proxyFix } : {}),
    },
  })
}

async function backupView(ctx: Ctx, row: Instance, recipient: string | null, now: number) {
  const check = row.setupChecks.backup
  if (!check) return view(undefined, {})
  const stale = staleness(row, "backup", check, now)
  if (stale) return view(check, { state: "stale", reason: stale })
  // The destinations it backs up to now, each as it was tested, all on, and the same backup key.
  const tested = ((check.detail?.destinations ?? []) as { id: string; updatedAt: string }[])
    .map((d) => `${d.id}@${d.updatedAt}`)
    .sort()
  const nowSet = (await destinationsFor(ctx, row)).map((d) => `${d.id}@${d.updatedAt.toISOString()}`).sort()
  const sameKey = (check.detail?.recipient ?? null) === (recipient ? fingerprint(recipient) : null)
  if (JSON.stringify(tested) !== JSON.stringify(nowSet) || !sameKey)
    return view(check, {
      state: "stale",
      reason: "The backup destinations or the backup key changed since the check. Check again.",
    })
  return view(check, {
    state: check.ok ? "ok" : "failed",
    current: true,
    ok: Boolean(check.ok),
    reason: check.ok ? null : (check.reason ?? "The backup check failed."),
  })
}

/** The setup page: the selection, what it needs, and each check as it stands now. */
export async function setupState(ctx: Ctx, row: Instance, add?: CapabilityKey[]) {
  const { verify, after } = proposal(row, add)
  const { backupRecipient } = await ctx.settings.get("keys")
  const result = await evaluate(ctx, row, verify, { recipient: backupRecipient ?? null, fixes: true })
  return {
    id: row.id,
    name: row.name,
    setupState: row.setupState,
    configRevision: row.configRevision,
    baseUrl: row.baseUrl,
    collection: row.collection,
    backupVia: row.backupVia,
    workerId: row.workerId,
    hasApiKey: Boolean(row.apiKeyEnc),
    chosen: row.chosenCapabilities,
    verify,
    after,
    requirements: result.requirements,
    checks: result.checks,
    ready: result.ready && verify.length > 0,
    deadlineMs: SETUP_DEADLINE_MS,
    freshMs: EVIDENCE_FRESH_MS,
  }
}

/**
 * Activates a draft, or adds capabilities to an active instance. The API check runs again first, outside the lock;
 * then, with the row locked and the revision still the one the page saw, every requirement must have a current
 * passing check. The meta refresh after it runs outside the transaction; its failure does not undo activation.
 */
export async function activate(ctx: Ctx, id: string, input: { add?: CapabilityKey[]; configRevision: number }) {
  const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!row) return null
  if (row.configRevision !== input.configRevision) throw new RevisionChanged()
  const { verify, after } = proposal(row, input.add)
  if (!isActive(row) && !after.length) throw new SetupRefused("Choose at least one capability.")
  if (isActive(row) && !verify.length) throw new SetupRefused("These capabilities are already active.")
  if (requirementsOf(verify, row).api && row.apiKeyEnc) await checkApi(ctx, id)
  const { backupRecipient } = await ctx.settings.get("keys")
  const saved = await ctx.db.transaction(async (tx) => {
    const [now] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
    if (!now || now.configRevision !== input.configRevision) throw new RevisionChanged()
    const result = await evaluate({ ...ctx, db: tx as unknown as Ctx["db"] }, now, verify, {
      recipient: backupRecipient ?? null,
      fixes: false,
    })
    if (result.failing)
      throw new RequirementNotMet(result.failing.kind, result.failing.view?.reason ?? "A check did not pass.")
    const [updated] = await tx
      .update(instances)
      .set({
        setupState: "complete",
        chosenCapabilities: after,
        configRevision: sql`${instances.configRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(instances.id, id))
      .returning()
    return updated
  })
  if (!saved) return null
  await refreshInstanceMeta(ctx, saved).catch((error: Error) =>
    ctx.log.warn("reading the version and scopes after activation failed", {
      instance: saved.name,
      error: error.message,
    }),
  )
  changed(ctx, "instances", "overview")
  return { instance: saved, added: verify, wasDraft: !isActive(row) }
}

/**
 * Removes a capability, and what needs it. No check is needed. In the instance's turn and one transaction with the
 * row locked: the conditions of a removed capability end without a message, its queued jobs go, and backup runs
 * still waiting for their archive end without an alert. A run that has its archive finishes its copies.
 */
export function removeCapability(ctx: Ctx, id: string, capability: CapabilityKey) {
  return oneAtATime(healthTurn(id), () =>
    ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
      if (!row) return null
      const after = withoutDependents(row.chosenCapabilities, [capability])
      const removed = row.chosenCapabilities.filter((k) => !after.includes(k))
      if (!removed.length) return { instance: row, removed }
      const [saved] = await tx
        .update(instances)
        .set({
          chosenCapabilities: after,
          configRevision: sql`${instances.configRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(instances.id, id))
        .returning()
      const close = (why: string, ...keys: ReturnType<typeof eq>[]) =>
        tx
          .update(alertState)
          .set({ active: false, since: new Date(), detail: why })
          .where(and(eq(alertState.active, true), or(...keys)))
      if (removed.includes("health")) {
        await close(
          "Closed: health was turned off for the instance",
          eq(alertState.key, `down:${id}`),
          eq(alertState.key, `backlog:${id}`),
          like(alertState.key, `worker:${id}:%`),
        )
        await tx
          .delete(workerJobs)
          .where(
            and(
              eq(workerJobs.instanceId, id),
              eq(workerJobs.kind, "probe"),
              eq(workerJobs.status, "queued"),
              sql`not (${workerJobs.payload} ? 'setup')`,
            ),
          )
      }
      if (removed.includes("backup")) {
        await close("Closed: backup was turned off for the instance", like(alertState.key, `backup:${id}:%`))
        await endRunsWithoutArchive(tx, { instanceId: id })
        await tx
          .delete(workerJobs)
          .where(and(eq(workerJobs.instanceId, id), eq(workerJobs.kind, "backup"), eq(workerJobs.status, "queued")))
      }
      return { instance: saved ?? row, removed }
    }),
  )
}
