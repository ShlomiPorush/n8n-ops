import {
  dateFormatLabels,
  dateFormats,
  isDateFormat,
  isTimeFormat,
  type NumberLimits,
  numberProblem,
  settingKinds,
  timeFormatLabels,
  timeFormats,
  topicProblem,
  valueProblem,
  writingOf,
} from "@n8n-ops/shared"
import { useMutation } from "@tanstack/react-query"
import { ChevronDown, Download, KeyRound, ShieldCheck } from "lucide-react"
import { useEffect, useReducer, useRef, useState } from "react"
import { Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { afterGeneralSave } from "@/app/design-sync"
import { settingsGroups, settingsSectionLabel } from "@/app/settings-sections"
import { ChannelsInput } from "@/components/channels-input"
import { ChipsInput } from "@/components/chips-input"
import { FieldPicker } from "@/components/field-picker"
import {
  BusyButton,
  Command,
  countChanges,
  type FieldProblem,
  LoadError,
  Loading,
  Page,
  Panel,
  RefreshLine,
  SecretField,
  useSaveSource,
  useUnsavedIds,
} from "@/components/kit"
import { SectionIcon } from "@/components/skin/marks"
import { TimeZonePicker } from "@/components/time-zone-picker"
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
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ApiError, api, describeError, useApi, useApiMutation } from "@/lib/api"
import { download } from "@/lib/download"
import { useEdits } from "@/lib/edits"
import { addEntries } from "@/lib/entries"
import { loadView } from "@/lib/load-state"
import { flash, whenDrawn } from "@/lib/reveal"
import { type DateWriting, formatClock, formatDay, formatListTime, formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { DatabaseSection } from "@/pages/database"
import { DestinationsSection } from "@/pages/destinations"
import { routesFromForm, routesProblem, routesToForm, TopicRoutes } from "@/pages/topic-routes"

const designHint =
  "How the console looks, for everyone. Both have the same pages and functions: Regular has white cards, icons and the Inter typeface; Compact fits more on each screen. It changes as soon as you save."

export type FieldDef = {
  name: string
  label: string
  hint?: string
  type?:
    | "text"
    | "number"
    | "password"
    | "switch"
    | "time"
    | "list"
    | "channels"
    | "weekday"
    | "design"
    | "timezone"
    | "date-format"
    | "time-format"
    | "topic"
    | "routes"
  placeholder?: string
  needs?: string
  clear?: boolean
}

export const forms: Record<string, { title: string; description: string; fields: FieldDef[] }> = {
  general: {
    title: "General",
    description: "How this installation is reached.",
    fields: [
      {
        name: "publicUrl",
        label: "Public URL",
        hint: "Used in links sent by Telegram and email, for example https://ops.example.com. Changing it ends every agent connection; those agents must connect again. Passkeys work only at this address: after a change of host name, add them again.",
        placeholder: "https://ops.example.com",
        clear: true,
      },
      {
        name: "timezone",
        label: "Time zone",
        hint: "For report and backup schedules and every time shown here. Search by city, region or offset.",
        type: "timezone",
      },
      {
        name: "dateFormat",
        label: "Date format",
        hint: "Select your date format. Default: Browser.",
        type: "date-format",
      },
      {
        name: "timeFormat",
        label: "Time format",
        hint: "Select your time format. Default: 24-hour.",
        type: "time-format",
      },
      {
        name: "design",
        label: "Design",
        hint: designHint,
        type: "design",
      },
      {
        name: "releaseCheckHours",
        label: "Check for new n8n releases every (hours)",
        hint: "How often n8n-ops asks GitHub for the newest n8n release, shown beside each instance's version.",
        type: "number",
      },
    ],
  },
  alerts: {
    title: "Alerts",
    description: "What reaches Telegram and how messages are grouped. Everything else stays in the UI and reports.",
    fields: [
      { name: "newProblem", label: "New problem", type: "switch" },
      { name: "regression", label: "Regression", hint: "A resolved problem fails again.", type: "switch" },
      { name: "health", label: "Instance or queue worker down, queue backlog", type: "switch" },
      { name: "backup", label: "Backup failed or late", type: "switch" },
      {
        name: "groupingWindowSec",
        label: "Grouping window (seconds)",
        hint: "New problems with the same error inside this window go out as one message.",
        type: "number",
      },
      {
        name: "editWindowMin",
        label: "Edit instead of resend (minutes)",
        hint: "Later workflows with the same error update the original message for this long.",
        type: "number",
      },
      { name: "retryMin", label: "Retry failed sends every (minutes)", type: "number" },
    ],
  },
  telegram: {
    title: "Telegram",
    description: "The bot and chat that receive alerts. Buttons in messages need the public URL to be set.",
    fields: [
      { name: "botToken", label: "Bot token", type: "password" },
      { name: "chatId", label: "Chat ID", placeholder: "-100…", clear: true },
      {
        name: "defaultThreadId",
        label: "Default topic",
        placeholder: "General",
        hint: "In a group with topics, the topic for alerts no route sends elsewhere. Its number is in a message link: t.me/c/…/12/345 is topic 12. Empty: General.",
        type: "topic",
        clear: true,
      },
      {
        name: "accessThreadId",
        label: "Access requests topic",
        placeholder: "Same as the default topic",
        hint: "The topic for agent access requests. Empty: the default topic.",
        type: "topic",
        clear: true,
      },
      {
        name: "routes",
        label: "Topic routes",
        hint: "Alerts go to the topic of the first route they match, by instance, workflow name (a pattern, case doesn't matter) or workflow tag. Health and backup alerts match by instance only. A tag changed in n8n counts after the next workflow sync.",
        type: "routes",
      },
    ],
  },
  email: {
    title: "Email Reports",
    description: "Daily and weekly summaries: open problems, top failing workflows, health alerts, backups, versions.",
    fields: [
      { name: "dailyEnabled", label: "Daily report", type: "switch" },
      { name: "dailyTime", label: "Daily report time", type: "time", needs: "dailyEnabled" },
      { name: "weeklyEnabled", label: "Weekly report", type: "switch" },
      { name: "weeklyDay", label: "Weekly report day", type: "weekday", needs: "weeklyEnabled" },
      { name: "weeklyTime", label: "Weekly report time", type: "time", needs: "weeklyEnabled" },
      {
        name: "recipients",
        label: "Recipients",
        hint: "Email addresses. Press Enter or type a comma after each; a pasted list is split.",
        placeholder: "ops@example.com",
        type: "list",
      },
      { name: "from", label: "From address", clear: true },
      { name: "smtpHost", label: "SMTP server", clear: true },
      { name: "smtpPort", label: "SMTP port", type: "number" },
      { name: "smtpSecure", label: "TLS from the start (port 465)", type: "switch" },
      {
        name: "smtpAllowUnencrypted",
        label: "Allow sending without encryption",
        hint: "Off: mail goes only over TLS from the start or STARTTLS, and a server that offers neither is refused. On: the SMTP password and every email may cross the network in clear text. Only for a relay you trust on a private network.",
        type: "switch",
      },
      { name: "smtpUser", label: "SMTP user", clear: true },
      { name: "smtpPassword", label: "SMTP password", type: "password" },
    ],
  },
  defaults: {
    title: "Instance Defaults",
    description: "Used by every instance unless it has an override.",
    fields: [
      { name: "pollIntervalSec", label: "Check for failures every (seconds)", type: "number" },
      { name: "healthIntervalSec", label: "Collect health every (seconds)", type: "number" },
      {
        name: "downAfterFailures",
        label: "Down alert after failed checks in a row",
        hint: "3 to 20. The alert comes with the last of them: with 3 checks 30 seconds apart, about a minute after the first failed one. A single slow or failed check alerts no one.",
        type: "number",
      },
      { name: "backupTime", label: "Daily backup time", type: "time" },
      { name: "staleBackupHours", label: "Backup is late after (hours)", type: "number" },
      { name: "executionRetentionDays", label: "Keep failed executions (days)", type: "number" },
      {
        name: "healthHistoryDays",
        label: "Keep health history (days)",
        hint: "1 to 30. Every health check of the main and every Worker's calls, for the charts and what agents read about past outages.",
        type: "number",
      },
      { name: "autoResolveDays", label: "Auto-resolve after days without failures", type: "number" },
      { name: "backlogThreshold", label: "Queue backlog alert (waiting jobs)", type: "number" },
      { name: "backlogMinutes", label: "Queue backlog alert after (minutes)", type: "number" },
      {
        name: "workflowMapMinutes",
        label: "Refresh workflows and execution counts every (minutes)",
        hint: "For instances with the workflow map. Each refresh reads every workflow and 30 days of executions, so a busy instance needs a longer interval. A change an agent makes through n8n-ops is read at once.",
        type: "number",
      },
      {
        name: "instanceCheckHours",
        label: "Check the n8n version and API key every (hours)",
        hint: "Check now on an instance reads them at once.",
        type: "number",
      },
    ],
  },
  security: {
    title: "Sign-in Security",
    description:
      "When a browser session ends and you sign in again. A shorter limit applies to sessions already open; a longer one signs out your other sessions. Agents and tokens are not affected.",
    fields: [
      {
        name: "idleTimeout",
        label: "Sign out after inactivity",
        hint: "Typing, clicking, scrolling with the wheel and touching count as activity; pages that refresh by themselves do not. A minute before, the page asks whether you are still there.",
        type: "switch",
      },
      {
        name: "idleMinutes",
        label: "Inactivity limit (minutes)",
        type: "number",
        needs: "idleTimeout",
      },
      {
        name: "maxHours",
        label: "Longest session (hours)",
        hint: "Counted from sign-in, whatever the activity. Five minutes before, the page says so.",
        type: "number",
      },
      {
        name: "lifetimeHours",
        label: "Sign out an unused session after (hours)",
        hint: "A session no page has used for this long ends, such as after the browser was closed.",
        type: "number",
      },
    ],
  },
  agents: {
    title: "Agent Connections",
    description:
      "Whether agents may connect by approval, and how long a connection lasts without use. See and disconnect them under Connected Agents.",
    fields: [
      {
        name: "enabled",
        label: "Agents can connect",
        hint: "MCP clients and the n8n-ops skill connect after you approve them in this browser. Turning it off disconnects every agent at once; they must be approved again.",
        type: "switch",
      },
      {
        name: "idleDays",
        label: "Disconnect an unused agent after (days)",
        hint: "Counted from its last call. A shorter value applies at once; a longer one does not bring back agents already disconnected.",
        type: "number",
        needs: "enabled",
      },
    ],
  },
  access: {
    title: "Agent Access",
    description:
      "Agents allowed to request access ask for an instance, scopes and time; a person approves each request. Which instances and scopes are open is set on each instance.",
    fields: [
      {
        name: "maxMinutes",
        label: "Longest access (minutes)",
        type: "number",
        hint: "Requests for longer are refused.",
      },
      {
        name: "pendingMinutes",
        label: "A request waits for a decision (minutes)",
        type: "number",
        hint: "Then it expires.",
      },
      {
        name: "notifyTelegram",
        label: "Send requests to Telegram",
        hint: "With Approve and Deny buttons, to the chat set under Telegram.",
        type: "switch",
      },
      {
        name: "notifyEmail",
        label: "Email requests",
        hint: "To the recipients set under Email Reports, with a link to decide here.",
        type: "switch",
      },
      {
        name: "defaultNotify",
        label: "Default channels",
        hint: "Where a request goes when the agent does not choose one, or chooses one that is off. Only channels turned on above are used. Every request also shows here.",
        type: "channels",
      },
      {
        name: "telegramApprovers",
        label: "Who may approve in Telegram",
        hint: "Telegram user IDs or @usernames; press Enter after each. Empty: only you, when the chat is a private chat with you; nobody in a group.",
        placeholder: "123456789 or @name",
        type: "list",
        needs: "notifyTelegram",
      },
    ],
  },
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const sectionDescriptions: Record<string, string> = {
  keys: "Keys that protect backups and the secrets n8n-ops stores.",
  database:
    "How much room the n8n-ops database takes, and compacting a table to give free space inside it back to the disk.",
  destinations:
    "Where encrypted backups are written: S3, a folder on this server, SFTP or WebDAV. Each keeps its own retention. Instances use the default destinations unless they choose others.",
}

let lastSection = "general"

const draftOf = (section: string) => (section === "destinations" ? "backup-settings" : `settings-${section}`)
const sectionKeys: string[] = settingsGroups.flatMap((g) => g.items.map(([k]) => k))

export function SettingsPage() {
  const { section } = useParams()
  const navigate = useNavigate()
  const unsaved = useUnsavedIds()
  const label = section ? settingsSectionLabel(section) : undefined
  useCrumb(label)
  if (section === "storage") return <Navigate to="/settings/destinations" replace />
  if (!section || !label) return <Navigate to={`/settings/${lastSection}`} replace />
  lastSection = section
  const holds = (k: string) => unsaved.has(draftOf(k))
  const mounted = [section, ...sectionKeys.filter((k) => k !== section && holds(k))]
  return (
    <Page title="Settings" description="How n8n-ops reaches you, where backups go, and who may use its API.">
      <div className="grid items-start gap-gap min-[1024px]:grid-cols-[212px_minmax(0,1fr)] min-[1024px]:gap-7">
        <label className="sticky top-0 z-20 -mt-1 bg-bg py-2 min-[1024px]:hidden">
          <span className="sr-only">Settings category</span>
          <span className="relative block">
            <select
              value={section}
              onChange={(e) => navigate(`/settings/${e.target.value}`)}
              className="h-ctl w-full appearance-none rounded-sm border border-input bg-bg ps-3 pe-9 font-semibold text-ink outline-none focus:border-primary"
            >
              {settingsGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map(([k, l]) => (
                    <option key={k} value={k}>
                      {holds(k) ? `${l} (unsaved)` : l}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </span>
        </label>
        <nav aria-label="Settings categories" className="sticky top-0 hidden flex-col gap-0.5 min-[1024px]:flex">
          {settingsGroups.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <div className="px-2.5 pt-2.5 pb-1 text-meta font-bold tracking-caps text-muted-foreground uppercase">
                {g.label}
              </div>
              {g.items.map(([k, l]) => (
                <NavLink
                  key={k}
                  to={`/settings/${k}`}
                  aria-current={section === k ? "true" : undefined}
                  className="flex items-center rounded-sm px-2.5 py-1.5 font-medium text-ink aria-[current=true]:bg-primary aria-[current=true]:font-title aria-[current=true]:text-primary-foreground regular:gap-2.5 regular:aria-[current=true]:bg-fill regular:aria-[current=true]:text-ink regular:aria-[current=true]:font-semibold [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:aria-[current=true]:hover:bg-primary regular:[@media(hover:hover)]:aria-[current=true]:hover:bg-fill"
                >
                  <SectionIcon section={k} />
                  {l}
                  {holds(k) && (
                    <span
                      role="img"
                      aria-label="Unsaved changes"
                      title="Unsaved changes"
                      className="ms-auto size-[7px] shrink-0 rounded-full bg-info"
                    />
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="grid min-w-0 max-w-3xl gap-gap regular:content-start regular:gap-0 regular:self-start regular:overflow-hidden regular:rounded-lg regular:bg-panel regular:shadow-card regular:ring-1 regular:ring-ink/10 regular:[&>section]:rounded-none regular:[&>section]:shadow-none regular:[&>section]:ring-0 regular:[&>section+section]:border-t regular:[&>section+section]:border-line">
          <div
            data-slot="settings-head"
            className="grid gap-1.5 regular:gap-1 regular:px-pad-x regular:pt-6 regular:pb-2"
          >
            <h2 className="text-figure font-heavy tracking-tighter regular:text-head regular:font-semibold regular:tracking-normal">
              {label}
            </h2>
            <p className="max-w-[75ch] text-muted-foreground">
              {forms[section]?.description ?? sectionDescriptions[section]}
            </p>
          </div>
          {mounted.map((k) =>
            k in forms ? (
              <SettingsForm key={k} section={k} active={k === section} />
            ) : k === "destinations" ? (
              <DestinationsSection key={k} hidden={k !== section} />
            ) : k === "database" ? (
              <DatabaseSection key={k} hidden={k !== section} />
            ) : k === "keys" ? (
              <KeysCard key={k} />
            ) : null,
          )}
        </div>
      </div>
    </Page>
  )
}

export function SettingRow({
  htmlFor,
  label,
  hint,
  children,
  wide,
  inline,
  changed,
  note,
  action,
  problem,
  off,
}: {
  htmlFor?: string
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  wide?: boolean
  inline?: boolean
  changed?: boolean
  note?: React.ReactNode
  action?: React.ReactNode
  problem?: string
  off?: string
}) {
  const head = (
    <>
      {htmlFor && !inline ? (
        <label htmlFor={htmlFor} className="font-semibold">
          {label}
        </label>
      ) : (
        <span className={cn("font-semibold", !changed && "block")}>{label}</span>
      )}
      {changed && (
        <Badge variant="info" title="Differs from the default" className="ms-2 align-[0.1em]">
          Changed
        </Badge>
      )}
      {hint && <span className="mt-0.5 block text-small text-muted-foreground">{hint}</span>}
    </>
  )
  const text = (
    <div className="min-w-0">
      {off ? <div className="opacity-50">{head}</div> : head}
      {note && <span className="mt-0.5 block text-small text-muted-foreground">{note}</span>}
      {off && <span className="mt-0.5 block text-small text-muted-foreground">{off}</span>}
      {action && !off && !inline && <span className="mt-1 block">{action}</span>}
    </div>
  )
  if (inline)
    return (
      <div data-setting-row className="border-t border-line regular:border-t-0">
        <label
          htmlFor={htmlFor}
          className={cn(
            "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 px-pad-x py-3 regular:py-4",
            action && "pb-1 regular:pb-1",
          )}
        >
          {text}
          {children}
        </label>
        {action && <div className="px-pad-x pb-3 regular:pb-4">{action}</div>}
      </div>
    )
  return (
    <div
      data-setting-row
      className={cn(
        "grid items-center gap-x-6 gap-y-2 border-t border-line px-pad-x py-3 regular:border-t-0 regular:py-4",
        !wide && "md:grid-cols-[minmax(0,1fr)_260px]",
      )}
    >
      {text}
      <div
        inert={off ? true : undefined}
        aria-disabled={off ? true : undefined}
        className={cn("flex min-w-0 items-center gap-2", !wide && "md:justify-end", off && "opacity-50")}
      >
        {children}
      </div>
      {problem && (
        <p id={htmlFor ? problemId(htmlFor) : undefined} className="text-small font-medium text-fail md:col-span-2">
          {problem}
        </p>
      )}
    </div>
  )
}

const problemId = (field: string) => `${field}-problem`

function RowAction({ children, onClick, clear }: { children: React.ReactNode; onClick: () => void; clear?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-small font-semibold",
        clear ? "text-muted-foreground [@media(hover:hover)]:hover:text-fail" : "text-info hover:underline",
      )}
    >
      {children}
    </button>
  )
}

function useRevealField(ready: boolean) {
  const location = useLocation()
  const navigate = useNavigate()
  const field = (location.state as { focusField?: string } | null)?.focusField
  useEffect(() => {
    if (!field || !ready) return
    return whenDrawn(
      () => document.getElementById(field),
      (el) => {
        const row = el.closest<HTMLElement>("[data-setting-row]") ?? el
        row.scrollIntoView({ block: "center" })
        el.focus({ preventScroll: true })
        flash(row)
        navigate(".", { replace: true, state: null })
      },
    )
  }, [field, ready, navigate])
}

type Meta = {
  defaults?: Record<string, unknown>
  limits?: Record<string, NumberLimits>
  env?: Record<string, { variable: string; value: string; inUse: boolean; locked?: boolean }>
}
const metaOf = (data: Record<string, unknown> | undefined) => (data?.meta ?? {}) as Meta

export const toForm = (def: { fields: FieldDef[] }, data: Record<string, unknown>) =>
  Object.fromEntries(
    def.fields.map((f) => {
      const v = data[f.name]
      if (f.type === "password") return [f.name, undefined]
      if (f.type === "list" || f.type === "channels") return [f.name, Array.isArray(v) ? v.map(String) : []]
      if (f.type === "switch") return [f.name, Boolean(v)]
      if (f.type === "routes") return [f.name, routesToForm(v)]
      if (metaOf(data).env?.[f.name]?.inUse) return [f.name, ""]
      return [f.name, v ?? ""]
    }),
  ) as Record<string, unknown>

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())

export function withPending(values: Record<string, unknown>, pending: Record<string, string>) {
  const out = { ...values }
  for (const [name, typed] of Object.entries(pending))
    if (typed.trim()) out[name] = addEntries(Array.isArray(values[name]) ? (values[name] as string[]) : [], typed)
  return out
}

export function changeCount(
  def: { fields: FieldDef[] },
  values: Record<string, unknown>,
  initial: Record<string, unknown>,
) {
  const plain = def.fields.filter((f) => f.type !== "password").map((f) => f.name)
  const secrets = def.fields.filter((f) => f.type === "password").map((f) => f.name)
  return (
    countChanges(values, initial, plain) +
    secrets.filter((k) => values[k] !== initial[k] && values[k] !== undefined && values[k] !== "").length
  )
}

const fieldChanged = (values: Record<string, unknown>, initial: Record<string, unknown>, name: string) =>
  text(values[name]) !== text(initial[name])

export function fieldProblem(
  section: string,
  f: FieldDef,
  value: unknown,
  limits: Record<string, NumberLimits> = {},
): string | null {
  if (f.type === "number") return numberProblem(value, limits[f.name] ?? {})
  if (f.type === "topic") return topicProblem(value)
  if (f.type === "routes") return routesProblem(value)?.message ?? null
  const kind = settingKinds[section]?.[f.name]
  return kind ? valueProblem(kind, value) : null
}

export function differsFromDefault(f: FieldDef, value: unknown, fallback: unknown) {
  if (f.type === "number") return text(value) === "" || Number(value) !== Number(fallback)
  if (f.type === "switch") return Boolean(value) !== Boolean(fallback)
  if (f.type === "timezone") return (text(value) || "UTC") !== (text(fallback) || "UTC")
  return text(value) !== text(fallback)
}

export function defaultText(f: FieldDef, fallback: unknown) {
  if (f.type === "switch") return fallback ? "On" : "Off"
  if (f.type === "weekday") return weekdays[Number(fallback)] ?? String(fallback)
  if (f.type === "design") return text(fallback).charAt(0).toUpperCase() + text(fallback).slice(1)
  if (f.type === "date-format" && isDateFormat(fallback)) return dateFormatLabels[fallback]
  if (f.type === "time-format" && isTimeFormat(fallback)) return timeFormatLabels[fallback]
  return text(fallback) || "(empty)"
}

export function formatExample(f: FieldDef, values: Record<string, unknown>): React.ReactNode {
  if (f.type !== "date-format" && f.type !== "time-format") return undefined
  const draft = writingOf({
    timezone: text(values.timezone),
    dateFormat: text(values.dateFormat),
    timeFormat: text(values.timeFormat),
  })
  const now = new Date()
  return (
    <span aria-live="polite">
      Example: {f.type === "date-format" ? formatDay(now, draft) : formatClock(now, draft)}
    </span>
  )
}

const resettable = (f: FieldDef, fallback: unknown) =>
  fallback !== undefined &&
  fallback !== "" &&
  !Array.isArray(fallback) &&
  !f.clear &&
  f.type !== "password" &&
  f.type !== "list"

export const smtpServerChanged = (stored: Record<string, unknown>, next: Record<string, unknown>) => {
  const account = (v: Record<string, unknown>) =>
    JSON.stringify([
      String(v.smtpHost ?? "")
        .trim()
        .toLowerCase(),
      Number(v.smtpPort ?? 0),
      String(v.smtpUser ?? "").trim(),
      Boolean(v.smtpSecure),
      Boolean(v.smtpAllowUnencrypted),
    ])
  return account(stored) !== account(next)
}

export const lockedNote = (variable: string) => `Set by ${variable}.`

export function SettingsForm({ section, active = true }: { section: string; active?: boolean }) {
  const def = forms[section]
  const navigate = useNavigate()
  const query = useApi<Record<string, unknown>>(`/settings/${section}`)
  useRevealField(!query.isLoading && active)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Record<string, string>>({})
  const [secretsSaved, secretSaved] = useReducer((n: number) => n + 1, 0)
  const shown = useRef(active)
  shown.current = active
  const save = useApiMutation<Record<string, unknown>, { signedOut?: boolean }>("PUT", `/settings/${section}`, {
    invalidate: [`/settings/${section}`, "/setup/checklist"],
    quiet: true,
  })
  const meta = metaOf(query.data)
  const differs = (a: unknown, b: unknown, name: string) =>
    def?.fields.some((f) => f.name === name && f.type === "password") ? a !== b : text(a) !== text(b)
  const form = useEdits(query.data && def ? toForm(def, query.data) : undefined, query.dataUpdatedAt, differs)
  const { values, stored: initial } = form
  const current = withPending(values, pending)
  const count = query.data && def ? changeCount(def, current, initial) : 0

  const offOf = (f: FieldDef) => (f.needs && !values[f.needs] ? f.needs : null)

  function body() {
    const out: Record<string, unknown> = {}
    for (const f of def?.fields ?? []) {
      const v = current[f.name]
      if (f.type === "password") {
        if (v !== initial[f.name] && (v === null || (typeof v === "string" && v))) out[f.name] = v
        continue
      }
      if (!fieldChanged(current, initial, f.name)) continue
      if (offOf(f) && fieldProblem(section, f, v, meta.limits)) continue
      if (f.type === "number") out[f.name] = Number(v)
      else if (f.type === "topic") out[f.name] = text(v) ? Number(text(v)) : null
      else if (f.type === "routes") out[f.name] = routesFromForm(v)
      else if (f.type === "list") out[f.name] = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []
      else out[f.name] = typeof v === "string" ? v.trim() : v
    }
    return out
  }

  function reveal(name: string) {
    if (!shown.current) navigate(`/settings/${section}`)
    whenDrawn(
      () => {
        const el = document.getElementById(name)
        return el && !el.closest("[hidden]") ? el : null
      },
      (el) => {
        el.closest<HTMLElement>("[data-setting-row]")?.scrollIntoView({ block: "center" })
        el.focus({ preventScroll: true })
      },
    )
  }

  function check(): FieldProblem[] {
    if (!def || !query.data) return []
    const found: Record<string, string> = {}
    for (const f of def.fields) {
      if (f.type === "password" || offOf(f) || !fieldChanged(current, initial, f.name)) continue
      const problem = fieldProblem(section, f, current[f.name], meta.limits)
      if (problem) found[f.name] = problem
    }
    const password = values.smtpPassword
    if (
      section === "email" &&
      query.data.smtpPasswordSet &&
      smtpServerChanged(initial, values) &&
      !(typeof password === "string" && password) &&
      password !== null
    ) {
      found.smtpPassword =
        "the SMTP server, user or encryption changed. Enter the SMTP password again, so the stored one is not sent under them."
      if (password === undefined) form.set("smtpPassword", "")
    }
    setProblems(found)
    return def.fields
      .filter((f) => f.name in found)
      .map((f) => {
        const at = f.type === "routes" ? (routesProblem(current[f.name])?.id ?? f.name) : f.name
        return { label: f.label, problem: found[f.name] ?? "", id: f.name, reveal: () => reveal(at) }
      })
  }

  useSaveSource(`settings-${section}`, {
    label: `the ${def?.title ?? section} settings`,
    saved: "Settings saved",
    count,
    keepsOn: "/settings/",
    check,
    save: async () => {
      const sent = body()
      let answer: { signedOut?: boolean } | undefined
      try {
        answer = await save.mutateAsync(sent)
      } catch (e) {
        if (e instanceof ApiError && e.issues?.length) {
          const names = new Set(def?.fields.map((f) => f.name))
          setProblems(
            Object.fromEntries(
              e.issues.filter((i) => names.has(String(i.path[0]))).map((i) => [String(i.path[0]), i.message]),
            ),
          )
        }
        throw e
      }
      setProblems({})
      const names = def?.fields.filter((f) => f.type !== "password" && f.name in sent).map((f) => f.name) ?? []
      form.saved(Object.fromEntries(names.map((k) => [k, current[k]])))
      setPending({})
      if (def?.fields.some((f) => f.type === "password" && f.name in sent)) secretSaved()
      if (section === "general") afterGeneralSave(sent)
      if (answer?.signedOut) return { note: "Your other sessions were signed out." }
    },
    discard: () => {
      setProblems({})
      setPending({})
      form.discard()
    },
  })
  if (!def) return null
  const set = (name: string, value: unknown) => {
    form.set(name, value)
    setProblems((p) => {
      if (!(name in p)) return p
      const { [name]: _, ...rest } = p
      return rest
    })
  }

  function source(f: FieldDef) {
    const value = values[f.name]
    const env = meta.env?.[f.name]
    if (env?.locked) return { note: lockedNote(env.variable) }
    if (env)
      return {
        note: text(value)
          ? `Replaces ${env.value}, set by ${env.variable}.`
          : `From the environment (${env.variable}).`,
        action: text(value) ? (
          <RowAction onClick={() => set(f.name, "")}>Reset to the environment value</RowAction>
        ) : undefined,
      }
    if (f.clear)
      return {
        action: text(value) ? (
          <RowAction clear onClick={() => set(f.name, "")}>
            Clear
          </RowAction>
        ) : undefined,
      }
    const fallback = meta.defaults?.[f.name]
    if (!resettable(f, fallback) || !differsFromDefault(f, value, fallback)) return {}
    return {
      changed: true,
      action: (
        <RowAction onClick={() => set(f.name, f.type === "number" ? String(fallback) : fallback)}>
          Reset to default ({defaultText(f, fallback)})
        </RowAction>
      ),
    }
  }

  return (
    <Panel hidden={!active}>
      <RefreshLine live={query} />
      {loadView(query) === "failed" ? (
        <LoadError what={def.title} error={query.error} retry={() => query.refetch()} />
      ) : loadView(query) === "loading" ? (
        <Loading>Loading the {def.title} settings…</Loading>
      ) : (
        <fieldset disabled={save.isPending} className="contents">
          {def.fields.map((f) => {
            const problem = problems[f.name]
            const marks = {
              "aria-invalid": problem ? true : undefined,
              "aria-describedby": problem ? problemId(f.name) : undefined,
            }
            const needs = offOf(f)
            const env = meta.env?.[f.name]
            const routeIssue = f.type === "routes" && problem ? routesProblem(values[f.name]) : null
            return (
              <SettingRow
                key={f.name}
                htmlFor={f.type === "routes" || f.type === "channels" ? undefined : f.name}
                label={f.label}
                hint={f.hint}
                inline={f.type === "switch"}
                wide={f.type === "list" || f.type === "routes"}
                problem={routeIssue ? undefined : problem}
                off={needs ? `Used when ${def.fields.find((s) => s.name === needs)?.label ?? needs} is on.` : undefined}
                note={formatExample(f, values)}
                {...source(f)}
              >
                {f.type === "routes" ? (
                  <TopicRoutes
                    id={f.name}
                    value={values[f.name]}
                    onChange={(v) => set(f.name, v)}
                    disabled={save.isPending}
                    issue={routeIssue}
                  />
                ) : f.type === "switch" ? (
                  <Switch
                    id={f.name}
                    checked={Boolean(values[f.name])}
                    disabled={env?.locked}
                    onCheckedChange={(v) => set(f.name, v)}
                  />
                ) : f.type === "password" ? (
                  <SecretField
                    id={f.name}
                    stored={Boolean(query.data?.[`${f.name}Set`])}
                    value={values[f.name] as string | null | undefined}
                    onChange={(v) => set(f.name, v)}
                    invalid={Boolean(problem)}
                    describedBy={marks["aria-describedby"]}
                  />
                ) : f.type === "design" ? (
                  <ToggleGroup
                    type="single"
                    segmented
                    aria-label="Design"
                    value={String(values[f.name] || "regular")}
                    onValueChange={(v) => v && set(f.name, v)}
                  >
                    <ToggleGroupItem value="regular">Regular</ToggleGroupItem>
                    <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
                  </ToggleGroup>
                ) : f.type === "time-format" ? (
                  <ToggleGroup
                    type="single"
                    segmented
                    id={f.name}
                    aria-label={f.label}
                    value={String(values[f.name] || "24h")}
                    onValueChange={(v) => v && set(f.name, v)}
                  >
                    {timeFormats.map((t) => (
                      <ToggleGroupItem key={t} value={t}>
                        {timeFormatLabels[t]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                ) : f.type === "date-format" ? (
                  <FieldPicker
                    id={f.name}
                    label={f.label}
                    value={String(values[f.name] || "browser")}
                    onChange={(v) => set(f.name, v)}
                    disabled={save.isPending}
                    options={dateFormats.map((d) => ({ value: d, label: dateFormatLabels[d] }))}
                  />
                ) : f.type === "timezone" ? (
                  <TimeZonePicker
                    id={f.name}
                    value={String(values[f.name] ?? "")}
                    onChange={(v) => set(f.name, v)}
                    disabled={save.isPending}
                  />
                ) : f.type === "weekday" ? (
                  <FieldPicker
                    id={f.name}
                    label={f.label}
                    value={String(values[f.name] ?? 0)}
                    onChange={(v) => set(f.name, Number(v))}
                    disabled={save.isPending}
                    options={weekdays.map((d, i) => ({ value: String(i), label: d }))}
                  />
                ) : f.type === "channels" ? (
                  <ChannelsInput
                    id={f.name}
                    label={f.label}
                    value={Array.isArray(values[f.name]) ? (values[f.name] as string[]) : []}
                    onChange={(v) => set(f.name, v)}
                    disabled={save.isPending}
                    invalid={Boolean(problem)}
                    describedBy={marks["aria-describedby"]}
                  />
                ) : f.type === "list" ? (
                  <ChipsInput
                    id={f.name}
                    value={Array.isArray(values[f.name]) ? (values[f.name] as string[]) : []}
                    onChange={(v) => set(f.name, v)}
                    pending={pending[f.name] ?? ""}
                    onPendingChange={(typed) => setPending((p) => ({ ...p, [f.name]: typed }))}
                    problem={(entry) => {
                      const kind = settingKinds[section]?.[f.name]
                      return kind ? valueProblem(kind, [entry]) : null
                    }}
                    placeholder={f.placeholder}
                    invalid={Boolean(problem)}
                    describedBy={marks["aria-describedby"]}
                  />
                ) : (
                  <Input
                    id={f.name}
                    type={f.type === "number" ? "number" : "text"}
                    inputMode={f.type === "time" || f.type === "topic" ? "numeric" : undefined}
                    placeholder={f.type === "time" ? "HH:MM" : (env?.value ?? f.placeholder)}
                    value={String(values[f.name] ?? "")}
                    onChange={(e) => set(f.name, e.target.value)}
                    {...marks}
                  />
                )}
              </SettingRow>
            )
          })}
        </fieldset>
      )}
      {query.data && (section === "telegram" || section === "email") && (
        <TestRow section={section} data={query.data} values={current} secretsSaved={secretsSaved} />
      )}
    </Panel>
  )
}

const tests = {
  telegram: {
    path: "/alerts/test/telegram",
    label: "Send test message",
    failed: "Could not send the test message",
    done: () => "Test message sent to the Telegram chat",
  },
  email: {
    path: "/alerts/test/email",
    label: "Send test email",
    failed: "Could not send the test email",
    done: (recipients: string[]) =>
      recipients.length ? `Test email sent to ${recipients.join(", ")}` : "Test email sent",
  },
} as const

const topicGoneText = "The default topic was not found, so the test message went to General"

export function testDraft(section: keyof typeof tests, values: Record<string, unknown>): Record<string, unknown> {
  const secret = (name: string) => {
    const v = values[name]
    return v === null ? { [name]: null } : typeof v === "string" && v ? { [name]: v } : {}
  }
  if (section === "telegram")
    return { chatId: text(values.chatId), defaultThreadId: text(values.defaultThreadId), ...secret("botToken") }
  return {
    recipients: Array.isArray(values.recipients) ? values.recipients : [],
    from: text(values.from),
    smtpHost: text(values.smtpHost),
    smtpPort: Number(values.smtpPort),
    smtpSecure: Boolean(values.smtpSecure),
    smtpAllowUnencrypted: Boolean(values.smtpAllowUnencrypted),
    smtpUser: text(values.smtpUser),
    ...secret("smtpPassword"),
  }
}

export function testIdentity(section: keyof typeof tests, values: Record<string, unknown>, secretsSaved: number) {
  return JSON.stringify({ draft: testDraft(section, values), secretsSaved })
}

type TestOutcome = { at: number } & (
  | { ok: true; recipients: string[]; topicGone: boolean }
  | { ok: false; message: string }
)

type TestView =
  | { kind: "none" }
  | { kind: "testing" }
  | { kind: "accepted"; detail?: string; at: number }
  | { kind: "failed"; message: string; at: number }
  | { kind: "changed" }

export function testView(
  test: { isPending: boolean; data?: TestOutcome; variables?: { identity: string } },
  identity: string,
): TestView {
  const { data } = test
  if (test.isPending) return { kind: "testing" }
  if (!data) return { kind: "none" }
  if (test.variables?.identity !== identity) return { kind: "changed" }
  if (!data.ok) return { kind: "failed", message: data.message, at: data.at }
  const detail = data.topicGone
    ? topicGoneText
    : data.recipients.length
      ? `Sent to ${data.recipients.join(", ")}`
      : undefined
  return { kind: "accepted", detail, at: data.at }
}

export function testMissing(
  section: keyof typeof tests,
  draft: Record<string, unknown>,
  data: Record<string, unknown>,
): string | null {
  if (section === "telegram") {
    const token = typeof draft.botToken === "string" || (Boolean(data.botTokenSet) && draft.botToken !== null)
    return token && draft.chatId ? null : "the bot token and the chat ID"
  }
  return draft.smtpHost && Array.isArray(draft.recipients) && draft.recipients.length
    ? null
    : "the SMTP server and a recipient"
}

function TestRow({
  section,
  data,
  values,
  secretsSaved,
}: {
  section: keyof typeof tests
  data: Record<string, unknown>
  values: Record<string, unknown>
  secretsSaved: number
}) {
  const t = tests[section]
  const w = useTimeFormat()
  const draft = testDraft(section, values)
  const identity = testIdentity(section, values, secretsSaved)
  const missing = testMissing(section, draft, data)
  const latest = useRef(identity)
  latest.current = identity
  const test = useMutation({
    networkMode: "always",
    mutationFn: async (sent: { identity: string; draft: Record<string, unknown> }): Promise<TestOutcome> => {
      try {
        const res = await api<{ recipients?: string[]; topicNotFound?: boolean } | null>(t.path, {
          method: "POST",
          json: sent.draft,
        })
        return {
          ok: true,
          recipients: res?.recipients ?? [],
          topicGone: Boolean(res?.topicNotFound),
          at: Date.now(),
        }
      } catch (e) {
        return { ok: false, message: describeError(e), at: Date.now() }
      }
    },
  })
  async function run() {
    const unchanged = () => latest.current === identity
    const outcome = await test.mutateAsync(
      { identity, draft },
      {
        onSuccess: (outcome) => {
          if (!unchanged()) return
          if (!outcome.ok) toast.error(`${t.failed}: ${outcome.message}`)
          else if (outcome.topicGone) toast.warning(`${topicGoneText}.`)
          else toast.success(t.done(outcome.recipients))
        },
      },
    )
    if (!outcome.ok && unchanged()) throw new Error(outcome.message)
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-pad-x py-3">
      <BusyButton
        run={run}
        busyLabel="Sending…"
        disabled={missing !== null}
        title={missing ? `Add ${missing} first` : undefined}
      >
        {t.label}
      </BusyButton>
      <div role="status" className="min-w-0 flex-1 text-small">
        {missing ? (
          <span className="text-muted-foreground">Add {missing} first.</span>
        ) : (
          <TestResult view={testView(test, identity)} dates={w} />
        )}
      </div>
    </div>
  )
}

function TestResult({ view, dates }: { view: TestView; dates: DateWriting }) {
  if (view.kind === "accepted" || view.kind === "failed")
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={view.kind === "accepted" ? "ok" : "fail"}>
          {view.kind === "accepted" ? "Accepted" : "Failed"}
        </Badge>
        {view.kind === "accepted" ? view.detail && <span>{view.detail}</span> : <span>{view.message}</span>}
        <span className="text-muted-foreground">Checked {formatListTime(view.at, dates)}</span>
      </span>
    )
  return (
    <span className="text-muted-foreground">
      {view.kind === "testing"
        ? "Testing the values on screen…"
        : view.kind === "changed"
          ? "Changed since the last test. Send a test again."
          : "Tests the values on screen, without saving them."}
    </span>
  )
}

function KeysCard() {
  const w = useTimeFormat()
  const keys = useApi<{ backupRecipient: string | null; privateKeySavedAt: string | null }>("/admin/keys")
  const [rotate, setRotate] = useState(false)
  const [privateKey, setPrivateKey] = useState("")
  async function generate() {
    try {
      const res = await api<{ privateKey: string }>("/admin/keys/backup", { method: "POST" })
      setPrivateKey(res.privateKey)
      await keys.refetch()
    } catch (e) {
      toast.error(`Could not generate a key pair: ${describeError(e)}`)
      throw e
    }
  }
  async function confirm() {
    try {
      await api("/admin/keys/backup/confirm", { method: "POST" })
      setPrivateKey("")
      setRotate(false)
      await keys.refetch()
      toast.success("New backup key in use")
    } catch (e) {
      toast.error(`Could not confirm the key: ${describeError(e)}`)
      throw e
    }
  }
  async function downloadAppKey() {
    try {
      download("n8n-ops-app.key", await api<string>("/admin/keys/app"))
    } catch (e) {
      toast.error(`Could not download the key: ${describeError(e)}`)
      throw e
    }
  }
  return (
    <Panel>
      <RefreshLine live={keys} />
      {loadView(keys) === "failed" ? (
        <LoadError what="the keys" error={keys.error} retry={() => keys.refetch()} />
      ) : (
        <>
          <SettingRow
            label="Backup public key"
            hint="Archives are encrypted with this. Only the public half is on the server."
            wide
          >
            {keys.data?.backupRecipient ? (
              <Command value={keys.data.backupRecipient} label="Copy the public key" />
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </SettingRow>
          <SettingRow label="Private key" hint="Shown once when generated. You need it to restore.">
            {keys.data?.privateKeySavedAt ? (
              <span className="flex items-center gap-2 font-semibold text-ok">
                <ShieldCheck className="size-4" />
                Saved, {formatTime(keys.data.privateKeySavedAt, w, { seconds: false })}
              </span>
            ) : (
              <span className="font-semibold text-warn">Not confirmed</span>
            )}
          </SettingRow>
          <SettingRow label="Rotate" hint="Old archives still need the old private key.">
            <Button onClick={() => setRotate(true)}>
              <KeyRound /> Generate new key pair
            </Button>
          </SettingRow>
          <SettingRow
            label="App secrets key"
            hint="Encrypts the API keys, tokens and passwords stored by n8n-ops. Kept in the server's data directory. Keep a copy: without it, stored secrets cannot be read after a restore."
          >
            <BusyButton icon={Download} busyLabel="Downloading…" run={downloadAppKey}>
              Download a copy
            </BusyButton>
          </SettingRow>
        </>
      )}
      <Dialog
        open={rotate}
        onOpenChange={(o) => {
          setRotate(o)
          if (!o) setPrivateKey("")
        }}
      >
        <DialogContent keepOnBackdrop>
          <DialogHeader icon={KeyRound}>
            <DialogTitle>New Backup Key Pair</DialogTitle>
            <DialogDescription>
              {privateKey
                ? "The new key is in use now. Save its private key: it is shown only once. Archives made before still need the old private key, so keep that too."
                : "The new key replaces the current one as soon as it is generated, and its private key is shown only once. Archives made before still need the old private key, so keep that too."}
            </DialogDescription>
          </DialogHeader>
          {privateKey ? (
            <div className="grid gap-3">
              <pre className="overflow-x-auto rounded-sm bg-fill p-3 font-mono text-small whitespace-pre-wrap break-all">
                {privateKey}
              </pre>
              <Button
                className="justify-self-start"
                onClick={() => download("n8n-ops-backup-key.txt", `${privateKey}\n`)}
              >
                <Download /> Download key file
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            {privateKey ? (
              <BusyButton key="confirm" variant="primary" busyLabel="Confirming…" run={confirm}>
                I saved it
              </BusyButton>
            ) : (
              <>
                <Button onClick={() => setRotate(false)}>Cancel</Button>
                <BusyButton key="generate" variant="primary" busyLabel="Generating…" run={generate}>
                  Generate
                </BusyButton>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
