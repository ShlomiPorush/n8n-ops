import { ChevronDown, Download, KeyRound, KeySquare as KeySquareIcon, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { afterGeneralSave } from "@/app/design-sync"
import { settingsGroups, settingsSectionLabel } from "@/app/settings-sections"
import { useConfirm } from "@/components/confirm"
import {
  Copyable,
  countChanges,
  Empty,
  LoadError,
  Loading,
  Page,
  Panel,
  PanelHead,
  SecretField,
  UserText,
  useSaveSource,
} from "@/components/kit"
import { When } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { download } from "@/lib/download"
import { formatDateTime, useTimeZone } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

/** What the two designs are; the same words in both apps. */
const designHint =
  "How the console looks, for everyone. Both have the same pages and functions: Regular has white cards, icons and the Inter typeface; Compact fits more on each screen. It changes as soon as you save."

export type FieldDef = {
  name: string
  label: string
  hint?: string
  type?: "text" | "number" | "password" | "switch" | "time" | "list" | "weekday" | "design"
  placeholder?: string
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
      },
      {
        name: "timezone",
        label: "Time zone",
        hint: "For report and backup schedules and every time shown here, for example Asia/Jerusalem. Empty: UTC.",
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
      { name: "health", label: "Instance or worker down, queue backlog", type: "switch" },
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
      { name: "chatId", label: "Chat ID", placeholder: "-100…" },
    ],
  },
  email: {
    title: "Email reports",
    description:
      "Daily and weekly summaries: open problems, top failing workflows, health incidents, backups, versions.",
    fields: [
      { name: "dailyEnabled", label: "Daily report", type: "switch" },
      { name: "dailyTime", label: "Daily report time", type: "time" },
      { name: "weeklyEnabled", label: "Weekly report", type: "switch" },
      { name: "weeklyDay", label: "Weekly report day", type: "weekday" },
      { name: "weeklyTime", label: "Weekly report time", type: "time" },
      { name: "recipients", label: "Recipients", hint: "Comma-separated email addresses.", type: "list" },
      { name: "from", label: "From address" },
      { name: "smtpHost", label: "SMTP server" },
      { name: "smtpPort", label: "SMTP port", type: "number" },
      { name: "smtpSecure", label: "TLS from the start (port 465)", type: "switch" },
      { name: "smtpUser", label: "SMTP user" },
      { name: "smtpPassword", label: "SMTP password", type: "password" },
    ],
  },
  storage: {
    title: "Backup storage",
    description: "Any S3-compatible service. Archives are encrypted before upload.",
    fields: [
      { name: "endpoint", label: "Endpoint", placeholder: "https://s3.example.com" },
      { name: "region", label: "Region" },
      { name: "bucket", label: "Bucket" },
      { name: "prefix", label: "Key prefix" },
      { name: "accessKeyId", label: "Access key ID" },
      { name: "secretAccessKey", label: "Secret access key", type: "password" },
      {
        name: "forcePathStyle",
        label: "Path-style URLs",
        hint: "Needed by most self-hosted services such as MinIO.",
        type: "switch",
      },
    ],
  },
  defaults: {
    title: "Instance defaults",
    description: "Used by every instance unless it has an override.",
    fields: [
      { name: "pollIntervalSec", label: "Check for failures every (seconds)", type: "number" },
      { name: "healthIntervalSec", label: "Health check every (seconds)", type: "number" },
      { name: "backupTime", label: "Daily backup time", type: "time" },
      { name: "retentionDaily", label: "Keep daily backups", type: "number" },
      { name: "retentionWeekly", label: "Keep weekly backups", type: "number" },
      { name: "retentionMonthly", label: "Keep monthly backups", type: "number" },
      { name: "staleBackupHours", label: "Backup is stale after (hours)", type: "number" },
      { name: "executionRetentionDays", label: "Keep failed executions (days)", type: "number" },
      { name: "autoResolveDays", label: "Auto-resolve after days without failures", type: "number" },
      { name: "backlogThreshold", label: "Queue backlog alert (waiting jobs)", type: "number" },
      { name: "backlogMinutes", label: "for longer than (minutes)", type: "number" },
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
        hint: "To the recipients set under Email reports, with a link to decide here.",
        type: "switch",
      },
      {
        name: "telegramApprovers",
        label: "Who may approve in Telegram",
        hint: "Telegram user IDs or @usernames, comma-separated. Empty: only you, when the chat is a private chat with you; nobody in a group.",
        type: "list",
      },
    ],
  },
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** What each section is for, under its title. Forms take theirs from their definition. */
const sectionDescriptions: Record<string, string> = {
  keys: "Keys that protect backups and the secrets n8n-ops stores.",
  tokens: "Tokens for agents and scripts that read n8n-ops, and may ask for access to n8n instances.",
  account: "Your password and two-factor sign-in.",
}

