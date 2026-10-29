import { type CapabilityKey, capabilityKeys, capabilityLabels, requirementsOf } from "@n8n-ops/shared"
import {
  ArchiveRestore,
  ArrowRightLeft,
  Bug,
  Check,
  DatabaseBackup,
  HeartPulse,
  KeyRound,
  LoaderCircle,
  type LucideIcon,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { AgentAccessFields } from "@/components/agent-access-card"
import { useDiscardGuard } from "@/components/discard-guard"
import { FieldPicker } from "@/components/field-picker"
import { BusyButton, LoadError, Loading, Page, Panel, PanelHead, SecretField } from "@/components/kit"
import { type ProxyFix, ProxyFixBlock } from "@/components/proxy-fix"
import { Dot, StatusTag, TimeAgo, Tone } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ApiError, api, describeError, queryClient, refreshAreas, useApi } from "@/lib/api"
import {
  badgesOf,
  type CheckView,
  firstOpenStep,
  neededSteps,
  parseAdd,
  type Selection,
  type SetupData,
  type StepKey,
  type StepMark,
  scopeHint,
  stepCheck,
  stepMark,
  stepsOf,
  stepTitles,
  toggle,
  waitingForWorker,
} from "@/lib/instance-setup"
import { n } from "@/lib/numbers"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { type Choice, type Destination, DestinationChoice } from "./destinations"
import {
  type InstanceDetailData,
  MainTargetFields,
  mainTargetBody,
  mainTargetOf,
  mainTargetSet,
  normalUrl,
  QueueFields,
  queueBody,
  queueFormOf,
} from "./instances"
import { AddWorkerDialog, type Worker } from "./workers"

/*
 * Adding an instance, or a capability to an active one (docs/adr/0002). The first step chooses what the instance
 * is for; only the steps those need follow, each saves its fields and checks what it set up, and the review
 * activates once every check passed. Which steps show and how each stands is read from GET /instances/:id/setup,
 * so a reload, Finish later and another tab all find the same. The step open is in the address (?step=).
 */

/** What each capability does, on its card. */
const about: Record<CapabilityKey, string> = {
  health: "Whether n8n is up and ready; in queue mode also its queue and queue workers.",
  monitor: "Reads failed executions and groups them into problems, with alerts.",
  map: "Lists the workflows with their runs, webhooks and duplicates.",
  move: "Moves a workflow, with its credentials, to or from another instance.",
  agents: "Agents may ask for temporary access to this n8n's API; you approve every request.",
  backup: "A daily encrypted backup of the workflows and credentials.",
  restore: "Restores a workflow from a backup into this instance.",
}

/** Each capability's icon on its tile; those with a page of their own use that page's icon. */
const icons: Record<CapabilityKey, LucideIcon> = {
  health: HeartPulse,
  monitor: Bug,
  map: Workflow,
  move: ArrowRightLeft,
  agents: KeyRound,
  backup: DatabaseBackup,
  restore: ArchiveRestore,
}

/** Move workflows needs the map, and Restore needs backups; each is chosen only after the one it needs. */
const parentOf: Partial<Record<CapabilityKey, CapabilityKey>> = { move: "map", restore: "backup" }

/*
 * The tiles fill every row at each width: Health is twice as wide, and so is Backup in three columns.
 * Four columns: Health, Monitoring, Agents / Map, Move, Backup, Restore. Three: Health, Monitoring / Agents, Map,
 * Move / Backup, Restore. Two: Health / then pairs, each pair beside the one it needs.
 */
const tileOrder: CapabilityKey[] = ["health", "monitor", "agents", "map", "move", "backup", "restore"]
const spans: Partial<Record<CapabilityKey, string>> = {
  health: "@[26rem]/caps:col-span-2",
  backup: "@[40rem]/caps:col-span-2 @[54rem]/caps:col-span-1",
}

type BasicsForm = Selection & { name: string; baseUrl: string }

