import { useQuery } from "@tanstack/react-query"
import { ApiError, api, queryClient } from "@/lib/api"
import { ATTENTION_POLL_MS, ATTENTION_TIMEOUT_MS } from "@/lib/behavior"
import { plural } from "@/lib/numbers"

export type Tone = "fail" | "warn" | "info"

export type AttentionSource = "access" | "problems" | "instances" | "backups" | "workers"

export type AttentionItem = { tone: Tone } & (
  | {
      kind: "problem"
      id: string
      status: "open"
      reason: "new" | "regression"
      workflowName: string
      instanceName: string
      errorMessage: string
      title: string
      hint: string | null
      count: number
      workflows: number
      affectedTotal: number
      instances: string[]
      at: string
    }
  | { kind: "instance"; id: string; name: string; health: string; detail: string; at: string | null }
  | { kind: "backup"; id: string; name: string; detail: string; running: boolean; at: string | null }
  | { kind: "worker"; id: string; name: string; at: string | null }
  | {
      kind: "access"
      id: string
      name: string
      agent: string
      detail: string
      at: string | null
      revision: number
    }
)

export type UncheckedItem = { kind: "health" | "failures"; id: string; name: string; detail: string; at: string | null }

export type Attention = {
  items: AttentionItem[]
  total: number
  tone: Tone | null
  moreProblems: number
  unchecked: UncheckedItem[]
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

export const sourceLabel: Record<AttentionSource, string> = {
  access: "access requests",
  problems: "problems",
  instances: "instance health",
  backups: "backups",
  workers: "workers",
}

const time = (i: { at: string | null }) => (i.at ? Date.parse(i.at) : 0)

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

export function checksFailed(a: Attention | undefined, readFailed: boolean): boolean {
  return readFailed || Boolean(a && (a.unchecked.length > 0 || a.failed.length > 0))
}

export function badgeText(total: number): string | null {
  if (total <= 0) return null
  return total > 99 ? "99+" : String(total)
}

export function bellName(a: Attention | undefined, unchecked: boolean): string {
  const parts = ["Needs attention"]
  if (a?.total) parts.push(plural(a.total, "item"))
  if (unchecked) parts.push("some checks could not run")
  else if (a && !a.total) parts.push("nothing right now")
  return parts.join(", ")
}

export const scrollLine = (count: number) => `${plural(count, "item")}. Scroll the list for the rest`

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

export function useAttention() {
  return useQuery<Attention>({
    queryKey: [ATTENTION_PATH],
    queryFn: async () =>
      keepFailed(
        queryClient.getQueryData<Attention>([ATTENTION_PATH]),
        await api<Attention>(ATTENTION_PATH, { signal: AbortSignal.timeout(ATTENTION_TIMEOUT_MS) }),
      ),
    refetchInterval: ATTENTION_POLL_MS,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  })
}
