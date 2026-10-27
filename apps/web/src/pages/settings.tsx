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
import { ChevronDown, Download, KeyRound, ShieldCheck } from "lucide-react"
import { useEffect, useReducer, useRef, useState } from "react"
import { Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { afterGeneralSave } from "@/app/design-sync"
import { settingsGroups, settingsSectionLabel } from "@/app/settings-sections"
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
import { addEntries } from "@/lib/entries"
import { loadView } from "@/lib/load-state"
import { flash, whenDrawn } from "@/lib/reveal"
import { createTestRuns, type TestOutcome, type TestView } from "@/lib/test-run"
import { type DateWriting, formatClock, formatDay, formatListTime, formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { DestinationsSection } from "@/pages/destinations"
import { routesFromForm, routesProblem, routesToForm, TopicRoutes } from "@/pages/topic-routes"

/** What the two designs are; the same words in both apps. */
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
    | "weekday"
    | "design"
    | "timezone"
    | "date-format"
    | "time-format"
    | "topic"
    | "routes"
  placeholder?: string
  /** The switch this field only matters with: while it is off, the field stays in place, greyed out (FS-4). */
  needs?: string
  /** An address or a server: it gets Clear instead of Changed and Reset to default (FS-6). */
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
        hint: "Used in links sent by Telegram and email, for example https://ops.example.com.",
        placeholder: "https://ops.example.com",
        clear: true,
      },
      {
        name: "timezone",
        label: "Time zone",
        hint: "For report and backup schedules and every time shown here. Search by city, region or offset.",
        type: "timezone",
      },
      // How every date and time is written, here and in emails (FW-9, EM-6); numbers only, never month names.
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
    ],
  },
  alerts: {
    title: "Alerts",
    description: "What reaches Telegram and how messages are grouped. Everything else stays in the UI and reports.",
    fields: [
      { name: "newProblem", label: "New problem", type: "switch" },
      { name: "regression", label: "Regression", hint: "A resolved problem fails again.", type: "switch" },
      { name: "health", label: "Instance or queue worker down, queue backlog", type: "switch" },
      { name: "backup", label: "Backup failed or stale", type: "switch" },
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
    title: "Email reports",
    description:
      "Daily and weekly summaries: open problems, top failing workflows, health incidents, backups, versions.",
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
      { name: "smtpUser", label: "SMTP user", clear: true },
      { name: "smtpPassword", label: "SMTP password", type: "password" },
    ],
  },
  defaults: {
    title: "Instance defaults",
    description: "Used by every instance unless it has an override.",
    fields: [
      { name: "pollIntervalSec", label: "Check for failures every (seconds)", type: "number" },
      { name: "healthIntervalSec", label: "Health check every (seconds)", type: "number" },
      { name: "backupTime", label: "Daily backup time", type: "time" },
      { name: "staleBackupHours", label: "Backup is stale after (hours)", type: "number" },
      { name: "executionRetentionDays", label: "Keep failed executions (days)", type: "number" },
      { name: "autoResolveDays", label: "Auto-resolve after days without failures", type: "number" },
      { name: "backlogThreshold", label: "Queue backlog alert (waiting jobs)", type: "number" },
      { name: "backlogMinutes", label: "for longer than (minutes)", type: "number" },
    ],
  },
  security: {
    title: "Sign-in security",
    description:
      "When a browser session ends and you sign in again. Each limit applies to sessions already open. Agents and API tokens are not affected.",
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
  access: {
    title: "Agent access",
    description:
      "Agents with a token that may request access ask for an instance, scopes and time; a person approves each request. Which instances and scopes are open is set on each instance.",
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

/** What each section is for, under its title. Forms take theirs from their definition. */
const sectionDescriptions: Record<string, string> = {
  keys: "Keys that protect backups and the secrets n8n-ops stores.",
  destinations:
    "Where encrypted backups are written: S3, a folder on this server, SFTP or WebDAV. Each keeps its own retention. Instances use the default destinations unless they choose others.",
}

/** The section last open, so Settings reopens where it was left during this visit (NL-4). */
let lastSection = "general"

/** The save bar area that holds a section's unsaved changes. */
const draftOf = (section: string) => (section === "destinations" ? "backup-settings" : `settings-${section}`)
const sectionKeys: string[] = settingsGroups.flatMap((g) => g.items.map(([k]) => k))

export function SettingsPage() {
  const { section } = useParams()
  const navigate = useNavigate()
  const unsaved = useUnsavedIds()
  const label = section ? settingsSectionLabel(section) : undefined
  useCrumb(label)
  // Backup Storage became Backup Destinations; links to the old section still arrive.
  if (section === "storage") return <Navigate to="/settings/destinations" replace />
  if (!section || !label) return <Navigate to={`/settings/${lastSection}`} replace />
  lastSection = section
  const holds = (k: string) => unsaved.has(draftOf(k))
  // Changes are kept across the sections (SV-1): a section that holds some stays mounted, out of sight, after
  // the one shown, so the shown one is drawn as before.
  const mounted = [section, ...sectionKeys.filter((k) => k !== section && holds(k))]
  return (
    <Page title="Settings" description="How n8n-ops reaches you, where backups go, and who may use its API.">
      <div className="grid items-start gap-gap min-[1024px]:grid-cols-[212px_minmax(0,1fr)] min-[1024px]:gap-7">
        {/* Below 1024px the section list is one sticky picker (FS-10). */}
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
                  {/* A section holding unsaved changes is marked (SV-1). */}
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
        {/*
         * Regular draws the section as one card with its title inside (#29); the forms in it lose their own
         * card and the rows their lines.
         */}
        <div className="grid min-w-0 max-w-3xl gap-gap regular:content-start regular:gap-0 regular:self-start regular:overflow-hidden regular:rounded-lg regular:bg-panel regular:shadow-card regular:ring-1 regular:ring-ink/10 regular:[&>section]:rounded-none regular:[&>section]:shadow-none regular:[&>section]:ring-0 regular:[&>section+section]:border-t regular:[&>section+section]:border-line">
          {/* Each section opens with a large title and one paragraph about what it is for (FS-8). */}
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
            ) : k === "keys" ? (
              <KeysCard key={k} />
            ) : null,
          )}
        </div>
      </div>
    </Page>
  )
}

