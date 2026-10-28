/**
 * The socket proxy's allowlist for a worker: ping, listing containers (to find n8n queue workers; never inspecting
 * one), and exec in the containers the worker uses. One place builds it, for the Add worker compose, for the fix
 * shown when the proxy refused something, and for the check in scripts/verify.sh.
 *
 * Two kinds of entries, never mixed: patterns the owner typed (a `*` stands for any run of characters), and names
 * n8n-ops knows (container names of instances, queue workers a worker listed), which are always literal.
 */

/** A container name, or a pattern with * for names added later (for example n8n*), as the owner types it. */
export const CONTAINER_PATTERN = /^[a-zA-Z0-9*][a-zA-Z0-9_.*-]*$/

/** A Docker container name, as n8n-ops takes one from an instance or from a worker's report. */
export const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** Most entries the owner may record for a worker, and the longest one. */
export const ALLOWED_LIMITS = { entries: 500, length: 128 }

const VERSION = String.raw`(/v1\.[0-9]+)?`

/** The GET rule: always the same. */
export const PROXY_GET = `${VERSION}/(_ping|exec/[0-9a-f]+/json|containers/json)`

const literal = (text: string) => text.replace(/[.\\+?^${}()|[\]*]/g, "\\$&")

/** A pattern the owner typed as a regular expression: * stands for any characters but a slash. */
export function patternRegex(pattern: string): string {
  return pattern.split("*").map(literal).join("[^/]*")
}

/** The POST rule for these regular expression alternatives. */
export function proxyPost(alternatives: string[]): string {
  return `${VERSION}/(containers/(${alternatives.join("|")})/exec|exec/[0-9a-f]+/start)`
}

/** The proxy's rules for the containers the owner typed (Add worker). */
export function proxyRules(patterns: string[]) {
  return { get: PROXY_GET, post: proxyPost(patterns.map(patternRegex)) }
}

/**
 * The two command lines of the proxy in the worker's docker-compose.yml, indented as the generated file has them.
 * Every alternative is a checked pattern or name, so neither line can hold a quote or a line break.
 */
export function proxyLines(rules: { get: string; post: string }): string {
  return `      - '-allowGET=${rules.get}'\n      - '-allowPOST=${rules.post}'`
}

/** Why an entry is in the rule: typed by the owner, an instance's main, or a queue worker listed next to one. */
export type RuleSource =
  | { kind: "entered" }
  | { kind: "main"; instance: string }
  | { kind: "queue-worker"; instance: string }

export type RuleEntry = { name: string; pattern: boolean; sources: RuleSource[] }

export type NeededRule = {
  get: string
  post: string
  lines: string
  /** What the POST rule allows, and why each entry is there. */
  allows: RuleEntry[]
  /** Complete: n8n-ops knows every container the worker uses. Partial: `gaps` says what is not known. */
  coverage: "complete" | "partial"
  gaps: string[]
  /**
   * The same lines with a pattern for queue workers added later, offered beside the exact ones and only chosen by the
   * owner; null when there is none to offer.
   */
  widened: Widened | null
}

/** A pattern for the queue workers of one instance, as the worker checked it at `checkedAt`. */
export type SuggestedPattern = { pattern: string; prefix: string; instance: string; checkedAt?: string }

export type Widened = {
  patterns: SuggestedPattern[]
  get: string
  post: string
  lines: string
  allows: RuleEntry[]
}

/** Most patterns offered at once, for every instance of a worker together. */
export const MAX_SUGGESTED = 100

/**
 * The lines with patterns for queue workers added later. A suggestion is used only when it is a plain prefix and a
 * `*` (the worker found no other container on the host starting so), when it covers no main, no queue worker of
 * another instance and no pattern the owner recorded, and when it replaces at least one exact queue worker name.
 * Those checks use the names as they came (`known`), before any were merged into a recorded pattern or replaced
 * by another suggestion. Names the owner recorded exactly may be replaced; a main never is.
 */
function widen(
  allows: RuleEntry[],
  suggested: SuggestedPattern[],
  known: { mains: string[]; workers: { instance: string; name: string }[]; entered: string[] },
): Widened | null {
  let rest = allows
  const used: SuggestedPattern[] = []
  const added: RuleEntry[] = []
  for (const s of suggested.slice(0, MAX_SUGGESTED)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,126}$/.test(s.prefix) || s.pattern !== `${s.prefix}*`) continue
    const starts = (name: string) => name.startsWith(s.prefix)
    if (known.mains.some(starts)) continue
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
  const post = proxyPost(all.map((e) => (e.pattern ? patternRegex(e.name) : literal(e.name))))
  return { patterns: used, get: PROXY_GET, post, lines: proxyLines({ get: PROXY_GET, post }), allows: all }
}

/**
 * The rule a worker needs now: the patterns the owner recorded, every instance's main, and the queue workers found
 * next to them. A name an owner's pattern already covers is not added again. Names that are not Docker container
 * names are left out and reported as gaps.
 */
export function neededRule(input: {
  entered: string[]
  mains: { instance: string; container: string }[]
  queueWorkers: { instance: string; name: string }[]
  gaps?: string[]
  /** Patterns the worker found clean on the host, for queue workers added later. */
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
  for (const m of input.mains) {
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
  const allows = [...patterns, ...names]
  const post = proxyPost(allows.map((e) => (e.pattern ? patternRegex(e.name) : literal(e.name))))
  return {
    get: PROXY_GET,
    post,
    lines: proxyLines({ get: PROXY_GET, post }),
    allows,
    coverage: gaps.length ? "partial" : "complete",
    gaps: [...new Set(gaps)],
    widened: widen(allows, input.suggested ?? [], {
      mains: input.mains.map((m) => m.container),
      workers: input.queueWorkers,
      entered,
    }),
  }
}
