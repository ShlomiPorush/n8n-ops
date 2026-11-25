export const CONTAINER_PATTERN = /^[a-zA-Z0-9*][a-zA-Z0-9_.*-]*$/

export const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export const ALLOWED_LIMITS = { entries: 500, length: 128 }

const VERSION = String.raw`(/v1\.[0-9]+)?`

export const PROXY_GET = `${VERSION}/(_ping|exec/[0-9a-f]+/json|containers/json)`

const literal = (text: string) => text.replace(/[.\\+?^${}()|[\]*]/g, "\\$&")

export function patternRegex(pattern: string): string {
  return pattern.split("*").map(literal).join("[^/]*")
}

export function proxyPost(alternatives: string[]): string {
  return `${VERSION}/(containers/(${alternatives.join("|")})/exec|exec/[0-9a-f]+/start)`
}

export function proxyRules(patterns: string[]) {
  return { get: PROXY_GET, post: proxyPost(patterns.map(patternRegex)) }
}

export function proxyLines(rules: { get: string; post: string }): string {
  return `      - '-allowGET=${rules.get}'\n      - '-allowPOST=${rules.post}'`
}

export type RuleSource =
  | { kind: "entered" }
  | { kind: "main"; instance: string }
  | { kind: "queue-worker"; instance: string }

export type RuleEntry = {
  name: string
  pattern: boolean
  sources: RuleSource[]
  regex?: string
  computed?: boolean
}

export type ServiceMain = { project: string; service: string; clean?: boolean; resolved?: string }

export type MainInput = { instance: string; container: string } | { instance: string; service: ServiceMain }

export const replicaPrefix = (s: Pick<ServiceMain, "project" | "service">) => `${s.project}-${s.service}-`
export const replicaRegex = (s: Pick<ServiceMain, "project" | "service">) => `${literal(replicaPrefix(s))}[0-9]+`

const regexOf = (e: RuleEntry) => e.regex ?? (e.pattern ? patternRegex(e.name) : literal(e.name))

export type NeededRule = {
  get: string
  post: string
  lines: string
  allows: RuleEntry[]
  coverage: "complete" | "partial"
  gaps: string[]
  widened: Widened | null
}

export type SuggestedPattern = { pattern: string; prefix: string; instance: string; checkedAt?: string }

export type Widened = {
  patterns: SuggestedPattern[]
  get: string
  post: string
  lines: string
  allows: RuleEntry[]
}

export const MAX_SUGGESTED = 100

function widen(
  allows: RuleEntry[],
  suggested: SuggestedPattern[],
  known: { mains: string[]; replicas: string[]; workers: { instance: string; name: string }[]; entered: string[] },
): Widened | null {
  let rest = allows
  const used: SuggestedPattern[] = []
  const added: RuleEntry[] = []
  for (const s of suggested.slice(0, MAX_SUGGESTED)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,126}$/.test(s.prefix) || s.pattern !== `${s.prefix}*`) continue
    const starts = (name: string) => name.startsWith(s.prefix)
    if (known.mains.some(starts)) continue
    const intoReplica = (p: string) =>
      p.startsWith(s.prefix) || (s.prefix.startsWith(p) && /^[0-9]*$/.test(s.prefix.slice(p.length)))
    if (known.replicas.some(intoReplica)) continue
    if (known.workers.some((w) => w.instance !== s.instance && starts(w.name))) continue
    if (known.entered.some((p) => p.includes("*") && starts(p))) continue
    const covers = (e: RuleEntry) => starts(e.name)
    const covered = rest.filter(
      (e) =>
        covers(e) &&
        !e.name.includes("*") &&
        e.sources.some((src) => src.kind === "queue-worker") &&
        !e.sources.some((src) => src.kind === "main"),
    )
    if (!covered.length) continue
    rest = rest.filter((e) => !covered.includes(e))
    used.push(s)
    added.push({
      name: s.pattern,
      pattern: true,
      sources: [...new Map(covered.flatMap((e) => e.sources).map((src) => [JSON.stringify(src), src])).values()],
    })
  }
  if (!used.length) return null
  const all = [...added, ...rest]
  const post = proxyPost(all.map(regexOf))
  return { patterns: used, get: PROXY_GET, post, lines: proxyLines({ get: PROXY_GET, post }), allows: all }
}