/**
 * A settings row: the label and its explanation at the start, the control at the end. A wide control takes
 * its own line under the label and starts at the start of it, like the text.
 */
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
  /** The control takes a full line under the label (long values). */
  wide?: boolean
  /** A switch: the whole row is its label, and it stays at the end of the row, also on a phone (FS-1). */
  inline?: boolean
  /** The value differs from its default: a Changed mark beside the label (FS-6). */
  changed?: boolean
  /** Where the value comes from, such as the environment, under the explanation (FS-6). */
  note?: React.ReactNode
  /** Reset to default or Clear, under the explanation (FS-6). */
  action?: React.ReactNode
  /** What is wrong with the value, under the row; the control is marked with it (SV-1). */
  problem?: string
  /** Why the field does nothing now: it stays in place, greyed out and out of reach (FS-4). */
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
      {/* A switch row draws its action once, outside its label (below). */}
      {action && !off && !inline && <span className="mt-1 block">{action}</span>}
    </div>
  )
  if (inline)
    return (
      // The action sits outside the label, so pressing it never flips the switch.
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
        // Says to tools what inert already does: the field is inactive, so its dimmed label is exempt from contrast.
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

/** The id of the note that says what is wrong with a field, for its `aria-describedby`. */
const problemId = (field: string) => `${field}-problem`

/** A small text button under a setting's explanation: Reset to default in the info colour, or Clear (FS-6). */
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

/**
 * A setting chosen in the search: once its section has drawn, its row comes into view, its field takes the
 * focus and the row flashes for a moment (SR-6). The request is then cleared, so a reload does not repeat it.
 */
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

/** What a section's answer carries beside its values: defaults, number ranges, values from the environment. */
type Meta = {
  defaults?: Record<string, unknown>
  limits?: Record<string, NumberLimits>
  env?: Record<string, { variable: string; value: string; inUse: boolean }>
}
const metaOf = (data: Record<string, unknown> | undefined) => (data?.meta ?? {}) as Meta

/**
 * Form values as loaded. A secret is `undefined` until the user replaces or removes it, and then not sent. A value
 * the environment provides while none is stored shows as empty, so no save stores it (FS-6).
 */
export const toForm = (def: { fields: FieldDef[] }, data: Record<string, unknown>) =>
  Object.fromEntries(
    def.fields.map((f) => {
      const v = data[f.name]
      if (f.type === "password") return [f.name, undefined]
      if (f.type === "list") return [f.name, Array.isArray(v) ? v.map(String) : []]
      if (f.type === "switch") return [f.name, Boolean(v)]
      if (f.type === "routes") return [f.name, routesToForm(v)]
      if (metaOf(data).env?.[f.name]?.inUse) return [f.name, ""]
      return [f.name, v ?? ""]
    }),
  ) as Record<string, unknown>

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())

