import { type NeededRule, neededRule } from "@n8n-ops/shared"
import { eq } from "drizzle-orm"
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
  listed?: { names: string[]; complete: boolean }
  fallback?: string
  workers?: { url?: string; name?: string; error?: string }[]
  discovery?: { status: string; reason?: string }
}

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
function queueWorkersOf(instance: Instance): { names: string[]; gaps: string[] } {
  if (!needsQueueWorkers(instance)) return { names: [], gaps: [] }
  const detail = currentDetail(instance)
  const name = instance.name
  if (detail?.listed)
    return {
      names: detail.listed.names,
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

/** The rule a worker's socket proxy needs now, for every instance assigned to it. */
export async function workerRule(ctx: Ctx, worker: Worker): Promise<WorkerRule> {
  const assigned = await ctx.db.select().from(instances).where(eq(instances.workerId, worker.id))
  const mains: { instance: string; container: string }[] = []
  const queueWorkers: { instance: string; name: string }[] = []
  const gaps: string[] = []
  for (const i of assigned.sort((a, b) => a.name.localeCompare(b.name))) {
    // Backups and credential exports run in the main whatever collects its health.
    if (i.containerName) mains.push({ instance: i.name, container: i.containerName })
    const q = queueWorkersOf(i)
    queueWorkers.push(...q.names.map((name) => ({ instance: i.name, name })))
    gaps.push(...q.gaps)
  }
  const entered = worker.allowed?.containers ?? worker.install?.containers ?? []
  return {
    rule: neededRule({ entered, mains, queueWorkers, gaps }),
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

async function fixFor(ctx: Ctx, worker: Worker, refused: Refusal[]): Promise<ProxyFix | null> {
  if (!refused.length) return null
  const words = [...new Set(refused.map(refusalWords))]
  return {
    ...(await workerRule(ctx, worker)),
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
  instance: Pick<Instance, "workerId" | "containerName">,
  job: { workerId: string; container: string | null; refused?: Refusal; error?: string | null },
) {
  const refused = job.refused ?? refusalInError(job.error)
  if (!refused || instance.workerId !== job.workerId || instance.containerName !== job.container) return null
  const [worker] = await ctx.db.select().from(workers).where(eq(workers.id, job.workerId))
  if (!worker || worker.revokedAt) return null
  return fixFor(ctx, worker, [refused])
}
