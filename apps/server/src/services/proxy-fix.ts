import {
  ALLOWED_LIMITS,
  CONTAINER_PATTERN,
  type MainInput,
  type NeededRule,
  neededRule,
  patternRegex,
  type SuggestedPattern,
} from "@n8n-ops/shared"
import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, workers } from "../db/schema.ts"
import { WORKER_IMAGE } from "../lib/worker-install.ts"
import type { Refusal } from "./health.ts"
import { type Instance, needsQueueWorkers } from "./instances.ts"

type Worker = typeof workers.$inferSelect

/**
 * What the socket proxy of a worker must allow, and the exact lines to paste when it refused something, shown where
 * the refusal shows (the Health card, a failed backup, a failed credential export) and in the worker's settings.
 *
 * Everything here comes from reports the server applied for the instance's current collection revision, so a
 * report about an earlier target (another worker, another container) never adds a name to this worker's rule.
 */

type Detail = {
  revision?: number
  access?: { refused: Refusal[] }
  listed?: { names: string[]; complete: boolean; patterns?: { pattern: string; clean: boolean }[] }
  checkedAt?: string
  fallback?: string
  workers?: { url?: string; name?: string; error?: string }[]
  discovery?: { status: string; reason?: string }
  resolvedContainer?: string
  replicas?: { clean: boolean }
}

/** What a job or a report said about a Compose service target: the container used, and whether its rule is clean. */
export type ServiceSeen = { project: string; service: string; resolved?: string; clean?: boolean }

/** The phrases with which workers of 0.2.0 and 0.3.0 said the socket proxy refused, before reports carried it. */
const OLD_EXEC = /the socket proxy does not allow commands in "([^"]{1,128})"/
const OLD_LIST = /^the socket proxy does not allow listing containers/

/** The instance's last applied report, if it is about the instance's current collection target. */
export function currentDetail(instance: Pick<Instance, "healthDetail" | "collectionRevision">): Detail | null {
  const detail = instance.healthDetail as Detail | null
  return detail && detail.revision === instance.collectionRevision ? detail : null
}

/** What the socket proxy refused in a report; for a worker of an earlier release, read from its words. */
export function refusalsOf(detail: Detail | null): Refusal[] {
  if (!detail) return []
  if (detail.access) return detail.access.refused
  const found: Refusal[] = []
  const main = detail.fallback?.match(OLD_EXEC)
  if (main?.[1]) found.push({ call: "exec-create", container: main[1] })
  for (const w of detail.workers ?? []) {
    const m = w.error?.match(OLD_EXEC)
    if (m?.[1]) found.push({ call: "exec-create", container: m[1] })
  }
  if (detail.discovery?.reason && OLD_LIST.test(detail.discovery.reason)) found.push({ call: "list" })
  return found
}

/** The refusal in a failed job's error, for a worker of an earlier release that sent only its words. */
export function refusalInError(error: string | null | undefined): Refusal | undefined {
  const m = error?.match(OLD_EXEC)
  return m?.[1] ? { call: "exec-create", container: m[1] } : undefined
}

/** A refusal in words, for the sentence "The socket proxy on <worker> refuses ...". */
export function refusalWords(r: Refusal): string {
  switch (r.call) {
    case "exec-create":
      return r.container ? `commands in ${r.container}` : "commands"
    case "exec-start":
      return "starting a command"
    case "exec-inspect":
      return "reading the result of a command"
    case "list":
      return "listing containers"
  }
}