/**
 * The form's values with what is typed in a list's Add field and not yet a chip, as leaving the field would add
 * it. The save bar counts, checks and saves these, so typed text alone is a change (SV-1).
 */
export function withPending(values: Record<string, unknown>, pending: Record<string, string>) {
  const out = { ...values }
  for (const [name, typed] of Object.entries(pending))
    if (typed.trim()) out[name] = addEntries(Array.isArray(values[name]) ? (values[name] as string[]) : [], typed)
  return out
}

/** How many fields differ from how they were loaded (SV-1); a secret counts while it is replaced or removed. */
export function changeCount(
  def: { fields: FieldDef[] },
  values: Record<string, unknown>,
  initial: Record<string, unknown>,
) {
  const plain = def.fields.filter((f) => f.type !== "password").map((f) => f.name)
  const secrets = def.fields.filter((f) => f.type === "password").map((f) => f.name)
  return (
    countChanges(values, initial, plain) + secrets.filter((k) => values[k] !== undefined && values[k] !== "").length
  )
}

/** Whether a field differs from how it was loaded, compared as the save bar counts it (SV-2). */
const fieldChanged = (values: Record<string, unknown>, initial: Record<string, unknown>, name: string) =>
  text(values[name]) !== text(initial[name])

/** What is wrong with a field's value, in words that follow its label; null when it is fine (SV-1, SV-12). */
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

/** Whether a value differs from its default: numbers as numbers, an empty time zone as UTC (FS-6). */
export function differsFromDefault(f: FieldDef, value: unknown, fallback: unknown) {
  if (f.type === "number") return text(value) === "" || Number(value) !== Number(fallback)
  if (f.type === "switch") return Boolean(value) !== Boolean(fallback)
  if (f.type === "timezone") return (text(value) || "UTC") !== (text(fallback) || "UTC")
  return text(value) !== text(fallback)
}

/** The default as Reset names it: "60", "On", "Sunday", "Regular", "24-hour" (FS-6). */
export function defaultText(f: FieldDef, fallback: unknown) {
  if (f.type === "switch") return fallback ? "On" : "Off"
  if (f.type === "weekday") return weekdays[Number(fallback)] ?? String(fallback)
  if (f.type === "design") return text(fallback).charAt(0).toUpperCase() + text(fallback).slice(1)
  if (f.type === "date-format" && isDateFormat(fallback)) return dateFormatLabels[fallback]
  if (f.type === "time-format" && isTimeFormat(fallback)) return timeFormatLabels[fallback]
  return text(fallback) || "(empty)"
}

/**
 * Under Date format and Time format: now, written as the form's choices and time zone write it, before they are
 * saved (FW-9). Polite, so a screen reader hears the new example after a change; it is not redrawn on a timer,
 * which would announce it again and again.
 */
