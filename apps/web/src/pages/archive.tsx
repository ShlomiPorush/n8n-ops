import {
  ArchiveRestore as ArchiveRestoreIcon,
  Braces as BracesIcon,
  Download as DownloadIcon,
  Info as InfoIcon,
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react"
import * as React from "react"
import { useState } from "react"
import { Link, UNSAFE_DataRouterContext, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { useConfirm } from "@/components/confirm"
import { FieldPicker } from "@/components/field-picker"
import { FilterBar, SearchBox } from "@/components/filter-bar"
import { ItemRow, ItemsHeader } from "@/components/item-row"
import {
  BusyButton,
  Empty,
  KV,
  LoadError,
  Loading,
  NoValue,
  Page,
  PageHead,
  Panel,
  PanelHead,
  UserText,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { checkRestore, PlanReview, RestoreResult } from "@/components/restore-view"
import { guardLeaves } from "@/components/save-bar"
import { Code, StatusTag, TimeAgo, Tone } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, queryClient, useApi } from "@/lib/api"
import { download } from "@/lib/download"
import { activeWith, type PickedInstance } from "@/lib/instance-setup"
import { n, plural } from "@/lib/numbers"
import {
  type CredentialSummary,
  changeText,
  type Inspection,
  jsonFileName,
  type RestoreKind,
  type RestoreMode,
  type RestoreView,
  replaceBlocked,
  type WorkflowSummary,
} from "@/lib/restore"
import { unsavedGuardOn } from "@/lib/session"
import { formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"

/*
 * One archive of an instance's backup (requirement D6): what it holds, compared with the instance, and single items
 * restored from it. The private key is pasted here, kept in this page's memory only and sent with each request that
 * reads the archive; the server uses it in memory and never stores it. Leaving the page drops it, and asks first.
 */

type RunLite = { id: string; startedAt: string; includesSecrets: boolean; status: string }
/** An instance as `/instances` lists it: what a restore may pick, and what Replace needs of it. */
type TargetInstance = PickedInstance & { version?: string | null; effectiveScopes?: string[] }
type View = "workflows" | "credentials"

/** Asks before a move out of the archive drops the pasted key. Moves between its items do not ask. */
function useKeyGuard(held: boolean, base: string) {
  const router = React.useContext(UNSAFE_DataRouterContext)?.router
  const confirm = useConfirm()
  const latest = React.useRef({ base, confirm })
  latest.current = { base, confirm }
  // The router consults its newest guard only, so this one is made when a key is typed, after the shell's (the save
  // bar's, which has nothing to save on this page), and removed as soon as there is no key, which brings that back.
  React.useEffect(() => {
    if (!held || !router) return
    const inside = (path: string) => path === latest.current.base || path.startsWith(`${latest.current.base}/`)
    const guard = guardLeaves(
      router,
      ({ nextLocation }) => unsavedGuardOn() && !inside(nextLocation.pathname),
      (signal) =>
        latest.current.confirm({
          title: "Discard Your Changes?",
          message: "The private key you pasted is dropped when you leave the archive.",
          confirmLabel: "Discard",
          cancelLabel: "Keep editing",
          danger: true,
          focusCancel: true,
          noHistory: true,
          signal,
        }),
    )
    return () => guard.stop()
  }, [held, router])
}

export function ArchivePage() {
  const { runId, restoreId } = useParams()
  // Another archive is another page: nothing of this one stays.
  return <Archive key={runId ?? `version:${restoreId}`} />
}

/*
 * The page opens a backup run's archive (`/backups/:id/runs/:runId`) or the Version before replace that a restore
 * kept (`/backups/:id/versions/:restoreId`), the workflow as n8n held it right before a replace wrote over it. Both
 * read, compare and restore the same way.
 */
function Archive() {
  const { id = "", runId = "", restoreId, kind, itemId } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const w = useTimeFormat()
  const isVersion = restoreId !== undefined
  const base = isVersion ? `/backups/${id}/versions/${restoreId}` : `/backups/${id}/runs/${runId}`
  const apiBase = isVersion ? `/backups/versions/${restoreId}` : `/backups/runs/${runId}`
  const instances = useApi<{ instances: TargetInstance[] }>("/instances")
  const runs = useApi<RunLite[]>(id && !isVersion ? `/backups/${id}/runs` : null)
  const kept = useApi<RestoreView>(isVersion ? `/backups/restores/${restoreId}` : null)
  const run = runs.data?.find((r) => r.id === runId)
  const takenAt = kept.data?.versionBefore?.takenAt
  const instanceName = instances.data?.instances.find((i) => i.id === id)?.name
  const title = isVersion ? "Version Before Replace" : "Archive"
  const archiveLabel = isVersion
    ? takenAt
      ? `Version before replace, ${formatTime(takenAt, w, { seconds: false })}`
      : "Version before replace"
    : run
      ? `Archive of ${formatTime(run.startedAt, w, { seconds: false })}`
      : "Archive"
  useCrumb(id === "self" ? "n8n-ops database" : instanceName)
  useCrumb(archiveLabel)

  const [key, setKey] = useState("")
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useKeyGuard(key.trim() !== "", base)

  async function open() {
    setBusy(true)
    setError("")
    try {
      setInspection(await api<Inspection>(`${apiBase}/inspect`, { method: "POST", json: { privateKey: key } }))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!inspection) {
    const missing =
      id === "self" ||
      (isVersion
        ? Boolean(kept.error) || (kept.data !== undefined && !kept.data.versionBefore)
        : runs.data !== undefined && !run)
    const description = isVersion
      ? kept.data && takenAt
        ? `${kept.data.itemName} as ${instanceName ?? "the instance"} held it right before a replace, kept by n8n-ops on ${formatTime(takenAt, w, { seconds: false })}. Open it with the private backup key, or with the key pasted for that restore, to see it and put it back.`
        : "The workflow as n8n held it right before a replace, kept by n8n-ops."
      : run
        ? `The backup of ${instanceName ?? "this instance"} from ${formatTime(run.startedAt, w, { seconds: false })}${run.includesSecrets ? ", with credential secrets" : ", without credential secrets"}. Open it to see its workflows and credentials and restore single items.`
        : "Open an archive to see its workflows and credentials and restore single items."
    return (
      <Page title={title} description={description}>
        {missing ? (
          <Panel>
            <Empty
              title={
                id === "self"
                  ? "The n8n-ops database is not opened here."
                  : isVersion
                    ? "This version before was not found."
                    : "This backup run was not found."
              }
              action={
                <Button asChild>
                  <Link to={`/backups/${id}`}>Back to the backups</Link>
                </Button>
              }
            >
              {id === "self"
                ? "Restore it with age and pg_restore, as its backups pane says."
                : isVersion
                  ? "Only a restore that replaced a workflow keeps one."
                  : "It may have been removed by retention."}
            </Empty>
          </Panel>
        ) : (
          <Panel className="max-w-2xl">
            <PanelHead title={isVersion ? "Open the Version Before" : "Open the Archive"} />
            <form
              className="grid gap-3 px-pad-x pb-pad-y"
              onSubmit={(e) => {
                e.preventDefault()
                if (key.trim() && !busy) void open()
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="archive-key">Private backup key</FieldLabel>
                  <Textarea
                    id="archive-key"
                    className="font-mono text-small"
                    placeholder="AGE-SECRET-KEY-1…"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <FieldDescription>
                    The key stays on this page only. It is sent with each request that reads the archive, used there in
                    memory and never stored. Leaving the page drops it.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              {error && <FieldError>{error}</FieldError>}
              <div>
                <BusyButton
                  type="submit"
                  variant="primary"
                  icon={LockOpenIcon}
                  disabled={!key.trim()}
                  busy={busy}
                  busyLabel="Opening…"
                >
                  {isVersion ? "Open version" : "Open archive"}
                </BusyButton>
              </div>
            </form>
          </Panel>
        )}
      </Page>
    )
  }

  const view: View = kind === "credentials" ? "credentials" : "workflows"
  const search = q ? `?${new URLSearchParams({ q })}` : ""
  const close = () => {
    setKey("")
    setInspection(null)
    navigate(base, { replace: true })
  }
  const selected =
    itemId === undefined
      ? null
      : view === "workflows"
        ? inspection.workflows.find((x) => x.id === itemId)
        : inspection.credentials.find((x) => x.id === itemId)
  const secrets = inspection.manifest?.includesSecrets ?? run?.includesSecrets ?? false
  const list = (items: boolean) => (
    <>
      <PageHead
        title={title}
        actions={
          <Button onClick={close}>
            <LockIcon /> {isVersion ? "Close version" : "Close archive"}
          </Button>
        }
        description={
          isVersion
            ? `The workflow as ${instanceName ?? "the instance"} held it right before a replace, kept on ${formatTime(inspection.source.at, w, { seconds: false })}. Restore it as a copy, or replace the workflow with it to put it back. The key stays on this page until you close it or leave.`
            : `${plural(inspection.workflows.length, "workflow")} and ${plural(inspection.credentials.length, "credential")}${secrets ? " with their secrets" : ", without secrets"}, backed up from ${instanceName ?? "the instance"} on ${formatTime(inspection.source.at, w, { seconds: false })}. The key stays on this page until you close the archive or leave.`
        }
      />
      <FilterBar
        views={{
          label: "Show",
          value: view,
          onChange: (v) => navigate(`${base}/${v}${search}`, { replace: true }),
          options: [
            {
              value: "workflows",
              label: (
                <>
                  Workflows <small>{n(inspection.workflows.length)}</small>
                </>
              ),
              text: `Workflows ${n(inspection.workflows.length)}`,
            },
            {
              value: "credentials",
              label: (
                <>
                  Credentials <small>{n(inspection.credentials.length)}</small>
                </>
              ),
              text: `Credentials ${n(inspection.credentials.length)}`,
            },
          ],
        }}
        search={
          <SearchBox
            label={view === "workflows" ? "Search workflows" : "Search credentials"}
            value={q}
            onChange={(v) => setParams(v ? { q: v } : {}, { replace: true })}
          />
        }
        listKey={`${view}|${q}`}
        onClear={q ? () => setParams({}, { replace: true }) : undefined}
      />
      {view === "workflows" && !inspection.comparison.available && (
        <Alert variant="info">
          <InfoIcon />
          <AlertTitle>Not compared with the instance</AlertTitle>
          <AlertDescription>{inspection.comparison.reason}</AlertDescription>
        </Alert>
      )}
      {view === "workflows" ? (
        <WorkflowList
          items={items}
          inspection={inspection}
          q={q}
          selected={itemId}
          href={(x) => `${base}/workflows/${encodeURIComponent(x)}${search}`}
        />
      ) : (
        <CredentialList
          items={items}
          credentials={inspection.credentials}
          q={q}
          selected={itemId}
          href={(x) => `${base}/credentials/${encodeURIComponent(x)}${search}`}
        />
      )}
    </>
  )

  const shared = { inspection, privateKey: key, base, apiBase, instances: instances.data?.instances }
  return (
    <ListWithPanel
      list={list}
      panelTitle={view === "workflows" ? "Archived Workflow" : "Archived Credential"}
      panel={
        itemId === undefined ? null : !selected ? (
          <Empty title="This item is not in the archive." />
        ) : view === "workflows" ? (
          // Keyed by the item: a narrow screen keeps the pane mounted from item to item, and nothing of one item
          // (its JSON, an open restore) may stay for the next.
          <WorkflowPane key={`workflow:${selected.id}`} workflow={selected as WorkflowSummary} {...shared} />
        ) : (
          <CredentialPane key={`credential:${selected.id}`} credential={selected as CredentialSummary} {...shared} />
        )
      }
      onClose={() => navigate(`${base}/${view}${search}`)}
    />
  )
}

const matches = (q: string, ...values: (string | null | undefined)[]) => {
  const needle = q.trim().toLowerCase()
  return !needle || values.some((v) => v?.toLowerCase().includes(needle))
}

/** Changed first, then not found, then the same, for the Compared column. */
const comparedRank = { changed: 2, not_found: 1, same: 0 } as const

function rowProps(id: string, selected: string | undefined, href: string, navigate: (to: string) => void) {
  return {
    "data-state": id === selected ? "selected" : undefined,
    "aria-current": id === selected ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": href,
    onClick: () => navigate(href),
  }
}

function Compared({ inspection, id }: { inspection: Inspection; id: string }) {
  const c = inspection.comparison
  const state = c.available ? c.workflows[id]?.state : undefined
  return state ? <StatusTag kind="comparison" status={state} /> : <NoValue said="Not compared" />
}

function WorkflowList({
  items,
  inspection,
  q,
  selected,
  href,
}: {
  items: boolean
  inspection: Inspection
  q: string
  selected: string | undefined
  href: (id: string) => string
}) {
  const navigate = useNavigate()
  const c = inspection.comparison
  const rows = inspection.workflows.filter((x) => matches(q, x.name, x.id, ...x.tags))
  const sort = useSort(rows, {
    id: "archive-workflows",
    columns: {
      name: { label: "Workflow", kind: "text", value: (x) => x.name },
      compared: {
        label: "Compared",
        kind: "number",
        value: (x) => {
          const state = c.available ? c.workflows[x.id]?.state : undefined
          return state ? comparedRank[state] : -1
        },
      },
      nodes: { label: "Nodes", kind: "number", value: (x) => x.nodes },
    },
  })
  if (rows.length === 0)
    return (
      <Panel>
        <Empty title={q ? "No workflow matches." : "This archive holds no workflows."}>
          {q ? "Try another search." : undefined}
        </Empty>
      </Panel>
    )
  const published = (x: WorkflowSummary) => (x.active ? "Published" : "Not published")
  return (
    <Table items={items}>
      {items ? (
        <ItemsHeader label="Workflow" />
      ) : (
        <TableHeader>
          <TableRow>
            <TableHead sort={sort.head("name")}>Workflow</TableHead>
            <TableHead sort={sort.head("compared")}>Compared</TableHead>
            <TableHead>Published</TableHead>
            <TableHead className="text-end" sort={sort.head("nodes")}>
              Nodes
            </TableHead>
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {sort.rows.map((x) => (
          <TableRow key={x.id} {...rowProps(x.id, selected, href(x.id), navigate)}>
            {items ? (
              <ItemRow
                title={<UserText>{x.name}</UserText>}
                titleText={x.name}
                end={<Compared inspection={inspection} id={x.id} />}
                sub={
                  <>
                    {published(x)}
                    {x.archived && " · archived in n8n"}
                    {x.tags.length > 0 && <> · {x.tags.join(", ")}</>}
                  </>
                }
                subEnd={plural(x.nodes, "node")}
              />
            ) : (
              <>
                <TableCell className="max-w-80 font-semibold" truncate title={x.name} data-primary>
                  <UserText>{x.name}</UserText>
                </TableCell>
                <TableCell data-nolabel>
                  <Compared inspection={inspection} id={x.id} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {published(x)}
                  {x.archived && " · archived in n8n"}
                </TableCell>
                <TableCell className="text-end tabular-nums">{n(x.nodes)}</TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Secrets({ saved }: { saved: boolean }) {
  return saved ? <Tone tone="ok">Secrets saved</Tone> : <Tone tone="muted">No secrets</Tone>
}

function CredentialList({
  items,
  credentials,
  q,
  selected,
  href,
}: {
  items: boolean
  credentials: CredentialSummary[]
  q: string
  selected: string | undefined
  href: (id: string) => string
}) {
  const navigate = useNavigate()
  const rows = credentials.filter((x) => matches(q, x.name, x.id, x.type))
  const sort = useSort(rows, {
    id: "archive-credentials",
    columns: {
      name: { label: "Credential", kind: "text", value: (x) => x.name },
      type: { label: "Type", kind: "text", value: (x) => x.type },
      used: { label: "Used by", kind: "number", value: (x) => x.usedBy.length },
    },
  })
  if (rows.length === 0)
    return (
      <Panel>
        <Empty title={q ? "No credential matches." : "This archive holds no credentials."}>
          {q ? "Try another search." : undefined}
        </Empty>
      </Panel>
    )
  const used = (x: CredentialSummary) => `used by ${plural(x.usedBy.length, "workflow")}`
  return (
    <Table items={items}>
      {items ? (
        <ItemsHeader label="Credential" />
      ) : (
        <TableHeader>
          <TableRow>
            <TableHead sort={sort.head("name")}>Credential</TableHead>
            <TableHead sort={sort.head("type")}>Type</TableHead>
            <TableHead>Secrets</TableHead>
            <TableHead className="text-end" sort={sort.head("used")}>
              Used by
            </TableHead>
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {sort.rows.map((x) => (
          <TableRow key={x.id} {...rowProps(x.id, selected, href(x.id), navigate)}>
            {items ? (
              <ItemRow
                title={<UserText>{x.name}</UserText>}
                titleText={x.name}
                end={<Secrets saved={x.hasSecrets} />}
                sub={x.type}
                subEnd={used(x)}
              />
            ) : (
              <>
                <TableCell className="max-w-80 font-semibold" truncate title={x.name} data-primary>
                  <UserText>{x.name}</UserText>
                </TableCell>
                <TableCell className="max-w-56 text-muted-foreground" truncate title={x.type}>
                  {x.type}
                </TableCell>
                <TableCell data-nolabel>
                  <Secrets saved={x.hasSecrets} />
                </TableCell>
                <TableCell className="text-end text-muted-foreground tabular-nums">
                  {plural(x.usedBy.length, "workflow")}
                </TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

type PaneProps = {
  inspection: Inspection
  privateKey: string
  /** The page of this archive, and where its API calls go. */
  base: string
  apiBase: string
  instances: TargetInstance[] | undefined
}

type JsonState = { loading: true } | { data: unknown } | { failed: unknown }

/** One archived workflow: what it is, how it compares, the credentials it uses, its JSON, and Restore. */
function WorkflowPane({
  workflow: x,
  inspection,
  privateKey,
  base,
  apiBase,
  instances,
}: PaneProps & { workflow: WorkflowSummary }) {
  useCrumb(x.name)
  const w = useTimeFormat()
  const [restoring, setRestoring] = useState(false)
  const [json, setJson] = useState<JsonState | null>(null)
  const load = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => load.current?.abort(), [])
  const fetchJson = async () => {
    load.current?.abort()
    const ctl = new AbortController()
    load.current = ctl
    return api<unknown>(`${apiBase}/workflows/${encodeURIComponent(x.id)}`, {
      method: "POST",
      json: { privateKey },
      signal: ctl.signal,
    })
  }
  const showJson = async () => {
    setJson({ loading: true })
    try {
      setJson({ data: await fetchJson() })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setJson({ failed: e })
    }
  }
  const downloadJson = async () => {
    try {
      const data = json && "data" in json ? json.data : await fetchJson()
      download(jsonFileName(x.name, x.id), JSON.stringify(data, null, 2), "application/json")
    } catch (e) {
      toast.error(`Could not download ${x.name}: ${describeError(e)}`)
      throw e
    }
  }
  const c = inspection.comparison
  const compared = c.available ? c.workflows[x.id] : undefined
  return (
    <div className="@container/pane grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {compared && <StatusTag kind="comparison" status={compared.state} />}
          <Badge variant="line">{x.active ? "Published" : "Not published"}</Badge>
          {x.archived && <Badge variant="muted">Archived in n8n</Badge>}
        </div>
        <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
          <h2 className="text-title break-words">
            <UserText>{x.name}</UserText>
          </h2>
          <div className="flex flex-wrap gap-2 @min-[40rem]/pane:self-start">
            <Button size="sm" variant="primary" onClick={() => setRestoring(true)}>
              <RotateCcw /> Restore
            </Button>
            <BusyButton size="sm" icon={DownloadIcon} busyLabel="Preparing…" run={downloadJson}>
              Download JSON
            </BusyButton>
          </div>
        </div>
        <p className="text-small text-muted-foreground">
          {inspection.source.kind === "version"
            ? "This is the draft as n8n held it right before the replace; the published version may differ."
            : "The archive holds the latest saved version, which on n8n 2 is the draft and may differ from the published one."}
        </p>
      </div>

      <Panel>
        <PanelHead title="Details" />
        <KV label="ID">
          <Code>{x.id}</Code>
        </KV>
        <KV label="Tags">{x.tags.length ? <UserText>{x.tags.join(", ")}</UserText> : <NoValue said="No tags" />}</KV>
        <KV label="Created">{x.createdAt ? formatTime(x.createdAt, w, { seconds: false }) : <NoValue />}</KV>
        <KV label="Updated">{x.updatedAt ? formatTime(x.updatedAt, w, { seconds: false }) : <NoValue />}</KV>
        <KV label="Version">{x.versionId ? <Code>{x.versionId}</Code> : <NoValue />}</KV>
        <KV label="Nodes">{n(x.nodes)}</KV>
        {x.embedded > 0 && (
          <KV label="Embedded workflows">{plural(x.embedded, "Execute Workflow node")} with a workflow inside</KV>
        )}
      </Panel>

      {x.warnings.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>The credentials below may be incomplete</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {x.warnings.map((warning) => (
                <li key={warning}>
                  <UserText>{warning}</UserText>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Panel>
        <PanelHead
          title="What Changed"
          description={
            c.available ? (
              <>
                Compared with <UserText>{c.instance}</UserText> <TimeAgo value={c.at} />.
              </>
            ) : undefined
          }
        />
        <div className="border-t border-line px-pad-x py-pad-y">
          {!c.available ? (
            <p className="text-muted-foreground">Not compared: {c.reason}</p>
          ) : !compared || compared.state === "not_found" ? (
            <p className="text-muted-foreground">
              Not found on <UserText>{c.instance}</UserText> with its API key. It may have been deleted there, or the
              key cannot see it.
            </p>
          ) : compared.state === "same" ? (
            <p className="text-muted-foreground">
              The same as on <UserText>{c.instance}</UserText>.
            </p>
          ) : (
            <ul className="grid list-disc gap-1 ps-5">
              {compared.changes.map((k) => (
                <li key={k}>{changeText(k)}</li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHead title="Credentials" count={n(x.credentials.length)} />
        {x.credentials.length === 0 ? (
          <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">Uses no credentials.</p>
        ) : (
          <ul>
            {x.credentials.map((cr) => (
              <li
                key={`${cr.type}:${cr.id ?? cr.name}`}
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line px-pad-x py-[7px]"
              >
                {cr.inArchive && cr.id ? (
                  <Link
                    to={`${base}/credentials/${encodeURIComponent(cr.id)}`}
                    className="min-w-0 font-semibold break-words underline-offset-3 hover:underline"
                  >
                    <UserText>{cr.name}</UserText>
                  </Link>
                ) : (
                  <UserText className="min-w-0 font-semibold break-words">{cr.name}</UserText>
                )}
                <span className="text-small text-muted-foreground">{cr.type}</span>
                <span className="ms-auto flex flex-wrap gap-1.5">
                  {!cr.inArchive ? <Tone tone="warn">Not in the archive</Tone> : <Secrets saved={cr.hasSecrets} />}
                  {cr.embedded && <Badge variant="line">Inside an embedded workflow</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHead
          title="JSON"
          description="The workflow as the archive holds it."
          action={
            json === null || "failed" in json ? (
              <Button size="sm" onClick={() => void showJson()}>
                <BracesIcon /> Show JSON
              </Button>
            ) : undefined
          }
        />
        {json && "loading" in json && <Loading>Reading the archive…</Loading>}
        {json && "failed" in json && (
          <div className="border-t border-line">
            <LoadError what="the workflow" error={json.failed} retry={() => void showJson()} />
          </div>
        )}
        {json && "data" in json && (
          <pre className="mx-pad-x mb-pad-y max-h-[70vh] min-w-0 overflow-auto rounded-sm bg-fill p-3 font-mono text-meta whitespace-pre-wrap break-words">
            {JSON.stringify(json.data, null, 2)}
          </pre>
        )}
      </Panel>

      <RestoreDialog
        open={restoring}
        item={{ kind: "workflow", id: x.id, name: x.name }}
        inspection={inspection}
        privateKey={privateKey}
        apiBase={apiBase}
        instances={instances}
        onClose={() => setRestoring(false)}
      />
    </div>
  )
}

/** One archived credential: what it is, which workflows use it, and Restore as a new credential. */
function CredentialPane({
  credential: x,
  inspection,
  privateKey,
  base,
  apiBase,
  instances,
}: PaneProps & { credential: CredentialSummary }) {
  useCrumb(x.name)
  const w = useTimeFormat()
  const [restoring, setRestoring] = useState(false)
  const names = new Map(inspection.workflows.map((wf) => [wf.id, wf.name]))
  return (
    <div className="@container/pane grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Secrets saved={x.hasSecrets} />
          <Badge variant="line">{x.type}</Badge>
        </div>
        <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
          <h2 className="text-title break-words">
            <UserText>{x.name}</UserText>
          </h2>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 @min-[40rem]/pane:self-start">
            <Button
              size="sm"
              variant="primary"
              disabled={!x.hasSecrets}
              aria-describedby={x.hasSecrets ? undefined : "credential-restore-reason"}
              onClick={() => setRestoring(true)}
            >
              <RotateCcw /> Restore
            </Button>
            {/* A button that cannot run says why in words beside it (AX-9, FB-1). */}
            {!x.hasSecrets && (
              <span id="credential-restore-reason" className="text-small text-muted-foreground">
                The archive has no secrets for it
              </span>
            )}
          </div>
        </div>
      </div>

      <Panel>
        <PanelHead title="Details" />
        <KV label="ID">
          <Code>{x.id}</Code>
        </KV>
        <KV label="Type">{x.type}</KV>
        <KV label="Created">{x.createdAt ? formatTime(x.createdAt, w, { seconds: false }) : <NoValue />}</KV>
        <KV label="Secrets">{x.hasSecrets ? "Saved in the archive" : "Not saved in the archive"}</KV>
      </Panel>

      <Panel>
        <PanelHead title="Used By" count={n(x.usedBy.length)} />
        {x.usedBy.length === 0 ? (
          <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
            No workflow in this archive uses it.
          </p>
        ) : (
          <ul>
            {x.usedBy.map((wid) => (
              <li key={wid} className="border-t border-line px-pad-x py-[7px]">
                <Link
                  to={`${base}/workflows/${encodeURIComponent(wid)}`}
                  className="font-semibold break-words underline-offset-3 hover:underline"
                >
                  <UserText>{names.get(wid) ?? wid}</UserText>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <RestoreDialog
        open={restoring}
        item={{ kind: "credential", id: x.id, name: x.name }}
        inspection={inspection}
        privateKey={privateKey}
        apiBase={apiBase}
        instances={instances}
        onClose={() => setRestoring(false)}
      />
    </div>
  )
}

const dropReview = (r: RestoreView | null) => {
  // Fire and forget: a review that is not confirmed leaves on its own within an hour anyway.
  if (r?.status === "previewed") void api(`/backups/restores/${r.id}`, { method: "DELETE" }).catch(() => {})
}

/**
 * Restore one item (D6): choose where, review exactly what it will do, confirm once, then read how each step went.
 * Closing before the confirm drops the review. The key stays on the page, never in the dialog.
 */
function RestoreDialog({
  open,
  item,
  inspection,
  privateKey,
  apiBase,
  instances,
  onClose,
}: {
  open: boolean
  item: { kind: RestoreKind; id: string; name: string }
  inspection: Inspection
  privateKey: string
  apiBase: string
  instances: TargetInstance[] | undefined
  onClose: () => void
}) {
  // Only an instance with Restore workflows chosen takes a restore; the archive's own one first when it can.
  const targets = activeWith(instances, "restore")
  const own = inspection.source.instanceId
  const fallback = targets.some((t) => t.id === own) ? (own ?? "") : (targets[0]?.id ?? "")
  const [picked, setPicked] = useState("")
  const target = targets.some((t) => t.id === picked) ? picked : fallback
  // Copy by default. Replace writes the workflow the archive is from, so only on its own instance.
  const [chosenMode, setMode] = useState<RestoreMode>("copy")
  // What the page knows of the instance can stop it too (its n8n version, its key's scopes); the server decides.
  const ownInstance = targets.find((t) => t.id === own)
  const replaceReason =
    target === "" || target !== own || !ownInstance
      ? "Replace works only on the instance the archive is from."
      : replaceBlocked(ownInstance)
  const canReplace = item.kind === "workflow" && replaceReason === null
  const mode: RestoreMode = canReplace ? chosenMode : "copy"
  const [restore, setRestore] = useState<RestoreView | null>(null)
  const [stillUnknown, setStillUnknown] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<"review" | "confirm" | "check" | null>(null)
  const current = React.useRef<RestoreView | null>(null)
  current.current = restore
  // Leaving the page with a review open drops it too.
  React.useEffect(() => () => dropReview(current.current), [])

  async function act(what: "review" | "confirm" | "check", fn: () => Promise<RestoreView>) {
    setBusy(what)
    setError("")
    try {
      const r = await fn()
      setRestore(r)
      if (r.status !== "previewed")
        void queryClient.invalidateQueries({ queryKey: [`/backups/${r.targetInstanceId}/restores`] })
      return r
    } catch (e) {
      setError(describeError(e))
      return null
    } finally {
      setBusy(null)
    }
  }
  // Also "Review again" after an unknown outcome: a new review, which names the earlier restore.
  const review = async () => {
    const next = await act("review", () =>
      api<RestoreView>(`${apiBase}/restores`, {
        method: "POST",
        json: { privateKey, targetInstanceId: target, kind: item.kind, itemId: item.id, mode },
      }),
    )
    if (next) setStillUnknown(false)
  }
  // A replace the server refused says why; the copy is offered instead.
  const asCopy = () => {
    setMode("copy")
    setError("")
  }
  const confirmIt = (r: RestoreView) =>
    act("confirm", () =>
      api<RestoreView>(`/backups/restores/${r.id}/confirm`, { method: "POST", json: { privateKey } }),
    )
  const check = async (r: RestoreView) => {
    const next = await act("check", () => checkRestore(r))
    setStillUnknown(next?.status === "unknown")
  }
  const back = () => {
    dropReview(restore)
    setRestore(null)
    setError("")
  }
  const close = () => {
    // The confirm runs once and is not called off; its result shows when it ends.
    if (busy === "confirm") return
    dropReview(restore)
    setRestore(null)
    setStillUnknown(false)
    setError("")
    setPicked("")
    setMode("copy")
    onClose()
  }

  const r = restore
  const ended = r !== null && r.status !== "previewed"
  const replacing = (r?.mode ?? mode) === "replace"
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="md:max-w-2xl" keepOnBackdrop>
        <DialogHeader icon={ArchiveRestoreIcon}>
          <DialogTitle>Restore {item.name}</DialogTitle>
          <DialogDescription>
            {item.kind === "credential"
              ? "Creates a new credential from the secrets in the archive. You review it before anything is written."
              : replacing
                ? "Writes the archived version over the workflow in n8n, as its draft, with the credentials it needs. You review every action before anything is written."
                : "Creates a copy of the workflow, inactive, with the credentials it needs. You review every action before anything is written."}
          </DialogDescription>
        </DialogHeader>

        {!r ? (
          <FieldGroup>
            <Field>
              <FieldLabel>Restore into</FieldLabel>
              {targets.length ? (
                <FieldPicker
                  label="Restore into"
                  listLabel="Instances"
                  value={target}
                  onChange={setPicked}
                  options={targets.map((i) => ({
                    value: i.id,
                    label: i.name,
                    hint: i.id === own ? "same instance" : undefined,
                  }))}
                />
              ) : (
                <FieldDescription>
                  {instances
                    ? "No instance takes a restore. Add Restore workflows to an instance's capabilities first."
                    : "Loading the instances…"}
                </FieldDescription>
              )}
            </Field>
            {item.kind === "workflow" && (
              <Field>
                <FieldLabel id="restore-mode-label">How</FieldLabel>
                <ToggleGroup
                  type="single"
                  aria-labelledby="restore-mode-label"
                  value={mode}
                  onValueChange={(v) => {
                    if (v === "copy" || v === "replace") setMode(v)
                    setError("")
                  }}
                >
                  <ToggleGroupItem value="copy">As a copy</ToggleGroupItem>
                  <ToggleGroupItem
                    value="replace"
                    disabled={!canReplace}
                    aria-describedby={canReplace ? undefined : "restore-mode-reason"}
                  >
                    Replace the current workflow
                  </ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription id={canReplace ? undefined : "restore-mode-reason"}>
                  {!canReplace
                    ? replaceReason
                    : mode === "replace"
                      ? "The archived version becomes the workflow's draft in n8n. n8n-ops never publishes it; the version in n8n now is kept, so you can put it back."
                      : "A new, inactive workflow beside the one in n8n."}
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
        ) : !ended ? (
          <PlanReview restore={r} />
        ) : (
          <RestoreResult restore={r} stillUnknown={stillUnknown} />
        )}
        {error && <FieldError>{error}</FieldError>}
        {error && !r && mode === "replace" && (
          <div>
            <Button size="sm" onClick={asCopy}>
              Restore as a copy instead
            </Button>
          </div>
        )}

        <DialogFooter>
          {!r ? (
            <>
              <Button onClick={close}>Cancel</Button>
              <BusyButton
                variant="primary"
                disabled={!target}
                busy={busy === "review"}
                busyLabel="Reviewing…"
                onClick={() => void review()}
              >
                Review
              </BusyButton>
            </>
          ) : !ended ? (
            <>
              <Button onClick={back} disabled={busy !== null}>
                Back
              </Button>
              <BusyButton
                variant="primary"
                busy={busy === "confirm"}
                busyLabel={replacing ? "Replacing…" : "Restoring…"}
                onClick={() => void confirmIt(r)}
              >
                {replacing ? "Replace" : "Restore"}
              </BusyButton>
            </>
          ) : (
            <>
              {r.status === "unknown" && stillUnknown && (
                <BusyButton busy={busy === "review"} busyLabel="Reviewing…" onClick={() => void review()}>
                  Review again
                </BusyButton>
              )}
              {r.status === "unknown" && (
                <BusyButton
                  icon={RefreshCw}
                  busy={busy === "check"}
                  busyLabel="Checking…"
                  disabled={busy !== null}
                  onClick={() => void check(r)}
                >
                  Check and try again
                </BusyButton>
              )}
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