/** The queue worker names of an instance for the rule, or why they are not known. */
function queueWorkersOf(instance: Instance): { names: string[]; gaps: string[]; suggested?: SuggestedPattern[] } {
  if (!needsQueueWorkers(instance)) return { names: [], gaps: [] }
  const detail = currentDetail(instance)
  const name = instance.name
  if (detail?.listed)
    return {
      names: detail.listed.names,
      // Only patterns the worker found clean on the host at that check.
      suggested: (detail.listed.patterns ?? [])
        .filter((p) => p.clean && p.pattern.endsWith("*"))
        .map((p) => ({
          pattern: p.pattern,
          prefix: p.pattern.slice(0, -1),
          instance: name,
          checkedAt: detail.checkedAt,
        })),
      gaps: detail.listed.complete
        ? []
        : [`not every queue worker of ${name} is in the line: more than 500, or a name longer than 128 characters`],
    }
  if (detail?.access?.refused.some((r) => r.call === "list") || detail?.discovery?.status === "refused")
    return { names: [], gaps: [`listing containers is refused, so the queue workers of ${name} are not known yet`] }
  if (detail?.discovery?.status === "ambiguous" || detail?.discovery?.status === "failed")
    return {
      names: [],
      gaps: [`the queue workers of ${name} cannot be told apart: ${detail.discovery.reason ?? "unknown reason"}`],
    }
  if (detail && !detail.access) {
    // A worker of an earlier release names the queue workers it found and checked (at most 50): those go in the
    // line. Only a full list it read (discovery ok) says there are no others.
    // The url keeps the whole name, which that release cut at 128 characters in `name`.
    const found = (detail.workers ?? []).flatMap((w) =>
      w.url?.startsWith("docker://") ? [w.url.slice("docker://".length)] : w.name ? [w.name] : [],
    )
    return {
      names: found,
      gaps:
        detail.discovery?.status === "ok"
          ? []
          : [`the worker's release does not list the queue workers of ${name}; update it`],
    }
  }
  return { names: [], gaps: [`the queue workers of ${name} are not known yet; the next check lists them`] }
}

export type WorkerRule = {
  rule: NeededRule
  /** Where the owner's own patterns came from: recorded now, entered in Add worker, or nothing recorded. */
  recorded: "allowed" | "install" | null
  /** False when the worker was installed with the whole Docker socket (no proxy, no rule). Null: not recorded. */
  socketProxy: boolean | null
}

/**
 * The rule a worker's socket proxy needs now, for every instance assigned to it. `db` is the transaction to read in,
 * when the caller holds one, so it never waits for a second connection of the pool.
 */
export async function workerRule(
  ctx: Ctx,
  worker: Worker,
  db: Pick<Ctx["db"], "select"> = ctx.db,
  /** What a failed job saw of an instance's Compose service, used instead of its last report (by instance id). */
  seen: Map<string, ServiceSeen> = new Map(),
): Promise<WorkerRule> {
  const assigned = await db.select().from(instances).where(eq(instances.workerId, worker.id))
  const mains: MainInput[] = []
  const queueWorkers: { instance: string; name: string }[] = []
  const gaps: string[] = []
  const suggested: SuggestedPattern[] = []
  for (const i of assigned.sort((a, b) => a.name.localeCompare(b.name))) {
    // Backups and credential exports run in the main whatever collects its health.
    if (i.composeProject && i.composeService) {
      // A service: its replicas when the worker found that rule clean, else the container in use by name.
      const detail = currentDetail(i)
      // Only while the instance still names the service the job saw: a target changed since reads its own report.
      const saw = seen.get(i.id)
      const job = saw && saw.project === i.composeProject && saw.service === i.composeService ? saw : undefined
      mains.push({
        instance: i.name,
        service: {
          project: i.composeProject,
          service: i.composeService,
          resolved: job?.resolved ?? detail?.resolvedContainer,
          clean: job ? job.clean : detail?.replicas?.clean,
        },
      })
    } else if (i.containerName) mains.push({ instance: i.name, container: i.containerName })
    const q = queueWorkersOf(i)
    queueWorkers.push(...q.names.map((name) => ({ instance: i.name, name })))
    gaps.push(...q.gaps)
    suggested.push(...(q.suggested ?? []))
  }
  const entered = worker.allowed?.containers ?? worker.install?.containers ?? []
  return {
    rule: neededRule({ entered, mains, queueWorkers, gaps, suggested }),
    recorded: worker.allowed ? "allowed" : worker.install ? "install" : null,
    socketProxy: worker.install ? worker.install.socketProxy : null,
  }
}

