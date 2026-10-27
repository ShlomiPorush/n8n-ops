import { useQuery } from "@tanstack/react-query"
import { ApiError, queryClient, readFresh } from "@/lib/api"
import { ATTENTION_POLL_MS, ATTENTION_TIMEOUT_MS } from "@/lib/behavior"
import { plural } from "@/lib/numbers"

/*
 * Needs attention (NL-19, FB-10): what needs a decision, read by the bell on every page and by Overview through
 * one query. The server decides what counts and gives each item a tone; this file keeps what a failed read
 * showed, and says the count and the tone the bell shows.
 */

/** Red when something fails, amber for a warning, plain (ink) for news only. */
export type Tone = "fail" | "warn" | "info"

export type AttentionSource = "access" | "problems" | "instances" | "backups" | "workers"

export type AttentionItem = { tone: Tone } & (
  | {
      kind: "problem"
      id: string
      status: "open"
      reason: "new" | "regression"
      /** The most recently failed workflow; with several, the item names the error and how many. */
      workflowName: string
      instanceName: string
      errorMessage: string
      count: number
      /** Distinct workflows the Problem hit, and its Affected workflows (a workflow at two nodes is two). */
      workflows: number
      affectedTotal: number
      instances: string[]
      at: string
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: string | null }
  | { kind: "backup"; id: string; name: string; detail: string; running: boolean; at: string | null }
  | { kind: "worker"; id: string; name: string; at: string | null }
  | { kind: "access"; id: string; name: string; agent: string; detail: string; at: string | null }
)

/** A check that could not run: an instance whose health was never read, or whose failures could not be read. */
export type UncheckedItem = { kind: "health" | "failures"; id: string; name: string; detail: string; at: string | null }

export type Attention = {
  items: AttentionItem[]
  /** Every item that needs a look, also those left out of `items`. */
  total: number
  /** The worst tone of all of them; null when nothing needs a look. */
  tone: Tone | null
  /** New problems left out of `items` (the list holds the latest 50). */
  moreProblems: number
  unchecked: UncheckedItem[]
  /** Sources the server could not read this time. */
  failed: AttentionSource[]
}

export const ATTENTION_PATH = "/overview/attention"

const rank: Record<Tone, number> = { fail: 0, warn: 1, info: 2 }

export function worstTone(tones: Iterable<Tone | null | undefined>): Tone | null {
  let worst: Tone | null = null
  for (const t of tones) if (t && (!worst || rank[t] < rank[worst])) worst = t
  return worst
}

const kindOf: Record<AttentionSource, AttentionItem["kind"]> = {
  access: "access",
  problems: "problem",
  instances: "instance",
  backups: "backup",
  workers: "worker",
}

/** What "Could not check …" names for a source. */
export const sourceLabel: Record<AttentionSource, string> = {
  access: "access requests",
  problems: "problems",
  instances: "instance health",
  backups: "backups",
  workers: "workers",
}

const time = (i: { at: string | null }) => (i.at ? Date.parse(i.at) : 0)

/**
 * A source that could not be read keeps what it showed (NL-19): its items, its checks and the problems left out of
 * the list come from the previous answer, and the total and the tone count them again. `failed` still names it, so
 * the list can say so.
 */
export function keepFailed(prev: Attention | undefined, next: Attention): Attention {
  if (!prev || prev === next || next.failed.length === 0) return next
  const kinds = new Set(next.failed.map((s) => kindOf[s]))
  const kept = prev.items.filter((i) => kinds.has(i.kind))
  const keptMore = next.failed.includes("problems") ? prev.moreProblems : 0
  const items = [...next.items, ...kept].sort((a, b) => rank[a.tone] - rank[b.tone] || time(b) - time(a))
  return {
    ...next,
    items,
    total: next.total + kept.length + keptMore,
    moreProblems: next.moreProblems + keptMore,
    tone: worstTone([next.tone, ...kept.map((i) => i.tone), keptMore ? "fail" : null]),
    unchecked: next.failed.includes("instances") ? [...next.unchecked, ...prev.unchecked] : next.unchecked,
  }
}

/** Whether some check could not run: an instance not checked, a source not read, or no answer to the last read. */
export function checksFailed(a: Attention | undefined, readFailed: boolean): boolean {
  return readFailed || Boolean(a && (a.unchecked.length > 0 || a.failed.length > 0))
}

/** The bell's badge: hidden at zero, the number up to 99, then "99+" (the full number is in its name). */
export function badgeText(total: number): string | null {
  if (total <= 0) return null
  return total > 99 ? "99+" : String(total)
}

/** The bell's accessible name: the count in full, and whether some checks could not run (NL-19). */
export function bellName(a: Attention | undefined, unchecked: boolean): string {
  const parts = ["Needs attention"]
  if (a?.total) parts.push(plural(a.total, "item"))
  if (unchecked) parts.push("some checks could not run")
  else if (a && !a.total) parts.push("nothing right now")
  return parts.join(", ")
}

/** The line under a list that passes its cap: "12 items. Scroll the list for the rest" (FB-17). */
export const scrollLine = (count: number) => `${plural(count, "item")}. Scroll the list for the rest`

/** Where an item opens. */
export function attentionTarget(item: AttentionItem): string {
  switch (item.kind) {
    case "problem":
      return `/problems/${item.id}`
    case "instance":
      return `/instances/${item.id}`
    case "backup":
      return `/backups/${item.id}`
    case "access":
      return `/access/${item.id}`
    case "worker":
      return "/workers"
  }
}

/**
 * Needs attention for the bell on every page and for Overview: one query, read again every ATTENTION_POLL_MS. React
 * Query skips a timed refetch while the browser tab is hidden (`refetchIntervalInBackground` is false by default)
 * and reads again when it is shown (`refetchOnWindowFocus`); a change the server reports meanwhile only marks it
 * stale (`invalidateTopics` in lib/live.ts). A read without an answer in ATTENTION_TIMEOUT_MS fails,
 * and is tried once more, so a hung request never holds the next one. An answer read before an action on it is
 * dropped: the actions refresh "/overview" through `refreshAreas` or `invalidate`, which mark the path saved
 * (`readFresh`). A source the server could not read keeps what it showed (`keepFailed`).
 */
export function useAttention() {
  return useQuery<Attention>({
    queryKey: [ATTENTION_PATH],
    queryFn: async ({ signal }) =>
      keepFailed(
        queryClient.getQueryData<Attention>([ATTENTION_PATH]),
        await readFresh<Attention>(ATTENTION_PATH, queryClient, { signal, timeout: ATTENTION_TIMEOUT_MS }),
      ),
    refetchInterval: ATTENTION_POLL_MS,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  })
}