const newForm: BasicsForm = { name: "", baseUrl: "", chosen: ["health"], collection: "direct", backupVia: "worker" }

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** "A, B and C". */
const words = (list: string[]) =>
  list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`

export function InstanceSetupPage() {
  const { id } = useParams()
  return id ? <ExistingSetup key={id} id={id} /> : <NewInstance />
}

/** The steps a selection will need, for the rail while the first step is still being filled in. */
function previewSteps(form: BasicsForm, active: CapabilityKey[] = []): StepKey[] {
  const verify = form.chosen.filter((k) => !active.includes(k))
  return ["basics", ...neededSteps(requirementsOf(verify, form)), "review"]
}

function NewInstance() {
  const navigate = useNavigate()
  useCrumb("Add an instance")
  const [form, setForm] = useState(newForm)
  const [error, setError] = useState("")
  const guard = useDiscardGuard(form.name.trim() !== "" || form.baseUrl.trim() !== "", () =>
    navigate("/instances", { replace: true }),
  )
  async function create() {
    setError("")
    try {
      const { id } = await api<{ id: string }>("/instances", {
        method: "POST",
        json: {
          name: form.name.trim(),
          baseUrl: normalUrl(form.baseUrl),
          chosen: form.chosen,
          collection: form.collection,
          backupVia: form.backupVia,
        },
      })
      void queryClient.invalidateQueries({ queryKey: ["/instances"] })
      // The draft takes this page's place, so Back from its setup goes where Add instance was pressed.
      navigate(`/instances/${id}/setup`, { replace: true })
    } catch (e) {
      setError(basicsError(e))
      throw e
    }
  }
  return (
    <SetupFrame
      title="Add an Instance"
      description="Choose what the instance is for. Only the steps those need follow, and each is checked before the instance is activated."
      rail={<StepRail steps={previewSteps(form)} current="basics" mark={() => "todo"} />}
    >
      <BasicsStep
        form={form}
        onChange={setForm}
        error={error}
        actions={
          <StepActions start={<Button onClick={() => void guard.requestClose()}>Cancel</Button>}>
            <BusyButton
              variant="primary"
              busyLabel="Saving…"
              disabled={!form.name.trim() || !form.baseUrl.trim() || form.chosen.length === 0}
              run={create}
            >
              Continue
            </BusyButton>
          </StepActions>
        }
      />
    </SetupFrame>
  )
}

/** A refused first step in words: the name taken, the address not a URL. */
function basicsError(e: unknown) {
  if (e instanceof ApiError && e.issues?.length) {
    const issue = e.issues[0]
    if (issue?.path[0] === "name" && issue.message === "already used")
      return "An instance with this name exists. Choose another name."
    if (issue?.path[0] === "baseUrl") return "The base URL must be a full address, such as https://n8n.example.com."
  }
  return describeError(e)
}

/** What a step needs from the page around it. */
type StepContext = {
  id: string
  setup: SetupData
  detail: InstanceDetailData
  add: CapabilityKey[]
  /** Reads the setup and the instance again, and returns the setup as it is now. */
  reread: () => Promise<SetupData>
  /** Goes on to the step after this one, as the setup stands now. */
  next: (fresh: SetupData) => void
  back: () => void
  go: (step: StepKey) => void
  /** Leaves for the instance's page. */
  leave: (finishLater: boolean) => void
}

function ExistingSetup({ id }: { id: string }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const add = parseAdd(params.get("add"), capabilityKeys)
  const path = `/instances/${id}/setup${add.length ? `?add=${add.join(",")}` : ""}`
  const [polling, setPolling] = useState(false)
  const setup = useApi<SetupData>(path, { refetchInterval: polling ? 2_000 : undefined })
  const detail = useApi<InstanceDetailData>(`/instances/${id}`)
  const s = setup.data
  const d = detail.data
  // A worker check ends in the worker's own time: the page asks every 2 seconds until it has (deadline included).
  useEffect(() => setPolling(waitingForWorker(s)), [s])
  const draft = s?.setupState === "incomplete"
  useCrumb(s?.name ?? d?.name)
  useCrumb(s ? (draft ? "Setup" : "Add capability") : null)
  // Steps taken on this page stay on the rail of an active instance, also once their check passes.
  const [taken, setTaken] = useState<StepKey[]>([])
  const [form, setForm] = useState<BasicsForm | null>(null)
  const [basicsFailure, setBasicsFailure] = useState("")
  useEffect(() => {
    if (!s || form) return
    setForm({
      name: s.name,
      baseUrl: s.baseUrl,
      chosen: s.after,
      collection: s.collection,
      backupVia: s.backupVia,
    })
  }, [s, form])

  const asked = params.get("step") as StepKey | null
  const steps = s ? stepsOf(s, asked ? [...taken, asked] : taken) : (["basics", "review"] as StepKey[])
  // An active instance with nothing to add yet starts by choosing what to add.
  const choosing = Boolean(s && !draft && add.length === 0)
  const current: StepKey | null = choosing ? "basics" : asked && steps.includes(asked) ? asked : null

  const go = (step: StepKey, more: Record<string, string | null> = {}) => {
    setTaken((t) => (t.includes(step) ? t : [...t, step]))
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("step", step)
        for (const [k, v] of Object.entries(more)) {
          if (v === null) next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace: true },
    )
  }
  // Opened without a step (Continue setup, a new draft, a new choice to add): where the setup stands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pins the step once the setup has been read
  useEffect(() => {
    if (!s || current || choosing) return
    go(s.verify.length === 0 ? "basics" : firstOpenStep(s, steps))
  }, [s, current, choosing])

  const reread = async () => {
    // The instance and its setup (both under /instances/<id>), marked saved so an answer that left before is not used.
    await refreshAreas(`/instances/${id}`)
    const fresh = queryClient.getQueryData<SetupData>([path])
    if (!fresh) throw new Error("The setup could not be read again. Reload the page.")
    return fresh
  }
  const leave = (finishLater: boolean) => {
    if (finishLater) toast.success(`${s?.name ?? "The instance"} is saved as Setup incomplete. Continue from its page.`)
    navigate(`/instances/${id}`, { replace: true })
  }

  const failed = (!s && setup.error) || (!d && detail.error)
  if (failed)
    return (
      <Panel>
        <LoadError
          what="the setup"
          error={failed}
          retry={() => {
            void setup.refetch()
            void detail.refetch()
          }}
        />
      </Panel>
    )
  if (!s || !d || !form) return <Loading>Loading the setup…</Loading>

  const active = draft ? [] : s.chosen
  const shown = current === "basics" ? previewSteps(form, active) : steps
  const marks = (step: StepKey): StepMark => (current === "basics" && step !== "basics" ? "todo" : stepMark(s, step))
  const index = current ? steps.indexOf(current) : -1
  const context: StepContext = {
    id,
    setup: s,
    detail: d,
    add,
    reread,
    next: (fresh) => {
      const after = stepsOf(fresh, [...taken, ...(current ? [current] : [])])
      const at = current ? after.indexOf(current) : -1
      go(after[at + 1] ?? firstOpenStep(fresh, after))
    },
    back: () => go(steps[index - 1] ?? "basics"),
    go,
    leave,
  }

  /** Saves the first step: a draft's details and selection; for an active instance, what it adds. */
  async function saveBasics() {
    if (!s || !form) return
    const body: Record<string, unknown> = {}
    if (draft) {
      if (form.name.trim() !== s.name) body.name = form.name.trim()
      if (normalUrl(form.baseUrl) !== s.baseUrl) {
        body.baseUrl = normalUrl(form.baseUrl)
        // The stored key was tested against the old address; the API step asks for it again.
        if (s.hasApiKey) body.apiKey = null
      }
      if (!sameList(form.chosen, s.chosen)) body.chosen = form.chosen
    }
    const adding = form.chosen.filter((k) => !active.includes(k))
    // Where health and backups come from is set only with the capability that uses it.
    if (form.collection !== s.collection && (draft || adding.includes("health"))) body.collection = form.collection
    if (form.backupVia !== s.backupVia && (draft || adding.includes("backup"))) body.backupVia = form.backupVia
    if (Object.keys(body).length) await api(`/instances/${id}`, { method: "PATCH", json: body })
  }
  let body: React.ReactNode = null
  if (current === "basics") {
    const adding = form.chosen.filter((k) => !active.includes(k))
    const cont = async () => {
      setBasicsFailure("")
      try {
        await saveBasics()
        if (draft) context.next(await reread())
        else {
          await reread()
          // A new choice: its steps are read for it, starting where its checks stand.
          setTaken([])
          setParams({ add: adding.join(",") }, { replace: true })
        }
      } catch (e) {
        setBasicsFailure(basicsError(e))
        throw e
      }
    }
    body = (
      <BasicsStep
        form={form}
        onChange={setForm}
        active={active}
        error={basicsFailure}
        actions={
          <StepActions
            start={
              draft ? (
                <FinishLater
                  save={async () => {
                    try {
                      await saveBasics()
                    } catch (e) {
                      setBasicsFailure(basicsError(e))
                      throw e
                    }
                  }}
                  leave={() => leave(true)}
                />
              ) : (
                <Button onClick={() => leave(false)}>Cancel</Button>
              )
            }
          >
            <BusyButton
              variant="primary"
              busyLabel="Saving…"
              disabled={!form.name.trim() || !form.baseUrl.trim() || adding.length === 0}
              run={cont}
            >
              Continue
            </BusyButton>
          </StepActions>
        }
      />
    )
  } else if (current === "api") body = <ApiStep {...context} />
  else if (current === "worker") body = <WorkerStep {...context} />
  else if (current === "health") body = <HealthStep {...context} />
  else if (current === "access") body = <AccessStep {...context} />
  else if (current === "backup") body = <BackupStep {...context} />
  else if (current === "review") body = <ReviewStep {...context} />
  else body = <Loading />

  return (
    <SetupFrame
      title={draft ? `Set Up ${s.name}` : `Add to ${s.name}`}
      description={
        draft
          ? "Each step saves its fields and checks them. Finish later keeps the instance as Setup incomplete: it does nothing in the background until it is activated."
          : "Choose what to add. Only its own checks run; what is active now keeps working meanwhile."
      }
      rail={
        <StepRail
          steps={shown}
          current={current}
          mark={marks}
          // Before the first step is saved, the others follow from what it will save.
          onPick={current === "basics" ? undefined : (step) => go(step)}
        />
      }
    >
      {body}
    </SetupFrame>
  )
}

function SetupFrame({
  title,
  description,
  rail,
  children,
}: {
  title: string
  description: string
  rail: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Page title={title} description={description}>
      <div className="grid min-w-0 items-start gap-gap md:grid-cols-[minmax(11rem,13rem)_minmax(0,1fr)]">
        {rail}
        <div className="grid min-w-0 gap-gap">{children}</div>
      </div>
    </Page>
  )
}

const markWords: Record<StepMark, string> = {
  done: " (passed)",
  attention: " (needs a check)",
  running: " (checking)",
  todo: "",
}

/**
 * The steps, with how each stands: a check mark when its check passed, an exclamation mark when it failed or no
 * longer counts, a ring while it runs. Beside the steps on a wide screen; above them, one line, on a phone, where
 * only the open step keeps its name.
 */
function StepRail({
  steps,
  current,
  mark,
  onPick,
}: {
  steps: StepKey[]
  current: StepKey | null
  mark: (step: StepKey) => StepMark
  onPick?: (step: StepKey) => void
}) {
  const list = useRef<HTMLOListElement>(null)
  // On a phone the rail is one line that scrolls: the open step is brought into it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another step opens
  useEffect(() => {
    const ol = list.current
    const here = ol?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!ol || !here || ol.scrollWidth <= ol.clientWidth) return
    ol.scrollLeft = here.offsetLeft - (ol.clientWidth - here.offsetWidth) / 2
  }, [current])
  return (
    <nav
      aria-label="Setup steps"
      className="min-w-0 rounded-lg bg-panel p-1.5 regular:shadow-card regular:ring-1 regular:ring-ink/10"
    >
      <ol ref={list} className="relative flex min-w-0 gap-1 overflow-x-auto md:grid md:overflow-visible">
        {steps.map((step, i) => {
          const m = mark(step)
          const here = step === current
          const inner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full text-meta font-bold tabular-nums",
                  here
                    ? "bg-primary text-primary-foreground"
                    : m === "done"
                      ? "tint-ok"
                      : m === "attention"
                        ? "tint-warn"
                        : m === "running"
                          ? "tint-info"
                          : "tint-muted",
                )}
              >
                {here ? (
                  i + 1
                ) : m === "done" ? (
                  <Check className="size-3.5" strokeWidth={3} />
                ) : m === "attention" ? (
                  "!"
                ) : m === "running" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  i + 1
                )}
              </span>
              <span className={cn("min-w-0 truncate", !here && "max-md:sr-only")}>{stepTitles[step]}</span>
              <span className="sr-only">{markWords[m]}</span>
            </>
          )
          const cls = "flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2.5 py-2 text-start text-ctl"
          return (
            <li key={step} className="min-w-0 shrink-0">
              {onPick && !here ? (
                <button
                  type="button"
                  className={cn(cls, "hover-row text-muted-foreground")}
                  onClick={() => onPick(step)}
                >
                  {inner}
                </button>
              ) : (
                <div
                  aria-current={here ? "step" : undefined}
                  className={cn(cls, here ? "bg-accent font-semibold" : "text-muted-foreground")}
                >
                  {inner}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** One step: its title and what it is for, its fields and checks, and its actions at the bottom. */
function StepPanel({
  title,
  description,
  children,
  actions,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  actions: React.ReactNode
}) {
  return (
    <Panel className="overflow-visible">
      <PanelHead title={title} description={description} />
      <div className="grid min-w-0 gap-4 border-t border-line p-pad-x">{children}</div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-pad-x py-3">{actions}</div>
    </Panel>
  )
}

/** Leaving at the start (Cancel, Finish later); going back, checking and going on at the end. */
function StepActions({ start, children }: { start: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      {start}
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
    </>
  )
}

/** Saves the step's fields and leaves the instance as Setup incomplete. */
function FinishLater({ save, leave }: { save: () => Promise<unknown>; leave: () => void }) {
  return (
    <BusyButton
      busyLabel="Saving…"
      run={async () => {
        await save()
        leave()
      }}
    >
      Finish later
    </BusyButton>
  )
}

/** The actions every step after the first shares; `check` is the step's own Check button. */
function Actions({
  context,
  save,
  check,
  onContinue,
  continueDisabled,
  waiting,
}: {
  context: StepContext
  save: () => Promise<unknown>
  check?: React.ReactNode
  onContinue: () => Promise<unknown>
  continueDisabled?: boolean
  /** Why Continue cannot be used yet, said beside it (AX-9). */
  waiting?: string
}) {
  const draft = context.setup.setupState === "incomplete"
  return (
    <StepActions
      start={
        draft ? (
          <FinishLater
            save={async () => {
              // The step's fields could not be saved: said, and the page stays where it is.
              try {
                await save()
              } catch (e) {
                toast.error(`Not saved: ${describeError(e)}`)
                throw e
              }
            }}
            leave={() => context.leave(true)}
          />
        ) : (
          <Button onClick={() => context.leave(false)}>Cancel</Button>
        )
      }
    >
      {waiting && <span className="text-small text-muted-foreground">{waiting}</span>}
      <Button onClick={context.back}>Back</Button>
      {check}
      <BusyButton variant="primary" busyLabel="Saving…" disabled={continueDisabled} run={onContinue}>
        Continue
      </BusyButton>
    </StepActions>
  )
}

/** A check as it stands: its result, when it ran, and why it did not pass. */
function CheckLine({ check, children }: { check: CheckView | null; children?: React.ReactNode }) {
  if (!check) return null
  return (
    <div role="status" className="grid min-w-0 gap-1.5" data-testid="check-line">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <StatusTag kind="check" status={check.state} />
        {check.state === "running" ? (
          <span className="text-muted-foreground">Waiting for the worker. It asks for work every few seconds.</span>
        ) : (
          check.at &&
          check.state !== "missing" && (
            <span className="text-small text-muted-foreground">
              Checked <TimeAgo value={check.at} />
            </span>
          )
        )}
      </div>
      {check.reason && (check.state === "failed" || check.state === "stale") && (
        <p className={cn("min-w-0 break-words", check.state === "failed" ? "font-semibold text-fail" : "text-warn")}>
          {check.reason}
        </p>
      )}
      {children}
    </div>
  )
}

/** The first step: the name and address, and what the instance is for. */
function BasicsStep({
  form,
  onChange,
  active = [],
  error,
  actions,
}: {
  form: BasicsForm
  onChange: (form: BasicsForm) => void
  /** Capabilities an active instance has already; they are shown, not chosen again. */
  active?: CapabilityKey[]
  error: string
  actions: React.ReactNode
}) {
  const adding = active.length > 0
  const set = (patch: Partial<BasicsForm>) => onChange({ ...form, ...patch })
  /*
   * One tile per capability: its icon, name, what it does and what it needs. The whole tile is the checkbox's
   * label. Where only one column fits the tile is a row, the icon beside the text; otherwise it stands as a square.
   */
  const tile = (key: CapabilityKey) => {
    const on = form.chosen.includes(key)
    const locked = active.includes(key)
    const parent = parentOf[key]
    const blocked = parent !== undefined && !form.chosen.includes(parent)
    const badges = badgesOf(key, form)
    const Icon = icons[key]
    return (
      <label
        key={key}
        htmlFor={`cap-${key}`}
        data-testid={`card-${key}`}
        className={cn(
          "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] content-start gap-x-3.5 gap-y-2 rounded-lg border border-line bg-bg p-4 transition-colors duration-150 @[26rem]/caps:min-h-48 @[26rem]/caps:grid-cols-[minmax(0,1fr)_auto] @[26rem]/caps:grid-rows-[auto_auto_1fr] @[26rem]/caps:gap-y-3 @[26rem]/caps:p-5 regular:shadow-card",
          on ? "border-primary ring-1 ring-primary" : !(locked || blocked) && "hover:border-muted-foreground/55",
          locked || blocked ? "cursor-not-allowed" : "cursor-pointer",
          blocked && "opacity-60",
          spans[key],
        )}
      >
        <span
          aria-hidden
          className={cn(
            "row-span-2 grid size-11 place-items-center rounded-lg transition-colors duration-150 @[26rem]/caps:row-span-1 @[26rem]/caps:size-12",
            on ? "bg-primary text-primary-foreground" : "bg-fill text-muted-foreground",
          )}
        >
          <Icon className="size-5.5 @[26rem]/caps:size-6" />
        </span>
        <Checkbox
          id={`cap-${key}`}
          aria-label={capabilityLabels[key]}
          aria-describedby={`cap-${key}-about`}
          className="col-start-3 row-start-1 @[26rem]/caps:col-start-2"
          checked={on}
          disabled={locked || blocked}
          onCheckedChange={(v) => set({ chosen: toggle(form.chosen, key, v === true) })}
        />
        <span className="col-start-2 row-start-1 grid min-w-0 gap-1 @[26rem]/caps:col-span-2 @[26rem]/caps:col-start-1 @[26rem]/caps:row-start-2">
          <span className="text-h2 font-semibold">{capabilityLabels[key]}</span>
          <span id={`cap-${key}-about`} className="text-small text-muted-foreground">
            {about[key]}
            {blocked && ` Needs ${capabilityLabels[parent]}.`}
          </span>
        </span>
        {(locked || badges.length > 0) && (
          <span className="col-start-2 flex min-w-0 flex-wrap items-end gap-1.5 @[26rem]/caps:col-span-2 @[26rem]/caps:col-start-1 @[26rem]/caps:row-start-3">
            {locked ? (
              <Tone tone="ok">Active</Tone>
            ) : (
              badges.map((b) => (
                <Badge key={b} variant="line">
                  {b}
                </Badge>
              ))
            )}
          </span>
        )}
      </label>
    )
  }
  const askHealth = form.chosen.includes("health") && !active.includes("health")
  const askBackup = form.chosen.includes("backup") && !active.includes("backup")
  return (
    <StepPanel
      title={adding ? "What to Add" : stepTitles.basics}
      description={
        adding
          ? "What is active now stays as it is and is not checked again."
          : "The name and address of the n8n instance, and what n8n-ops does for it."
      }
      actions={actions}
    >
      {!adding && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="i-name">Name</FieldLabel>
            <Input id="i-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="n8n-1" />
            <FieldDescription>Letters, digits, dot, dash and underscore.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="i-url">Base URL</FieldLabel>
            <Input
              id="i-url"
              value={form.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://n8n.example.com"
            />
            <FieldDescription>Where n8n-ops reaches n8n and its API.</FieldDescription>
          </Field>
        </div>
      )}
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 font-semibold">{adding ? "Capabilities" : "What is it for?"}</legend>
        <div className="@container/caps min-w-0">
          <div className="grid min-w-0 grid-cols-1 gap-3 @[26rem]/caps:grid-cols-2 @[40rem]/caps:grid-cols-3 @[54rem]/caps:grid-cols-4">
            {tileOrder.map(tile)}
          </div>
        </div>
      </fieldset>
      {(askHealth || askBackup) && (
        <div className="grid min-w-0 items-start gap-3 lg:grid-cols-2">
          {askHealth && (
            <SubChoice
              icon={icons.health}
              label="Health is checked by"
              value={form.collection}
              onChange={(v) => set({ collection: v as BasicsForm["collection"] })}
              options={[
                { value: "direct", label: "The n8n-ops server" },
                { value: "worker", label: "The worker on the host" },
              ]}
              hint={
                form.collection === "direct"
                  ? "n8n-ops calls /healthz of the base URL."
                  : "The worker reads health inside the main container, so nothing has to be reachable from outside the host."
              }
            />
          )}
          {askBackup && (
            <SubChoice
              icon={icons.backup}
              label="Backups are made"
              value={form.backupVia}
              onChange={(v) => set({ backupVia: v as BasicsForm["backupVia"] })}
              options={[
                { value: "worker", label: "Through the worker (recommended)" },
                { value: "api", label: "Through the API only" },
              ]}
              hint={
                form.backupVia === "worker"
                  ? "The worker on the n8n host exports the workflows and the credentials with their secrets."
                  : undefined
              }
            >
              {form.backupVia === "api" && (
                <Alert variant="warn">
                  <AlertTitle>Credential secrets are not backed up</AlertTitle>
                  <AlertDescription>
                    Through the API a backup holds the workflows, and the credentials' names and types only when the API
                    key may list credentials (credential:list). Restored credentials need their secrets entered again.
                  </AlertDescription>
                </Alert>
              )}
            </SubChoice>
          )}
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
    </StepPanel>
  )
}

/** A chosen capability's own choice, such as where its health is checked from, in a box under the tiles. */
function SubChoice({
  icon: Icon,
  label,
  value,
  onChange,
  options,
  hint,
  children,
}: {
  icon: LucideIcon
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  hint?: string
  children?: React.ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-2.5 rounded-lg border border-line bg-bg p-4 md:p-5 regular:shadow-card">
      <span className="flex min-w-0 items-center gap-2 font-semibold">
        <Icon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
      <ToggleGroup type="single" segmented aria-label={label} value={value} onValueChange={(v) => v && onChange(v)}>
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value}>
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {hint && <p className="text-small text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

/** A step's own message: what failed when saving or checking, in words. */
function StepError({ error }: { error: string }) {
  return error ? <FieldError>{error}</FieldError> : null
}

/** Runs one of the setup checks and reads the setup again; the step then shows how it stands. */
async function runCheck(context: StepContext, kind: "api" | "health" | "worker" | "backup") {
  const body = kind === "api" && context.add.length ? { add: context.add } : undefined
  try {
    await api(`/instances/${context.id}/setup/${kind}`, { method: "POST", json: body })
  } finally {
    await context.reread()
  }
}

type ApiAnswer = {
  ok: boolean
  reason: string | null
  version: string | null
  keyStored: boolean
}

function ApiStep(context: StepContext) {
  const { setup: s, id } = context
  const [key, setKey] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState("")
  const check = s.checks.api
  const hint = scopeHint(s.requirements)
  const missing = (check?.current ? check.detail?.missingByCapability : undefined) as
    | Partial<Record<CapabilityKey, string[]>>
    | undefined
  const version = check?.current ? (check.detail?.version as string | null | undefined) : undefined
  const canTest = Boolean(key) || s.hasApiKey

  /** Tests the typed key, or the stored one; a typed key that works is stored. True when the step passes now. */
  async function test() {
    setError("")
    try {
      const answer = await api<ApiAnswer>(`/instances/${id}/setup/api`, {
        method: "POST",
        json: { ...(key ? { apiKey: key } : {}), ...(context.add.length ? { add: context.add } : {}) },
      })
      if (answer.keyStored) setKey(undefined)
      return Boolean((await context.reread()).checks.api?.ok)
    } catch (e) {
      setError(describeError(e))
      await context.reread().catch(() => {})
      throw e
    }
  }
  return (
    <StepPanel
      title={stepTitles.api}
      description="n8n-ops reads n8n through its public API. The key is tested before it is stored."
      actions={
        <Actions
          context={context}
          // Finish later keeps a typed key only once it works: it is stored by its test.
          save={async () => {
            if (key) await test()
          }}
          check={
            <BusyButton
              icon={RefreshCw}
              busyLabel="Testing…"
              disabled={!canTest}
              run={async () => {
                if (!(await test())) throw new Error("not passed")
              }}
            >
              Test
            </BusyButton>
          }
          onContinue={async () => {
            if (!canTest) {
              setError("Enter the API key of this n8n instance.")
              throw new Error("no key")
            }
            const ok = key || !check?.ok ? await test() : true
            if (!ok) throw new Error("not passed")
            context.next(await context.reread())
          }}
        />
      }
    >
      <Field>
        <FieldLabel htmlFor="setup-key">API key</FieldLabel>
        <SecretField
          id="setup-key"
          stored={s.hasApiKey}
          removable={false}
          placeholder="Paste the key"
          value={key}
          onChange={setKey}
        />
        <FieldDescription>In n8n: Settings → n8n API → Create an API key, with the scopes below.</FieldDescription>
      </Field>
      <div className="grid min-w-0 gap-2 rounded-sm bg-bg p-3" data-testid="scope-hint">
        <p className="text-small font-semibold text-muted-foreground">Scopes the key needs</p>
        {hint.lines.map((line) => {
          const lacks = missing?.[line.key]
          return (
            <div key={line.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="font-semibold">{line.label}</span>
              <span className="min-w-0 font-mono text-small break-words text-muted-foreground">
                {line.scopes.length ? line.scopes.join(", ") : "any; the agent asks for what it needs"}
              </span>
              {check?.current &&
                check.state !== "failed" &&
                (lacks?.length ? (
                  <Tone tone="fail">Missing {lacks.join(", ")}</Tone>
                ) : (
                  check.ok && <Tone tone="ok">Allowed</Tone>
                ))}
              {check?.state === "failed" && lacks?.length ? <Tone tone="fail">Missing {lacks.join(", ")}</Tone> : null}
            </div>
          )
        })}
      </div>
      <CheckLine check={check}>
        {version && (
          <p className="text-muted-foreground">
            n8n <span className="font-mono">{version}</span>
          </p>
        )}
      </CheckLine>
      <StepError error={error} />
    </StepPanel>
  )
}

type Probe = {
  main?: { ok: boolean; status?: number; error?: string }
  readiness?: { ok: boolean; status?: number }
  workers?: { url: string; name?: string; ok: boolean; error?: string }[]
  queue?: { waiting: number; active: number; completed: number; failed: number } | null
  metricsError?: string
  source?: "inside" | "network"
  mainState?: "running" | "not-running" | "paused"
  version?: string
  mode?: "queue" | "regular" | null
  resolvedContainer?: string
}

/** What a health check read: the main, its readiness, the queue workers and the queue. */
function ProbeRows({ probe }: { probe: Probe | undefined }) {
  if (!probe?.main) return null
  const rows: { label: string; ok: boolean | undefined; value: string }[] = [
    {
      label: "Main process (/healthz)",
      ok: probe.main.ok,
      value: probe.main.ok ? "ok" : (probe.main.error ?? `HTTP ${probe.main.status}`),
    },
  ]
  if (probe.readiness)
    rows.push({
      label: "Ready (/healthz/readiness)",
      ok: probe.readiness.ok,
      value: probe.readiness.ok ? "ok" : "not ready",
    })
  for (const w of probe.workers ?? [])
    rows.push({ label: `Queue worker ${w.name ?? w.url}`, ok: w.ok, value: w.ok ? "ok" : (w.error ?? "not ready") })
  if (probe.queue)
    rows.push({
      label: "Queue",
      ok: true,
      value: `${n(probe.queue.waiting)} waiting, ${n(probe.queue.active)} active`,
    })
  if (probe.metricsError) rows.push({ label: "Queue metrics", ok: undefined, value: probe.metricsError })
  return (
    <div className="grid min-w-0 rounded-sm border border-line" data-testid="probe-rows">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex min-w-0 items-center gap-2.5 border-t border-line px-3 py-2 first:border-t-0"
        >
          <Dot health={r.ok === undefined ? "warn" : r.ok ? "ok" : "down"} />
          <span className="min-w-0 break-words">{r.label}</span>
          <span
            className={cn(
              "ms-auto min-w-0 text-end break-words",
              r.ok === false ? "font-semibold text-fail" : "text-muted-foreground",
            )}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/** What the worker check found: where it ran the command, and n8n as it saw it from inside. */
function WorkerFound({ check }: { check: CheckView | null }) {
  const detail = check?.detail as
    | { inside?: { container?: string; target?: { project: string; service: string } }; report?: Probe }
    | null
    | undefined
  if (!check || !detail || check.state === "running" || check.state === "missing") return null
  const where = detail.inside?.target
    ? `service ${detail.inside.target.service} of ${detail.inside.target.project}`
    : detail.inside?.container
  const r = detail.report
  const facts = [
    where && `Main: ${where}${r?.resolvedContainer ? ` (${r.resolvedContainer})` : ""}`,
    r?.source === "inside" ? "read inside the container" : r?.source === "network" ? "read over the network" : "",
    r?.version && `n8n ${r.version}`,
    r?.mode && `${r.mode} mode`,
  ].filter(Boolean)
  return facts.length ? <p className="text-muted-foreground">{facts.join(" · ")}</p> : null
}

function WorkerStep(context: StepContext) {
  const { setup: s, detail: d, id } = context
  const workers = useApi<Worker[]>("/workers", { refetchInterval: 5_000 })
  const [workerId, setWorkerId] = useState(d.workerId ?? "")
  const [target, setTarget] = useState(mainTargetOf(d))
  const [pairing, setPairing] = useState(false)
  // The workers there were when a pairing started: those that come after it are marked new.
  const [before, setBefore] = useState<Set<string> | null>(null)
  const [error, setError] = useState("")
  const check = s.checks.worker
  const changed =
    workerId !== (d.workerId ?? "") ||
    JSON.stringify(mainTargetBody(target)) !== JSON.stringify(mainTargetBody(mainTargetOf(d)))
  async function save() {
    if (!changed) return
    await api(`/instances/${id}`, { method: "PATCH", json: { workerId: workerId || null, ...mainTargetBody(target) } })
    await context.reread()
  }
  async function start() {
    setError("")
    if (!workerId) {
      setError("Choose the worker on this instance's host first.")
      throw new Error("no worker")
    }
    if (!mainTargetSet(target)) {
      setError("Set the main: its container name, or its Compose project and service.")
      throw new Error("no main")
    }
    try {
      await save()
      await runCheck(context, "worker")
    } catch (e) {
      setError(describeError(e))
      throw e
    }
  }
  const list = [...(workers.data ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  )
  const fix = (check?.detail?.proxyFix as ProxyFix | undefined) ?? null
  const running = check?.state === "running"
  return (
    <StepPanel
      title={stepTitles.worker}
      description="The worker runs on the n8n Docker host and connects out to n8n-ops. The check runs a command in the main container through it."
      actions={
        <Actions
          context={context}
          save={save}
          check={
            <BusyButton icon={RefreshCw} busyLabel="Starting…" disabled={running} run={start}>
              {check && check.state !== "missing" ? "Check again" : "Check"}
            </BusyButton>
          }
          continueDisabled={!check?.ok || changed}
          waiting={running ? "Checking…" : !check?.ok || changed ? "Check first" : undefined}
          onContinue={async () => context.next(await context.reread())}
        />
      }
    >
      <Field>
        <FieldLabel>Worker on this instance's host</FieldLabel>
        {workers.data && list.length === 0 ? (
          <p className="rounded-sm border border-dashed border-muted-foreground/55 px-3 py-2 text-small text-muted-foreground">
            No worker is paired yet. Pair one on this instance's host.
          </p>
        ) : (
          <FieldPicker
            label="Worker on this instance's host"
            listLabel="Workers"
            placeholder="Choose a worker"
            value={workerId}
            onChange={setWorkerId}
            options={list.map((w) => ({
              value: w.id,
              label: w.name,
              hint: `${w.online ? "Online" : "Offline"}${before && !before.has(w.id) ? " · new" : ""}`,
            }))}
          />
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            size="sm"
            onClick={() => {
              setBefore(new Set(list.map((w) => w.id)))
              setPairing(true)
            }}
          >
            <Plus /> Pair a new worker
          </Button>
          {before && (
            <span className="text-small text-muted-foreground" role="status">
              {list.some((w) => !before.has(w.id))
                ? `New: ${list
                    .filter((w) => !before.has(w.id))
                    .map((w) => `${w.name} (${w.online ? "online" : "not online yet"})`)
                    .join(", ")}. Choose it above.`
                : "A new worker shows here once it reports in; that takes a few seconds after docker compose up."}
            </span>
          )}
        </div>
      </Field>
      <MainTargetFields value={target} onChange={(patch) => setTarget((t) => ({ ...t, ...patch }))} />
      <CheckLine check={check}>
        <WorkerFound check={check} />
      </CheckLine>
      {fix && !check?.ok && <ProxyFixBlock fix={fix} refresh={[`/instances/${id}`]} />}
      <StepError error={error} />
      <AddWorkerDialog
        open={pairing}
        onOpenChange={(open) => {
          setPairing(open)
          if (!open) void queryClient.invalidateQueries({ queryKey: ["/workers"] })
        }}
      />
    </StepPanel>
  )
}

function HealthStep(context: StepContext) {
  const { setup: s, detail: d, id } = context
  const viaWorker = s.collection === "worker"
  const [queue, setQueue] = useState(queueFormOf(d))
  const [error, setError] = useState("")
  const check = stepCheck(s, "health")
  const changed = JSON.stringify(queueBody(queue)) !== JSON.stringify(queueBody(queueFormOf(d)))
  async function save() {
    if (!changed) return
    await api(`/instances/${id}`, { method: "PATCH", json: queueBody(queue) })
    await context.reread()
  }
  async function run() {
    setError("")
    try {
      await save()
      await runCheck(context, viaWorker ? "worker" : "health")
    } catch (e) {
      setError(describeError(e))
      throw e
    }
  }
  const probe =
    (viaWorker ? (check?.detail?.report as Probe | undefined) : (check?.detail as Probe | null)) ?? undefined
  const running = check?.state === "running"
  return (
    <StepPanel
      title={stepTitles.health}
      description={
        viaWorker
          ? `Checked by ${d.worker?.name ?? "the worker"} inside the main container: /healthz, readiness and in queue mode the queue.`
          : `Checked by the n8n-ops server at ${s.baseUrl}/healthz, with readiness and in queue mode the queue.`
      }
      actions={
        <Actions
          context={context}
          save={save}
          check={
            <BusyButton icon={RefreshCw} busyLabel="Checking…" disabled={running} run={run}>
              {check && check.state !== "missing" ? "Check again" : "Check"}
            </BusyButton>
          }
          continueDisabled={viaWorker && (!check?.ok || changed)}
          waiting={viaWorker ? (running ? "Checking…" : !check?.ok || changed ? "Check first" : undefined) : undefined}
          onContinue={async () => {
            if (!viaWorker && (changed || !check?.ok)) await run()
            const fresh = await context.reread()
            if (!stepCheck(fresh, "health")?.ok) throw new Error("not passed")
            context.next(fresh)
          }}
        />
      }
    >
      <QueueFields
        value={queue}
        onChange={(patch) => setQueue((q) => ({ ...q, ...patch }))}
        baseUrl={s.baseUrl}
        collection={s.collection}
        inside={viaWorker && Boolean(d.workerId) && Boolean(d.containerName || d.composeProject)}
        modeFound={d.queueModeSource === "found"}
      />
      <CheckLine check={check}>{check?.current && <ProbeRows probe={probe} />}</CheckLine>
      <StepError error={error} />
    </StepPanel>
  )
}

function AccessStep(context: StepContext) {
  const { setup: s, detail: d, id } = context
  const keyScopes = d.effectiveScopes
  const stored = () => ({
    enabled: d.agentAccess.enabled,
    scopes: new Set(d.agentAccess.scopes.filter((x) => keyScopes.includes(x))),
  })
  const [enabled, setEnabled] = useState(() => stored().enabled)
  const [scopes, setScopes] = useState(() => stored().scopes)
  const [error, setError] = useState("")
  const base = stored()
  const changed =
    enabled !== base.enabled || scopes.size !== base.scopes.size || [...scopes].some((x) => !base.scopes.has(x))
  async function save() {
    if (!changed) return
    await api(`/instances/${id}`, { method: "PATCH", json: { agentAccess: { enabled, scopes: [...scopes] } } })
    await context.reread()
  }
  const check = s.checks.access
  return (
    <StepPanel
      title={stepTitles.access}
      description={
        <>
          Agents may ask for temporary access to {s.name}, within what you allow here. You approve every request in{" "}
          <Link to="/access" className="font-semibold text-ink underline">
            Agent Access
          </Link>
          , and it ends on its own.
        </>
      }
      actions={
        <Actions
          context={context}
          save={save}
          onContinue={async () => {
            setError("")
            try {
              await save()
            } catch (e) {
              setError(describeError(e))
              throw e
            }
            const fresh = await context.reread()
            if (!fresh.checks.access?.ok) {
              setError(fresh.checks.access?.reason ?? "Temporary access is not set up yet.")
              throw new Error("not passed")
            }
            context.next(fresh)
          }}
        />
      }
    >
      {keyScopes.length === 0 ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground">
            Temporary access grants among the scopes n8n reports for the API key. Test the key first.
          </p>
          <Button size="sm" className="justify-self-start" onClick={() => context.go("api")}>
            Go to the API key
          </Button>
        </div>
      ) : (
        <AgentAccessFields
          id={id}
          name={s.name}
          keyScopes={keyScopes}
          enabled={enabled}
          scopes={scopes}
          onEnabled={setEnabled}
          onScopes={setScopes}
        />
      )}
      {changed && (
        <p className="text-small text-muted-foreground">
          Saving the policy changes the instance's settings, so the review asks for the checks before it again.
        </p>
      )}
      {check?.ok && !changed && <CheckLine check={check} />}
      <StepError error={error} />
    </StepPanel>
  )
}

function BackupStep(context: StepContext) {
  const { setup: s, detail: d, id } = context
  const destinations = useApi<Destination[]>("/destinations")
  const stored: Choice = { mode: d.backupDestinations, ids: d.backupDestinationIds }
  const [choice, setChoice] = useState<Choice>(stored)
  const [error, setError] = useState("")
  const check = s.checks.backup
  const changed =
    choice.mode !== stored.mode ||
    (choice.mode === "custom" && !sameList([...choice.ids].sort(), [...stored.ids].sort()))
  async function save() {
    if (!changed) return
    await api(`/instances/${id}/backup-destinations`, {
      method: "PUT",
      json: { mode: choice.mode, destinationIds: choice.ids },
    })
    await context.reread()
  }
  async function run() {
    setError("")
    try {
      await save()
      await runCheck(context, "backup")
    } catch (e) {
      setError(describeError(e))
      throw e
    }
  }
  const results =
    (check?.current
      ? (check.detail?.destinations as
          | { id: string; name: string; ok: boolean; notes?: string[]; error?: string }[]
          | undefined)
      : undefined) ?? []
  const noKey = check?.current && check.detail?.recipient === null
  return (
    <StepPanel
      title={stepTitles.backup}
      description={
        s.backupVia === "worker"
          ? "Through the worker: the workflows and the credentials with their secrets, encrypted with your backup key."
          : "Through the API: the workflows, encrypted with your backup key. Credential secrets are not backed up."
      }
      actions={
        <Actions
          context={context}
          save={save}
          check={
            <BusyButton icon={RefreshCw} busyLabel="Checking…" run={run}>
              {check && check.state !== "missing" ? "Check again" : "Check"}
            </BusyButton>
          }
          onContinue={async () => {
            if (changed || !check?.ok) await run()
            const fresh = await context.reread()
            if (!fresh.checks.backup?.ok) throw new Error("not passed")
            context.next(fresh)
          }}
        />
      }
    >
      {destinations.error && !destinations.data ? (
        <LoadError what="the destinations" error={destinations.error} retry={() => destinations.refetch()} />
      ) : !destinations.data ? (
        <Loading />
      ) : (
        <DestinationChoice id={`setup-${id}`} destinations={destinations.data} choice={choice} onChange={setChoice} />
      )}
      <CheckLine check={check}>
        {results.length > 0 && (
          <div className="grid min-w-0 rounded-sm border border-line">
            {results.map((r) => (
              <div
                key={r.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 border-t border-line px-3 py-2 first:border-t-0"
              >
                <Dot health={r.ok ? "ok" : "down"} />
                <span className="min-w-0 font-semibold">{r.name}</span>
                <span
                  className={cn("ms-auto min-w-0 text-end break-words", r.ok ? "text-muted-foreground" : "text-fail")}
                >
                  {r.ok ? "Works" : r.error}
                </span>
                {r.notes?.map((note) => (
                  <p key={note} className="w-full ps-5 text-small text-muted-foreground">
                    {note}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
        {noKey && (
          <Link to="/settings/keys" className="justify-self-start font-semibold underline">
            Open Encryption Keys
          </Link>
        )}
        {check?.current && !check.ok && results.length === 0 && !noKey && (
          <Link to="/settings/destinations" className="justify-self-start font-semibold underline">
            Open Backup Destinations
          </Link>
        )}
      </CheckLine>
      <StepError error={error} />
    </StepPanel>
  )
}

/** Which step proves a requirement that activation found not met. */
const stepOfRequirement: Record<string, StepKey> = {
  api: "api",
  health: "health",
  worker: "worker",
  backup: "backup",
  access: "access",
}

function ReviewStep(context: StepContext) {
  const { setup: s, id } = context
  const navigate = useNavigate()
  const [error, setError] = useState("")
  const draft = s.setupState === "incomplete"
  const steps = neededSteps(s.requirements)
  const added = s.verify.map((k) => capabilityLabels[k])
  async function activate() {
    setError("")
    try {
      await api(`/instances/${id}/activate`, {
        method: "POST",
        json: { configRevision: s.configRevision, ...(draft ? {} : { add: context.add }) },
      })
    } catch (e) {
      if (e instanceof ApiError && e.code === "revision_changed")
        setError("The settings changed since this page read them. Look over the checks and activate again.")
      else if (e instanceof ApiError && e.code === "requirement_not_met") {
        const step = stepOfRequirement[String(e.body?.requirement)]
        setError(`${step ? `${stepTitles[step]}: ` : ""}${describeError(e)}`)
      } else setError(describeError(e))
      await context.reread().catch(() => {})
      throw e
    }
    await queryClient.invalidateQueries()
    toast.success(draft ? `${s.name} is set up and active` : `Added ${words(added)} to ${s.name}`)
    navigate(`/instances/${id}`, { replace: true })
  }
  /** A check that can run from here again: the stored key, the health, the worker, the destinations. */
  const again = (step: StepKey): "api" | "health" | "worker" | "backup" | null => {
    if (step === "api") return s.hasApiKey ? "api" : null
    if (step === "health") return s.requirements.health ? "health" : "worker"
    if (step === "worker" || step === "backup") return step
    return null
  }
  // The checks that can run again from here and do not pass now, each once (health through the worker is its check).
  const pending = [
    ...new Set(
      steps.flatMap((step) => {
        const check = stepCheck(s, step)
        const kind = again(step)
        return kind && check && !check.ok && check.state !== "running" ? [kind] : []
      }),
    ),
  ]
  /** Runs checks again from here; a check that cannot run says why under the list. */
  async function recheck(kinds: ("api" | "health" | "worker" | "backup")[]) {
    setError("")
    try {
      for (const kind of kinds) await runCheck(context, kind)
    } catch (e) {
      setError(describeError(e))
      throw e
    }
  }
  return (
    <StepPanel
      title={stepTitles.review}
      description={
        draft
          ? `Every check must pass for the settings as they are now. Activate starts what ${s.name} was chosen for.`
          : `Only what is added is checked; ${s.chosen.map((k) => capabilityLabels[k]).join(", ")} keeps working as it is.`
      }
      actions={
        <StepActions
          start={
            draft ? (
              <FinishLater save={async () => {}} leave={() => context.leave(true)} />
            ) : (
              <Button onClick={() => context.leave(false)}>Cancel</Button>
            )
          }
        >
          {!s.ready && <span className="text-small text-muted-foreground">Every check must pass first</span>}
          <Button onClick={context.back}>Back</Button>
          <BusyButton variant="primary" busyLabel="Activating…" disabled={!s.ready} run={activate}>
            Activate
          </BusyButton>
        </StepActions>
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-[min(100%,18rem)] flex-1">
          <span className="font-semibold">{draft ? "Chosen: " : "Adding: "}</span>
          {added.join(", ") || "nothing yet"}
        </p>
        {/* A check goes stale when what it depends on changes (the base URL, the worker), or after 15 minutes. */}
        {pending.length > 0 && (
          <BusyButton size="sm" icon={RefreshCw} busyLabel="Checking…" run={() => recheck(pending)}>
            Check all again
          </BusyButton>
        )}
      </div>
      <div className="grid min-w-0 rounded-sm border border-line">
        {steps.map((step) => {
          const check = stepCheck(s, step)
          const kind = again(step)
          return (
            <div
              key={step}
              className="grid min-w-0 gap-1.5 border-t border-line px-3 py-2.5 first:border-t-0"
              data-testid={`review-${step}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="min-w-0 font-semibold">{stepTitles[step]}</span>
                {check && <StatusTag kind="check" status={check.state} />}
                <span className="ms-auto flex flex-wrap gap-1.5">
                  {kind && check && !check.ok && check.state !== "running" && (
                    <BusyButton size="sm" icon={RefreshCw} busyLabel="Checking…" run={() => recheck([kind])}>
                      Check again
                    </BusyButton>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => context.go(step)}>
                    Open
                  </Button>
                </span>
              </div>
              {check?.reason && !check.ok && check.state !== "missing" && (
                <p className={cn("text-small break-words", check.state === "failed" ? "text-fail" : "text-warn")}>
                  {check.reason}
                </p>
              )}
            </div>
          )
        })}
        {steps.length === 0 && (
          <p className="px-3 py-2.5 text-muted-foreground">Nothing to check: no chosen capability needs a check.</p>
        )}
      </div>
      <StepError error={error} />
    </StepPanel>
  )
}