/** The section last open, so Settings reopens where it was left during this visit (NL-4). */
let lastSection = "general"

export function SettingsPage() {
  const { section } = useParams()
  const navigate = useNavigate()
  const label = section ? settingsSectionLabel(section) : undefined
  useCrumb(label)
  if (!section || !label) return <Navigate to={`/settings/${lastSection}`} replace />
  lastSection = section
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
                      {l}
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
                  className="rounded-sm px-2.5 py-1.5 font-medium text-ink aria-[current=true]:bg-primary aria-[current=true]:font-title aria-[current=true]:text-primary-foreground regular:aria-[current=true]:bg-fill regular:aria-[current=true]:text-ink regular:aria-[current=true]:font-semibold [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:aria-[current=true]:hover:bg-primary"
                >
                  {l}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="grid min-w-0 max-w-3xl gap-gap">
          {/* Each section opens with a large title and one paragraph about what it is for (FS-8). */}
          <div className="grid gap-1.5">
            <h2 className="text-figure font-heavy tracking-tighter">{label}</h2>
            <p className="max-w-[75ch] text-muted-foreground">
              {forms[section]?.description ?? sectionDescriptions[section]}
            </p>
          </div>
          {section in forms && <SettingsForm key={section} section={section} />}
          {section === "keys" && <KeysCard />}
          {section === "account" && <AccountCard />}
          {section === "tokens" && <TokensCard />}
        </div>
      </div>
    </Page>
  )
}

/** A settings row: the label and its explanation at the start, the control at the end. */
function SettingRow({
  htmlFor,
  label,
  hint,
  children,
  wide,
  inline,
}: {
  htmlFor?: string
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  /** The control takes a full line under the label (long values). */
  wide?: boolean
  /** A switch: the whole row is its label, and it stays at the end of the row, also on a phone (FS-1). */
  inline?: boolean
}) {
  const text = (
    <div className="min-w-0">
      {htmlFor && !inline ? (
        <label htmlFor={htmlFor} className="font-semibold">
          {label}
        </label>
      ) : (
        <span className="block font-semibold">{label}</span>
      )}
      {hint && <span className="mt-0.5 block text-small text-muted-foreground">{hint}</span>}
    </div>
  )
  if (inline)
    return (
      <label
        htmlFor={htmlFor}
        data-setting-row
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-t border-line px-pad-x py-3"
      >
        {text}
        {children}
      </label>
    )
  return (
    <div
      data-setting-row
      className={cn(
        "grid items-center gap-x-6 gap-y-2 border-t border-line px-pad-x py-3",
        !wide && "md:grid-cols-[minmax(0,1fr)_260px]",
      )}
    >
      {text}
      <div className="flex min-w-0 items-center gap-2 md:justify-end">{children}</div>
    </div>
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
    let tries = 0
    const timer = setInterval(() => {
      const el = document.getElementById(field)
      tries += 1
      if (!el && tries < 80) return
      clearInterval(timer)
      if (!el) return
      const row = el.closest<HTMLElement>("[data-setting-row]") ?? el
      row.scrollIntoView({ block: "center" })
      el.focus({ preventScroll: true })
      row.classList.remove("search-flash")
      void row.offsetWidth
      row.classList.add("search-flash")
      navigate(".", { replace: true, state: null })
    }, 100)
    return () => clearInterval(timer)
  }, [field, ready, navigate])
}

/** Form values as loaded. A secret is `undefined` until the user replaces or removes it, and then not sent. */
const toForm = (def: { fields: FieldDef[] }, data: Record<string, unknown>) =>
  Object.fromEntries(
    def.fields.map((f) => {
      const v = data[f.name]
      if (f.type === "password") return [f.name, undefined]
      if (f.type === "list") return [f.name, Array.isArray(v) ? v.join(", ") : String(v ?? "")]
      if (f.type === "switch") return [f.name, Boolean(v)]
      return [f.name, v ?? ""]
    }),
  ) as Record<string, unknown>