export function neededRule(input: {
  entered: string[]
  mains: MainInput[]
  queueWorkers: { instance: string; name: string }[]
  gaps?: string[]
  suggested?: SuggestedPattern[]
}): NeededRule {
  const gaps = [...(input.gaps ?? [])]
  const entered = [...new Set(input.entered.filter((p) => CONTAINER_PATTERN.test(p)))]
  const covers = entered.map((p) => ({ p, re: new RegExp(`^${patternRegex(p)}$`) }))
  const entries = new Map<string, RuleEntry>()
  for (const p of entered) entries.set(`p:${p}`, { name: p, pattern: true, sources: [{ kind: "entered" }] })
  const add = (name: string, source: RuleSource) => {
    const cover = covers.find((c) => c.re.test(name))
    const key = cover ? `p:${cover.p}` : `n:${name}`
    const entry = entries.get(key) ?? { name, pattern: false, sources: [] }
    if (!entry.sources.some((s) => JSON.stringify(s) === JSON.stringify(source))) entry.sources.push(source)
    entries.set(key, entry)
  }
  const replicaEntries: RuleEntry[] = []
  for (const m of input.mains) {
    if ("service" in m) {
      const { project, service, clean, resolved } = m.service
      if (clean) {
        replicaEntries.push({
          name: `${replicaPrefix(m.service)}<number>`,
          pattern: false,
          sources: [{ kind: "main", instance: m.instance }],
          regex: replicaRegex(m.service),
          computed: true,
        })
        continue
      }
      if (resolved && DOCKER_NAME.test(resolved)) {
        add(resolved, { kind: "main", instance: m.instance })
        const entry = entries.get(`n:${resolved}`)
        if (entry) entry.computed = true
      }
      gaps.push(
        clean === false
          ? `another container on this host is named like a replica of service ${service} of ${project}, so only the one in use is in the line, and the next rollout needs the line again`
          : resolved
            ? `whether other containers are named like the replicas of service ${service} of ${project} is not known yet, so only the one in use is in the line`
            : `the container of service ${service} of project ${project} is not known yet; the next check finds it`,
      )
      continue
    }
    if (DOCKER_NAME.test(m.container)) add(m.container, { kind: "main", instance: m.instance })
    else
      gaps.push(
        `the container name of ${m.instance} cannot go in the line (not a Docker container name, or longer than 128 characters)`,
      )
  }
  for (const w of input.queueWorkers) {
    if (DOCKER_NAME.test(w.name)) add(w.name, { kind: "queue-worker", instance: w.instance })
    else
      gaps.push(
        `a queue worker of ${w.instance} has a name that cannot go in the line (not a Docker container name, or longer than 128 characters)`,
      )
  }
  const patterns = [...entries.values()].filter((e) => e.pattern)
  const names = [...entries.values()].filter((e) => !e.pattern).sort((a, b) => a.name.localeCompare(b.name))
  const allows = [...patterns, ...replicaEntries, ...names]
  const post = proxyPost(allows.map(regexOf))
  return {
    get: PROXY_GET,
    post,
    lines: proxyLines({ get: PROXY_GET, post }),
    allows,
    coverage: gaps.length ? "partial" : "complete",
    gaps: [...new Set(gaps)],
    widened: widen(allows, input.suggested ?? [], {
      mains: input.mains.flatMap((m) =>
        "service" in m ? (m.service.resolved ? [m.service.resolved] : []) : [m.container],
      ),
      replicas: input.mains.flatMap((m) => ("service" in m ? [replicaPrefix(m.service)] : [])),
      workers: input.queueWorkers,
      entered,
    }),
  }
}