const semver = (v: string | null | undefined): [number, number, number] | null => {
  const m = v?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** The image line a worker older than this server should run, or null. Development builds are not compared. */
export function workerUpdate(serverVersion: string, workerVersion: string | null): string | null {
  const server = semver(serverVersion)
  const worker = semver(workerVersion)
  if (!server || !worker) return null
  const older = worker[0] - server[0] || worker[1] - server[1] || worker[2] - server[2]
  return older < 0 ? `image: ${WORKER_IMAGE}:${serverVersion}` : null
}

export type ProxyFix = WorkerRule & {
  worker: { id: string; name: string }
  refused: string[]
  update: string | null
}

async function fixFor(
  ctx: Ctx,
  worker: Worker,
  refused: Refusal[],
  seen: Map<string, ServiceSeen> = new Map(),
): Promise<ProxyFix | null> {
  if (!refused.length) return null
  const words = [...new Set(refused.map(refusalWords))]
  return {
    ...(await workerRule(ctx, worker, ctx.db, seen)),
    worker: { id: worker.id, name: worker.name },
    refused: words,
    update: workerUpdate(ctx.version, worker.version),
  }
}

/** The fix for what the socket proxy refused in the instance's current report, or null. */
export async function instanceProxyFix(ctx: Ctx, instance: Instance, worker: Worker | undefined) {
  if (!worker || worker.revokedAt || instance.workerId !== worker.id) return null
  return fixFor(ctx, worker, refusalsOf(currentDetail(instance)))
}

/**
 * The fix for a failed job of `workerId` in `container` (a backup, a credential export), or null. Only while the
 * instance still uses that worker and container: a fix for a target it has left would not help.
 */
export async function jobProxyFix(
  ctx: Ctx,
  instance: Pick<Instance, "id" | "workerId" | "containerName" | "composeProject" | "composeService">,
  job: {
    workerId: string
    container: string | null
    /** The Compose service the job was sent for, and what it saw of it (C11: also without health reports). */
    target?: { project: string; service: string }
    seen?: ServiceSeen
    refused?: Refusal
    error?: string | null
  },
) {
  const refused = job.refused ?? refusalInError(job.error)
  if (!refused || instance.workerId !== job.workerId) return null
  // Only while the instance still has the target the job ran for.
  const same = job.target
    ? instance.composeProject === job.target.project && instance.composeService === job.target.service
    : !instance.composeProject && instance.containerName === job.container
  if (!same) return null
  const [worker] = await ctx.db.select().from(workers).where(eq(workers.id, job.workerId))
  if (!worker || worker.revokedAt) return null
  return fixFor(ctx, worker, [refused], job.target && job.seen ? new Map([[instance.id, job.seen]]) : new Map())
}

/** The containers a worker's socket proxy allows, as the owner records them: the Add worker rules, 500 of 128. */
export const allowedContainers = z
  .array(
    z
      .string()
      .max(ALLOWED_LIMITS.length, `Keep each container name to ${ALLOWED_LIMITS.length} characters`)
      .regex(CONTAINER_PATTERN, "Container names use letters, digits, dot, dash, underscore and *"),
  )
  .min(1, "List the containers the socket proxy allows")
  .max(ALLOWED_LIMITS.entries, `List at most ${ALLOWED_LIMITS.entries} containers; use a pattern with *`)

/**
 * Records patterns n8n-ops suggested for queue workers added later, under the worker's row lock. Each must still be
 * suggested by the lines as they are now (otherwise "stale", nothing saved). They are added to what is recorded, or
 * to the Add worker list, or, when neither exists, to what the lines allow, so nothing the lines allowed is lost;
 * exact names a pattern covers are dropped. A result over the limits is refused whole. Audited with the change.
 */
export async function recordPatterns(ctx: Ctx, workerId: string, requested: string[], actor: string) {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), isNull(workers.revokedAt)))
      .for("update")
    if (!before) return { status: 404 as const }
    const { rule } = await workerRule(ctx, before, tx)
    const offered = new Set(rule.widened?.patterns.map((p) => p.pattern) ?? [])
    const patterns = [...new Set(requested)]
    if (!patterns.every((p) => offered.has(p))) return { status: 409 as const }
    const base =
      before.allowed?.containers ??
      before.install?.containers ??
      rule.allows.filter((a) => !a.computed).map((a) => a.name)
    const covers = patterns.map((p) => new RegExp(`^${patternRegex(p)}$`))
    const containers = [
      ...new Set([...base.filter((n) => n.includes("*") || !covers.some((re) => re.test(n))), ...patterns]),
    ]
    const checked = allowedContainers.safeParse(containers)
    if (!checked.success)
      return { status: 400 as const, message: [...new Set(checked.error.issues.map((i) => i.message))].join(". ") }
    await tx.update(workers).set({ allowed: { containers } }).where(eq(workers.id, before.id))
    await ctx.audit(
      {
        actor,
        action: "Worker allowed containers recorded",
        target: before.name,
        via: "web",
        details: { before: before.allowed?.containers ?? null, after: containers },
      },
      tx,
    )
    return { status: 200 as const, containers }
  })
}