export function SettingsForm({ section }: { section: string }) {
  const def = forms[section]
  const query = useApi<Record<string, unknown>>(`/settings/${section}`)
  useRevealField(!query.isLoading)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const save = useApiMutation<Record<string, unknown>>("PUT", `/settings/${section}`, {
    invalidate: [`/settings/${section}`, "/setup/checklist"],
  })
  const initial = query.data && def ? toForm(def, query.data) : {}
  const secrets = def?.fields.filter((f) => f.type === "password").map((f) => f.name) ?? []
  const plain = def?.fields.filter((f) => f.type !== "password").map((f) => f.name) ?? []
  const count = query.data
    ? countChanges(values, initial, plain) + secrets.filter((k) => values[k] !== undefined && values[k] !== "").length
    : 0
  // A refresh never overwrites what the user is typing (SV-6); after a save the form takes the saved values.
  const reload = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only new data replaces the form
  useEffect(() => {
    if (query.data && def && (reload.current || count === 0)) {
      setValues(toForm(def, query.data))
      reload.current = false
    }
  }, [query.data, def])

  function body() {
    const out: Record<string, unknown> = {}
    for (const f of def?.fields ?? []) {
      const v = values[f.name]
      if (f.type === "password") {
        // An unchanged secret is never sent again; null removes it.
        if (v === null || (typeof v === "string" && v)) out[f.name] = v
      } else if (f.type === "number") out[f.name] = Number(v)
      else if (f.type === "list")
        out[f.name] = String(v ?? "")
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      else out[f.name] = v
    }
    return out
  }
  useSaveSource(`settings-${section}`, {
    label: `the ${def?.title ?? section} settings`,
    saved: "Settings saved",
    count,
    save: async () => {
      const sent = body()
      await save.mutateAsync(sent)
      // Only a successful save lets the next answer replace the form; a failed one keeps the edits (SV-3).
      reload.current = true
      // A new design shows at once, without a reload.
      if (section === "general") afterGeneralSave(sent)
    },
    discard: () => query.data && def && setValues(toForm(def, query.data)),
  })
  if (!def) return null
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }))

  return (
    <Panel>
      {query.error ? (
        <LoadError what={def.title} error={query.error} retry={() => query.refetch()} />
      ) : query.isLoading ? (
        <Loading>Loading the {def.title} settings…</Loading>
      ) : (
        // Locked while a save is on its way, so nothing typed meanwhile is lost when the saved values come back.
        <fieldset disabled={save.isPending} className="contents">
          {def.fields.map((f) => (
            <SettingRow key={f.name} htmlFor={f.name} label={f.label} hint={f.hint} inline={f.type === "switch"}>
              {f.type === "switch" ? (
                <Switch id={f.name} checked={Boolean(values[f.name])} onCheckedChange={(v) => set(f.name, v)} />
              ) : f.type === "password" ? (
                <SecretField
                  id={f.name}
                  stored={Boolean(query.data?.[`${f.name}Set`])}
                  value={values[f.name] as string | null | undefined}
                  onChange={(v) => set(f.name, v)}
                />
              ) : f.type === "design" ? (
                <ToggleGroup
                  type="single"
                  aria-label="Design"
                  value={String(values[f.name] || "regular")}
                  onValueChange={(v) => v && set(f.name, v)}
                >
                  <ToggleGroupItem value="regular">Regular</ToggleGroupItem>
                  <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
                </ToggleGroup>
              ) : f.type === "weekday" ? (
                <Select
                  value={String(values[f.name] ?? 0)}
                  onValueChange={(v) => set(f.name, Number(v))}
                  // Radix Select opens on pointerdown and ignores a disabled fieldset, so it is locked itself.
                  disabled={save.isPending}
                >
                  <SelectTrigger id={f.name} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {weekdays.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={f.name}
                  // Times are typed as 24-hour HH:MM; a native time field would follow the browser's 12-hour clock.
                  type={f.type === "number" ? "number" : "text"}
                  inputMode={f.type === "time" ? "numeric" : undefined}
                  pattern={f.type === "time" ? "([01][0-9]|2[0-3]):[0-5][0-9]" : undefined}
                  className={f.type === "time" ? "tabular-nums" : undefined}
                  placeholder={f.type === "time" ? "HH:MM" : f.placeholder}
                  value={String(values[f.name] ?? "")}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
            </SettingRow>
          ))}
        </fieldset>
      )}
      {query.data && (section === "telegram" || section === "email" || section === "storage") && (
        <TestRow section={section} data={query.data} unsaved={count > 0} />
      )}
    </Panel>
  )
}

const tests = {
  telegram: {
    path: "/alerts/test/telegram",
    label: "Send test message",
    busy: "Sending…",
    done: "Test message sent",
    needs: (d: Record<string, unknown>) => (d.botTokenSet && d.chatId ? null : "the bot token and the chat ID"),
  },
  email: {
    path: "/alerts/test/email",
    label: "Send test email",
    busy: "Sending…",
    done: "Test email sent",
    needs: (d: Record<string, unknown>) =>
      d.smtpHost && Array.isArray(d.recipients) && d.recipients.length > 0 ? null : "the SMTP server and a recipient",
  },
  storage: {
    path: "/backups/test-storage",
    label: "Upload and verify a test file",
    busy: "Uploading…",
    done: "Upload and download verified",
    needs: (d: Record<string, unknown>) =>
      d.endpoint && d.bucket && d.secretAccessKeySet ? null : "the endpoint, the bucket and the secret access key",
  },
} as const

/** The connection test of a section. It tests the saved settings; until they exist it says what to save first (FB-1). */
function TestRow({
  section,
  data,
  unsaved,
}: {
  section: keyof typeof tests
  data: Record<string, unknown>
  unsaved: boolean
}) {
  const t = tests[section]
  const test = useApiMutation<void>("POST", t.path, { success: t.done })
  const missing = t.needs(data)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-pad-x py-3">
      <Button
        onClick={() => test.mutate()}
        disabled={test.isPending || missing !== null}
        title={missing ? `Save ${missing} first` : undefined}
      >
        {test.isPending ? t.busy : t.label}
      </Button>
      <span className="text-small text-muted-foreground">
        {missing
          ? `Save ${missing} first.`
          : unsaved
            ? "Tests the saved settings, not the unsaved changes."
            : "Tests the saved settings."}
      </span>
    </div>
  )
}

function KeysCard() {
  const tz = useTimeZone()
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
    }
  }
  async function downloadAppKey() {
    try {
      download("n8n-ops-app.key", await api<string>("/admin/keys/app"))
    } catch (e) {
      toast.error(`Could not download the key: ${describeError(e)}`)
    }
  }
  return (
    <Panel>
      {keys.error ? (
        <LoadError what="the keys" error={keys.error} retry={() => keys.refetch()} />
      ) : (
        <>
          <SettingRow
            label="Backup public key"
            hint="Archives are encrypted with this. Only the public half is on the server."
            wide
          >
            {keys.data?.backupRecipient ? (
              <Copyable value={keys.data.backupRecipient} label="Copy public key" className="text-small" />
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </SettingRow>
          <SettingRow label="Private key" hint="Shown once when generated. You need it to restore.">
            {keys.data?.privateKeySavedAt ? (
              <span className="flex items-center gap-2 font-semibold text-ok">
                <ShieldCheck className="size-4" />
                Saved, {formatDateTime(keys.data.privateKeySavedAt, tz)}
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
            <Button onClick={() => void downloadAppKey()}>
              <Download /> Download a copy
            </Button>
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
            <DialogTitle>New backup key pair</DialogTitle>
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
              <Button variant="primary" onClick={() => void confirm()}>
                I saved it
              </Button>
            ) : (
              <>
                <Button onClick={() => setRotate(false)}>Cancel</Button>
                <Button variant="primary" onClick={() => void generate()}>
                  Generate
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

function AccountCard() {
  const session = authClient.useSession()
  const [busy, setBusy] = useState(false)
  async function changePassword(form: FormData) {
    setBusy(true)
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get("current")),
      newPassword: String(form.get("next")),
      revokeOtherSessions: true,
    })
    setBusy(false)
    if (error) toast.error(`Password not changed: ${authErrorText(error)}`)
    else toast.success("Password changed. Other sessions were signed out.")
  }
  const username = (session.data?.user as { username?: string } | undefined)?.username
  return (
    <Panel>
      <PanelHead title="Sign-in" description={`Signed in as ${username ?? ""}.`} />
      <SettingRow label="Two-factor (TOTP)" hint="Required for this installation.">
        <span className="flex items-center gap-2 font-semibold text-ok">
          <ShieldCheck className="size-4" /> On
        </span>
      </SettingRow>
      <form
        className="grid gap-3 border-t border-line px-pad-x py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void changePassword(new FormData(e.currentTarget))
          e.currentTarget.reset()
        }}
      >
        <b className="font-semibold">Change password</b>
        <FieldGroup className="max-w-sm gap-3">
          <Field>
            <FieldLabel htmlFor="current">Current password</FieldLabel>
            <PasswordInput id="current" name="current" autoComplete="current-password" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="next">New password</FieldLabel>
            <PasswordInput id="next" name="next" minLength={12} autoComplete="new-password" required />
            <FieldDescription>At least 12 characters. Other sessions are signed out.</FieldDescription>
          </Field>
        </FieldGroup>
        <div>
          <Button type="submit" disabled={busy}>
            Change password
          </Button>
        </div>
      </form>
      <SettingRow label="Locked out?" hint="Reset the password and two-factor from the server." wide>
        <Copyable
          value="docker compose exec server node dist/cli.js reset-password"
          label="Copy command"
          className="text-small"
        />
      </SettingRow>
    </Panel>
  )
}

type Token = {
  id: string
  name: string
  kind: "mcp" | "rest"
  canRequestAccess: boolean
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}

function TokensCard() {
  const tokens = useApi<Token[]>("/admin/tokens")
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<"mcp" | "rest">("mcp")
  const [canRequestAccess, setCanRequestAccess] = useState(false)
  const [created, setCreated] = useState("")
  const confirm = useConfirm()
  const create = useApiMutation<{ name: string; kind: string; canRequestAccess: boolean }, { token: string }>(
    "POST",
    "/admin/tokens",
    {
      invalidate: ["/admin/tokens"],
    },
  )
  const revoke = useApiMutation<string>("DELETE", (id) => `/admin/tokens/${id}`, {
    invalidate: ["/admin/tokens"],
  })
  async function askRevoke(t: Token) {
    const ok = await confirm({
      title: `Revoke the token ${t.name}?`,
      message:
        "The agent or script using it loses access at once. This cannot be undone; create a new token to give access again.",
      confirmLabel: "Revoke token",
      danger: true,
    })
    if (ok) revoke.mutate(t.id, { onSuccess: () => toast.success(`Token ${t.name} revoked`) })
  }
  const list = tokens.data ?? []
  return (
    <Panel>
      <PanelHead
        title="API & MCP tokens"
        count={tokens.data ? list.length : undefined}
        description={
          <>
            Read-only tokens for agents (MCP at <code>/mcp</code>) and scripts (REST at <code>/api/v1</code>). A token
            may also be allowed to request temporary access to n8n instances, which a person approves each time.
          </>
        }
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCreated("")
              setCanRequestAccess(false)
              setOpen(true)
            }}
          >
            <Plus /> New token
          </Button>
        }
      />
      {tokens.error ? (
        <LoadError what="tokens" error={tokens.error} retry={() => tokens.refetch()} />
      ) : tokens.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty title="No tokens yet.">Create one for each agent or script, so you can revoke it on its own.</Empty>
      ) : (
        <Table bare>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-end">Created</TableHead>
              <TableHead className="text-end">Last used</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-semibold">
                  <UserText>{t.name}</UserText>{" "}
                  <span className="font-mono text-meta font-normal text-muted-foreground">{t.prefix}…</span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    <Badge variant="line">{t.kind === "mcp" ? "MCP · read" : "REST · read"}</Badge>
                    {t.canRequestAccess && <Badge variant="line">may request access</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-end text-muted-foreground">
                  <When value={t.createdAt} />
                </TableCell>
                <TableCell className="text-end text-muted-foreground">
                  {t.lastUsedAt ? <When value={t.lastUsedAt} /> : "Never"}
                </TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="danger" onClick={() => void askRevoke(t)}>
                    <Trash2 /> Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent keepOnBackdrop>
          <DialogHeader icon={KeySquareIcon}>
            <DialogTitle>New token</DialogTitle>
            <DialogDescription>The token is shown once. Store it where the agent or script reads it.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="grid gap-3">
              <pre
                className="overflow-x-auto rounded-sm bg-fill p-3 font-mono text-small whitespace-pre-wrap break-all"
                data-testid="new-token"
              >
                {created}
              </pre>
              <Copyable value={created} label="Copy token">
                Copy the token
              </Copyable>
            </div>
          ) : (
            <form
              id="token"
              onSubmit={(e) => {
                e.preventDefault()
                const name = String(new FormData(e.currentTarget).get("name"))
                create.mutate({ name, kind, canRequestAccess }, { onSuccess: (r) => setCreated(r.token) })
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="token-name">Name</FieldLabel>
                  <Input id="token-name" name="name" placeholder="claude-desktop" required />
                </Field>
                <Field>
                  <FieldLabel>Kind</FieldLabel>
                  <Select value={kind} onValueChange={(v) => setKind(v as "mcp" | "rest")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcp">MCP (agents)</SelectItem>
                      <SelectItem value="rest">REST (scripts)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="token-access"
                    checked={canRequestAccess}
                    onCheckedChange={(v) => setCanRequestAccess(v === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="token-access">May request access to n8n instances</FieldLabel>
                    <FieldDescription>
                      The agent can ask for temporary API access to an instance for a task. Nothing is granted until a
                      person approves the request.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            {created ? (
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="primary" type="submit" form="token" disabled={create.isPending}>
                  Create
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