export function formatExample(f: FieldDef, values: Record<string, unknown>): React.ReactNode {
  if (f.type !== "date-format" && f.type !== "time-format") return undefined
  const draft = writingOf({
    timezone: text(values.timezone),
    dateFormat: text(values.dateFormat),
    timeFormat: text(values.timeFormat),
  })
  const now = new Date()
  return (
    <span aria-live="polite" className="tabular-nums">
      Example: {f.type === "date-format" ? formatDay(now, draft) : formatClock(now, draft)}
    </span>
  )
}

/** Settings with a default worth naming get Changed and Reset; secrets, lists and addresses do not (FS-6). */
const resettable = (f: FieldDef, fallback: unknown) =>
  fallback !== undefined &&
  fallback !== "" &&
  !Array.isArray(fallback) &&
  !f.clear &&
  f.type !== "password" &&
  f.type !== "list"

/**
 * Whether the SMTP host, port or user really differs from the stored one: case and spaces in the host, spaces
 * in the user and "587" against 587 do not count. The server checks the same.
 */
export const smtpServerChanged = (stored: Record<string, unknown>, next: Record<string, unknown>) => {
  const account = (v: Record<string, unknown>) =>
    JSON.stringify([
      String(v.smtpHost ?? "")
        .trim()
        .toLowerCase(),
      Number(v.smtpPort ?? 0),
      String(v.smtpUser ?? "").trim(),
    ])
  return account(stored) !== account(next)
}

/**
 * One section's form. It stays mounted while another section shows and it holds unsaved changes, so they are kept
 * across the sections and one save bar saves them all (SV-1); `active` is false while it is out of sight. Before
 * a save its changed fields are checked; a field that fails is marked and named, and nothing is sent.
 */
