import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApi } from "@/lib/api"

/** One route as the form holds it: every field as typed. */
export type RouteRow = { instanceId: string; workflow: string; tag: string; threadId: string }

const ANY = "any"
const blank: RouteRow = { instanceId: "", workflow: "", tag: "", threadId: "" }

/**
 * The routes in the form are one JSON text, so the save bar counts an edit or a new order as a change and Discard
 * and a refresh restore them like any other field.
 */
export const routesToForm = (routes: unknown) =>
  JSON.stringify(
    (Array.isArray(routes) ? routes : []).map(
      (r: Partial<Record<keyof RouteRow, unknown>>): RouteRow => ({
        instanceId: String(r.instanceId ?? ""),
        workflow: String(r.workflow ?? ""),
        tag: String(r.tag ?? ""),
        threadId: r.threadId === undefined || r.threadId === null ? "" : String(r.threadId),
      }),
    ),
  )

const parse = (text: unknown): RouteRow[] => {
  try {
    const rows = JSON.parse(String(text || "[]"))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** The routes to save. Empty fields are left out; the server reads them as not set. */
export const routesFromForm = (text: unknown) =>
  parse(text).map((r) => ({
    ...(r.instanceId.trim() ? { instanceId: r.instanceId.trim() } : {}),
    ...(r.workflow.trim() ? { workflow: r.workflow.trim() } : {}),
    ...(r.tag.trim() ? { tag: r.tag.trim() } : {}),
    threadId: Number(r.threadId),
  }))

/** A topic as typed: empty is none, otherwise a whole number from 1 that fits the database. */
export const topicProblem = (value: string) => {
  const v = value.trim()
  if (!v) return null
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 2_147_483_647 ? null : "A topic is a whole number from 1."
}

function rowProblem(r: RouteRow) {
  if (!r.instanceId && !r.workflow.trim() && !r.tag.trim()) return "Choose an instance, or type a workflow pattern or a tag."
  if (r.workflow.trim()) {
    try {
      new RegExp(r.workflow.trim(), "iu")
    } catch {
      return "The workflow pattern is not a valid regular expression."
    }
  }
  if (!r.threadId.trim()) return "Type the topic these alerts go to."
  return topicProblem(r.threadId)
}

/** The ordered list of topic routes in Settings > Telegram: the first route that matches an alert wins. */
export function TopicRoutes({
  value,
  onChange,
  disabled,
}: {
  value: unknown
  onChange: (text: string) => void
  disabled?: boolean
}) {
  const rows = parse(value)
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const known = instances.data?.instances ?? []
  const write = (next: RouteRow[]) => onChange(JSON.stringify(next))
  const update = (i: number, patch: Partial<RouteRow>) => write(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, by: number) => {
    const next = [...rows]
    const [row] = next.splice(i, 1)
    if (row) next.splice(i + by, 0, row)
    write(next)
  }

  return (
    <div className="grid w-full gap-3">
      {rows.length === 0 && (
        <p className="text-small text-muted-foreground">No routes. Every alert goes to the default topic.</p>
      )}
      <ol className="grid gap-3">
        {rows.map((r, i) => {
          const problem = rowProblem(r)
          const removed = r.instanceId && !known.some((x) => x.id === r.instanceId) && instances.data
          const n = i + 1
          return (
            // Index keys: the rows are plain values, so a moved row's fields move with it.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i} className="grid gap-2 rounded-md border border-line p-3" aria-label={`Route ${n}`}>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_110px]">
                <label className="grid gap-1 text-small">
                  <span className="font-semibold">Instance</span>
                  <Select
                    value={r.instanceId || ANY}
                    onValueChange={(v) => update(i, { instanceId: v === ANY ? "" : v })}
                    // Radix Select opens on pointerdown and ignores a disabled fieldset, so it is locked itself.
                    disabled={disabled}
                  >
                    <SelectTrigger className="w-full" aria-label={`Route ${n} instance`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any instance</SelectItem>
                      {known.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name}
                        </SelectItem>
                      ))}
                      {removed && <SelectItem value={r.instanceId}>Removed instance</SelectItem>}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1 text-small">
                  <span className="font-semibold">Workflow name matches</span>
                  <Input
                    value={r.workflow}
                    placeholder="orders|invoices"
                    aria-label={`Route ${n} workflow pattern`}
                    onChange={(e) => update(i, { workflow: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-small">
                  <span className="font-semibold">Workflow tag</span>
                  <Input
                    value={r.tag}
                    aria-label={`Route ${n} tag`}
                    onChange={(e) => update(i, { tag: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-small">
                  <span className="font-semibold">Topic</span>
                  <Input
                    value={r.threadId}
                    inputMode="numeric"
                    className="tabular-nums"
                    aria-label={`Route ${n} topic`}
                    onChange={(e) => update(i, { threadId: e.target.value })}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">{problem && <FieldError>{problem}</FieldError>}</div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move route ${n} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move route ${n} down`}
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove route ${n}`}
                    onClick={() => write(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <div>
        <Button onClick={() => write([...rows, blank])} disabled={rows.length >= 50}>
          <Plus />
          Add route
        </Button>
      </div>
    </div>
  )
}
