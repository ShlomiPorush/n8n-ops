import { isRoutePattern, maxRoutes, routeLimits, routeWords, topicProblem, topicWords } from "@n8n-ops/shared"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import { FieldPicker } from "@/components/field-picker"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useApi } from "@/lib/api"
import { cn } from "@/lib/utils"

/** One route as the form holds it: every field as typed. */
export type RouteRow = { instanceId: string; workflow: string; tag: string; threadId: string }

/** The first route Save refuses: the field to mark and focus, and what is wrong, as "route 2: …". */
export type RouteIssue = { id: string; message: string }

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

/** What Save refuses in one route, in the server's words; null when it can be saved. */
function rowIssue(r: RouteRow, n: number): RouteIssue | null {
  const at = (field: string, message: string) => ({ id: `route-${n}-${field}`, message: `route ${n}: ${message}` })
  if (!r.instanceId && !r.workflow.trim() && !r.tag.trim()) return at("instance", routeWords.condition)
  if (r.workflow.trim().length > routeLimits.workflow) return at("workflow", routeWords.patternLength)
  if (r.workflow.trim() && !isRoutePattern(r.workflow.trim())) return at("workflow", routeWords.pattern)
  if (r.tag.trim().length > routeLimits.tag) return at("tag", routeWords.tagLength)
  if (!r.threadId.trim()) return at("topic", topicWords)
  const topic = topicProblem(r.threadId)
  return topic ? at("topic", topic) : null
}

/** The first route Save refuses, or null (SV-1). */
export const routesProblem = (text: unknown): RouteIssue | null => {
  const rows = parse(text)
  for (const [i, r] of rows.entries()) {
    const issue = rowIssue(r, i + 1)
    if (issue) return issue
  }
  return null
}

/**
 * The ordered list of topic routes in Settings > Telegram: the first route that matches an alert wins. A route
 * Save refused is marked, with what is wrong under it, until the routes are edited.
 */
export function TopicRoutes({
  id,
  value,
  onChange,
  disabled,
  issue,
}: {
  /** The id of Add route, where the search brings the focus. */
  id: string
  value: unknown
  onChange: (text: string) => void
  disabled?: boolean
  issue?: RouteIssue | null
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
          const n = i + 1
          const field = (name: string) => `route-${n}-${name}`
          const problemId = `route-${n}-problem`
          const marked = issue?.id.startsWith(`route-${n}-`) ? issue : null
          const marks = (name: string) =>
            marked?.id === field(name) ? { "aria-invalid": true, "aria-describedby": problemId } : {}
          const removed = r.instanceId && !known.some((x) => x.id === r.instanceId) && instances.data
          const options = [
            { value: ANY, label: "Any instance" },
            ...known.map((x) => ({ value: x.id, label: x.name })),
            ...(removed ? [{ value: r.instanceId, label: "Removed instance" }] : []),
          ]
          return (
            <li
              // Index keys: the rows are plain values, so a moved row's fields move with it.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={i}
              className={cn("grid gap-2 rounded-md border p-3", marked ? "border-fail" : "border-line")}
              aria-label={`Route ${n}`}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_96px_auto]">
                <div className="grid gap-1 text-small">
                  <label htmlFor={field("instance")} className="font-semibold">
                    Instance
                  </label>
                  <FieldPicker
                    id={field("instance")}
                    label={`Route ${n} instance`}
                    listLabel="Instances"
                    value={r.instanceId || ANY}
                    options={options}
                    onChange={(v) => update(i, { instanceId: v === ANY ? "" : v })}
                    disabled={disabled}
                    invalid={marked?.id === field("instance")}
                    describedBy={marked?.id === field("instance") ? problemId : undefined}
                  />
                </div>
                <div className="grid gap-1 text-small">
                  <label htmlFor={field("workflow")} className="font-semibold">
                    Workflow name matches
                  </label>
                  <Input
                    id={field("workflow")}
                    value={r.workflow}
                    placeholder="Any workflow"
                    aria-label={`Route ${n} workflow pattern`}
                    onChange={(e) => update(i, { workflow: e.target.value })}
                    {...marks("workflow")}
                  />
                </div>
                <div className="grid gap-1 text-small">
                  <label htmlFor={field("tag")} className="font-semibold">
                    Workflow tag
                  </label>
                  <Input
                    id={field("tag")}
                    value={r.tag}
                    placeholder="Any tag"
                    aria-label={`Route ${n} tag`}
                    onChange={(e) => update(i, { tag: e.target.value })}
                    {...marks("tag")}
                  />
                </div>
                <div className="grid gap-1 text-small">
                  <label htmlFor={field("topic")} className="font-semibold">
                    Topic
                  </label>
                  <Input
                    id={field("topic")}
                    value={r.threadId}
                    inputMode="numeric"
                    className="tabular-nums"
                    aria-label={`Route ${n} topic`}
                    onChange={(e) => update(i, { threadId: e.target.value })}
                    {...marks("topic")}
                  />
                </div>
                <div className="flex h-ctl items-center justify-end gap-1 self-end sm:col-span-2 lg:col-span-1">
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
              {marked && <FieldError id={problemId}>{marked.message}</FieldError>}
            </li>
          )
        })}
      </ol>
      <div>
        {/* aria-disabled, not disabled, so the search can still bring the focus here when the list is full. */}
        <Button
          id={id}
          onClick={() => write([...rows, blank])}
          aria-disabled={rows.length >= maxRoutes || undefined}
          title={rows.length >= maxRoutes ? `Up to ${maxRoutes} routes` : undefined}
        >
          <Plus />
          Add route
        </Button>
      </div>
    </div>
  )
}