export function SettingsForm({ section, active = true }: { section: string; active?: boolean }) {
  const def = forms[section]
  const navigate = useNavigate()
  const query = useApi<Record<string, unknown>>(`/settings/${section}`)
  useRevealField(!query.isLoading && active)
  const [values, setValues] = useState<Record<string, unknown>>({})
  // Fields that failed their check, with what is wrong (SV-1); editing a field, Discard or a save clears its mark.
  const [problems, setProblems] = useState<Record<string, string>>({})
  // What is typed in a list's Add field and not yet a chip, by field: a change of its own (SV-1).
  const [pending, setPending] = useState<Record<string, string>>({})
  // Moves on with each save that stored or removed a secret, so a test of the one before no longer counts (SV-5).
  const [secretsSaved, secretSaved] = useReducer((n: number) => n + 1, 0)
  const shown = useRef(active)
  shown.current = active
  // The save bar says what failed, naming the section (SV-3).
  const save = useApiMutation<Record<string, unknown>>("PUT", `/settings/${section}`, {
    invalidate: [`/settings/${section}`, "/setup/checklist"],
    quiet: true,
  })
  const meta = metaOf(query.data)
  const initial = query.data && def ? toForm(def, query.data) : {}
  // What Save would send: the values with the typed text that is not yet a chip.
  const current = withPending(values, pending)
  const count = query.data && def ? changeCount(def, current, initial) : 0
  // A refresh never overwrites what the user is typing (SV-6); after a save the form takes the saved values.
  const reload = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only new data replaces the form
  useEffect(() => {
    if (query.data && def && (reload.current || count === 0)) {
      setValues(toForm(def, query.data))
      reload.current = false
    }
  }, [query.data, def])

  /** The switch a field waits for, while it is off (FS-4). */
  const offOf = (f: FieldDef) => (f.needs && !values[f.needs] ? f.needs : null)

  function body() {
    const out: Record<string, unknown> = {}
    for (const f of def?.fields ?? []) {
      const v = current[f.name]
      if (f.type === "password") {
        // An unchanged secret is never sent again; null removes it.
        if (v === null || (typeof v === "string" && v)) out[f.name] = v
        continue
      }
      // Only what changed is sent, so a save never writes a value it did not change, such as one that comes
      // from the environment (FS-6).
      if (!fieldChanged(current, initial, f.name)) continue
      // A field whose switch is off is not checked; a value it cannot take is left unsent (FS-4).
      if (offOf(f) && fieldProblem(section, f, v, meta.limits)) continue
      if (f.type === "number") out[f.name] = Number(v)
      else if (f.type === "topic") out[f.name] = text(v) ? Number(text(v)) : null
      else if (f.type === "routes") out[f.name] = routesFromForm(v)
      else if (f.type === "list") out[f.name] = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []
      else out[f.name] = typeof v === "string" ? v.trim() : v
    }
    return out
  }

  /** Puts the focus in a field, opening this section first when another one is shown (SV-1). */
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

  /** Checks every changed field and marks those that fail (SV-1). */
  function check(): FieldProblem[] {
    if (!def || !query.data) return []
    const found: Record<string, string> = {}
    for (const f of def.fields) {
      if (f.type === "password" || offOf(f) || !fieldChanged(current, initial, f.name)) continue
      const problem = fieldProblem(section, f, current[f.name], meta.limits)
      if (problem) found[f.name] = problem
    }
    // The stored SMTP password is never sent to another server: a new host, port or user needs it again, unless
    // it is being removed (FS-5). The field opens for it.
    const password = values.smtpPassword
    if (
      section === "email" &&
      query.data.smtpPasswordSet &&
      smtpServerChanged(query.data, values) &&
      !(typeof password === "string" && password) &&
      password !== null
    ) {
      found.smtpPassword =
        "the SMTP server or user changed. Enter the SMTP password again, so the stored one is not sent to it."
      if (password === undefined) setValues((v) => ({ ...v, smtpPassword: "" }))
    }
    setProblems(found)
    return def.fields
      .filter((f) => f.name in found)
      .map((f) => {
        // A refused route takes the focus to its own field.
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
      try {
        await save.mutateAsync(sent)
      } catch (e) {
        // A field the server refused is marked like one the check found (SV-1).
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
      // Only a successful save lets the next answer replace the form; a failed one keeps the edits (SV-3).
      reload.current = true
      setProblems({})
      // The typed text went out with the list it was added to: it stays on screen as part of that list, also
      // when the next read fails.
      setValues((v) => withPending(v, pending))
      setPending({})
      if (def?.fields.some((f) => f.type === "password" && f.name in sent)) secretSaved()
      // A new design shows at once, without a reload.
      if (section === "general") afterGeneralSave(sent)
    },
    discard: () => {
      setProblems({})
      setPending({})
      if (query.data && def) setValues(toForm(def, query.data))
    },
  })
  if (!def) return null
  const set = (name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }))
    setProblems((p) => {
      if (!(name in p)) return p
      const { [name]: _, ...rest } = p
      return rest
    })
  }

  /** Where a value comes from and what puts it back (FS-6): the environment, Clear, or Changed with Reset. */
  function source(f: FieldDef) {
    const value = values[f.name]
    const env = meta.env?.[f.name]
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
      {/* A failed refresh keeps the form and what is typed in it, and says so above it (TB-5, LD-12, SV-1). */}
      <RefreshLine live={query} />
      {loadView(query) === "failed" ? (
        <LoadError what={def.title} error={query.error} retry={() => query.refetch()} />
      ) : loadView(query) === "loading" ? (
        <Loading>Loading the {def.title} settings…</Loading>
      ) : (
        // Locked while a save is on its way, so nothing typed meanwhile is lost when the saved values come back.
        <fieldset disabled={save.isPending} className="contents">
          {def.fields.map((f) => {
            const problem = problems[f.name]
            const marks = {
              "aria-invalid": problem ? true : undefined,
              "aria-describedby": problem ? problemId(f.name) : undefined,
            }
            const needs = offOf(f)
            const env = meta.env?.[f.name]
            // A refused route is marked in the list, with its problem under it.
            const routeIssue = f.type === "routes" && problem ? routesProblem(values[f.name]) : null
            return (
              <SettingRow
                key={f.name}
                // The routes are several fields; their label names the list, not one of them.
                htmlFor={f.type === "routes" ? undefined : f.name}
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
                  <Switch id={f.name} checked={Boolean(values[f.name])} onCheckedChange={(v) => set(f.name, v)} />
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
                  // Three short choices are a segmented control (FS-14).
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
                    // Times are typed as 24-hour HH:MM; a native time field would follow the browser's 12-hour clock.
                    type={f.type === "number" ? "number" : "text"}
                    inputMode={f.type === "time" || f.type === "topic" ? "numeric" : undefined}
                    className={f.type === "time" || f.type === "topic" ? "tabular-nums" : undefined}
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

/** A Telegram test that Telegram took, but in General: the default topic on screen is deleted or closed. */
const topicGoneText = "The default topic was not found, so the test message went to General"

/**
 * What a test sends: the values on screen, saved or not (FS-19). A secret goes only when it is typed, or as null
 * while it is being removed; otherwise the server uses the stored one, and only for the server it was stored for.
 */
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
    smtpUser: text(values.smtpUser),
    ...secret("smtpPassword"),
  }
}

/**
 * What a test result belongs to (SV-5): the values it sends, and how many times a secret was saved since the form
 * opened. A stored secret is left out of what is sent, so without the count a test of the password before a
 * replacement would still read Accepted once the new one is saved and the field is empty again.
 */
export function testIdentity(section: keyof typeof tests, values: Record<string, unknown>, secretsSaved: number) {
  return JSON.stringify({ draft: testDraft(section, values), secretsSaved })
}

/** What a test still needs on screen before it can run, or null (FB-1). */
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

/**
 * A section's connection test. It sends the values on screen without saving them and shows the last result
 * beside the button: Accepted or the failure in words, with the time (SV-5). The result belongs to the values it
 * tested and to the stored secrets of then: after a change, a saved secret, or for an answer to an older test, it
 * says so instead (lib/test-run.ts).
 */
function TestRow({
  section,
  data,
  values,
  secretsSaved,
}: {
  section: keyof typeof tests
  data: Record<string, unknown>
  values: Record<string, unknown>
  /** How many saves stored or removed a secret since the form opened (`testIdentity`). */
  secretsSaved: number
}) {
  const t = tests[section]
  const w = useTimeFormat()
  const [runs] = useState(createTestRuns)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  // A test still on its way when the form goes is forgotten: its answer has nothing to show.
  useEffect(() => () => runs.drop(), [runs])
  const draft = testDraft(section, values)
  const snapshot = testIdentity(section, values, secretsSaved)
  const missing = testMissing(section, draft, data)
  // What is on screen when an answer comes, which may differ from what the test sent or a secret saved meanwhile.
  const latest = useRef(snapshot)
  latest.current = snapshot
  async function run() {
    const started = runs.start(snapshot)
    redraw()
    let outcome: TestOutcome
    let recipients: string[] = []
    let topicGone = false
    try {
      const res = await api<{ recipients?: string[]; topicNotFound?: boolean } | null>(t.path, {
        method: "POST",
        json: draft,
      })
      recipients = res?.recipients ?? []
      topicGone = Boolean(res?.topicNotFound)
      outcome = {
        ok: true,
        detail: topicGone ? topicGoneText : recipients.length ? `Sent to ${recipients.join(", ")}` : undefined,
      }
    } catch (e) {
      outcome = { ok: false, message: describeError(e) }
    }
    const current = runs.settle(started, outcome, Date.now())
    redraw()
    // An answer to an older test, or to values changed meanwhile, says nothing more (SV-5).
    if (!current || runs.view(latest.current).kind === "changed") return
    if (outcome.ok) {
      if (topicGone) toast.warning(`${topicGoneText}.`)
      else toast.success(t.done(recipients))
    } else {
      toast.error(`${t.failed}: ${outcome.message}`)
      throw new Error(outcome.message)
    }
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
          <TestResult view={runs.view(snapshot)} dates={w} />
        )}
      </div>
    </div>
  )
}

/** The last test's result for the values on screen (SV-5). */
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
  // Each says what failed in a toast and rejects, so its button shows that it failed (FB-7).
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
      {/* A failed refresh keeps what is shown and says so above it (TB-5, LD-12). */}
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
              New backups use the new key. Archives made before keep needing the old private key, so keep it too.
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
