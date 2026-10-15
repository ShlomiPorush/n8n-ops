import {
  Bell,
  Bot,
  Copy,
  Download,
  Globe,
  HardDrive,
  KeyRound,
  KeySquare,
  type LucideIcon,
  Mail,
  Plus,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { Page } from "@/app/shell"
import { DialogIcon } from "@/components/dialog-icon"
import { EmptyState } from "@/components/empty-state"
import { TextStates } from "@/components/spectrum/text-states"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { download } from "@/lib/download"
import { cn } from "@/lib/utils"

type FieldDef = {
  name: string
  label: string
  hint?: string
  type?: "text" | "number" | "password" | "switch" | "time" | "list" | "weekday"
  placeholder?: string
}

const forms: Record<string, { title: string; description: string; fields: FieldDef[] }> = {
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
      { name: "timezone", label: "Time zone", hint: "For report and backup schedules, for example Asia/Jerusalem." },
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

/** Settings sections, grouped the way people look for them. */
const groups: { title: string; items: { key: string; label: string; icon: LucideIcon }[] }[] = [
  {
    title: "Installation",
    items: [
      { key: "general", label: "General", icon: Globe },
      { key: "defaults", label: "Instance defaults", icon: SlidersHorizontal },
    ],
  },
  {
    title: "Notifications",
    items: [
      { key: "alerts", label: "Alerts", icon: Bell },
      { key: "telegram", label: "Telegram", icon: Send },
      { key: "email", label: "Email reports", icon: Mail },
    ],
  },
  {
    title: "Backups",
    items: [
      { key: "storage", label: "Backup storage", icon: HardDrive },
      { key: "keys", label: "Encryption keys", icon: KeyRound },
    ],
  },
  {
    title: "Access",
    items: [
      { key: "account", label: "Account", icon: UserRound },
      { key: "access", label: "Agent access", icon: Bot },
      { key: "tokens", label: "API & MCP tokens", icon: KeySquare },
    ],
  },
]
const sectionsList = groups.flatMap((g) => g.items)

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function SettingsPage() {
  const { section = "general" } = useParams()
  const navigate = useNavigate()
  return (
    <Page title="Settings">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
        {/* Phones: one dropdown. Wider screens: grouped navigation beside the form. */}
        <div className="lg:hidden">
          <Select value={section} onValueChange={(v) => navigate(`/settings/${v}`)}>
            <SelectTrigger className="w-full sm:w-72" aria-label="Settings section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sectionsList.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 space-y-5 lg:sticky lg:top-6 lg:block">
          {groups.map((g) => (
            <div key={g.title} className="space-y-1">
              <div className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.title}</div>
              {g.items.map((item) => (
                <Link
                  key={item.key}
                  to={`/settings/${item.key}`}
                  aria-current={section === item.key ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    section === item.key && "bg-muted font-medium text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0 max-w-3xl flex-1">
          {section in forms && <SettingsForm key={section} section={section} />}
          {section === "keys" && <KeysCard />}
          {section === "account" && <AccountCard />}
          {section === "tokens" && <TokensCard />}
        </div>
      </div>
    </Page>
  )
}

export function SettingsForm({ section }: { section: string }) {
  const def = forms[section]
  const query = useApi<Record<string, unknown>>(`/settings/${section}`)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [justSaved, setJustSaved] = useState(false)
  const save = useApiMutation<Record<string, unknown>>("PUT", `/settings/${section}`, {
    invalidate: [`/settings/${section}`, "/setup/checklist"],
    success: "Settings saved",
  })
  useEffect(() => {
    if (query.data) setValues(query.data)
  }, [query.data])
  if (!def) return null
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }))
  function submit() {
    if (!def) return
    const body: Record<string, unknown> = {}
    for (const f of def.fields) {
      const v = values[f.name]
      if (f.type === "password") {
        if (typeof v === "string" && v) body[f.name] = v
      } else if (f.type === "number") body[f.name] = Number(v)
      else if (f.type === "list")
        body[f.name] = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s: string) => s.trim()).filter(Boolean)
      else body[f.name] = v
    }
    save.mutate(body, {
      onSuccess: () => {
        setJustSaved(true)
        window.setTimeout(() => setJustSaved(false), 2000)
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{def.title}</CardTitle>
        <CardDescription>{def.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {def.fields.map((f) => (
            <Field key={f.name} orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor={f.name}>{f.label}</FieldLabel>
                {f.hint && <FieldDescription>{f.hint}</FieldDescription>}
              </FieldContent>
              <div className="flex min-w-64 items-center gap-2">
                {f.type === "switch" ? (
                  <Switch id={f.name} checked={Boolean(values[f.name])} onCheckedChange={(v) => set(f.name, v)} />
                ) : f.type === "weekday" ? (
                  <Select value={String(values[f.name] ?? 0)} onValueChange={(v) => set(f.name, Number(v))}>
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
                    type={
                      f.type === "number"
                        ? "number"
                        : f.type === "password"
                          ? "password"
                          : f.type === "time"
                            ? "time"
                            : "text"
                    }
                    placeholder={
                      f.type === "password"
                        ? values[`${f.name}Set`]
                          ? "Stored. Type to replace."
                          : "Not set"
                        : f.placeholder
                    }
                    value={
                      f.type === "password"
                        ? String(values[f.name] ?? "")
                        : f.type === "list" && Array.isArray(values[f.name])
                          ? (values[f.name] as string[]).join(", ")
                          : String(values[f.name] ?? "")
                    }
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                )}
              </div>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2 border-t">
        <Button onClick={submit} disabled={save.isPending || query.isLoading}>
          <TextStates text={save.isPending ? "Saving…" : justSaved ? "Saved" : "Save"} />
        </Button>
        {section === "telegram" && <TestTelegramButton />}
        {section === "email" && <TestEmailButton />}
        {section === "storage" && <TestStorageButton />}
      </CardFooter>
    </Card>
  )
}

function TestTelegramButton() {
  const test = useApiMutation<void>("POST", "/alerts/test/telegram", { success: "Test message sent" })
  return (
    <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
      Send test message
    </Button>
  )
}

function TestEmailButton() {
  const test = useApiMutation<void>("POST", "/alerts/test/email", { success: "Test email sent" })
  return (
    <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
      Send test email
    </Button>
  )
}

function TestStorageButton() {
  const test = useApiMutation<void>("POST", "/backups/test-storage", { success: "Upload and download verified" })
  return (
    <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
      Upload and verify a test file
    </Button>
  )
}

function KeysCard() {
  const keys = useApi<{ backupRecipient: string | null; privateKeySavedAt: string | null }>("/admin/keys")
  const [rotate, setRotate] = useState(false)
  const [privateKey, setPrivateKey] = useState("")
  async function generate() {
    try {
      const res = await api<{ privateKey: string }>("/admin/keys/backup", { method: "POST" })
      setPrivateKey(res.privateKey)
      await keys.refetch()
    } catch (e) {
      toast.error(describeError(e))
    }
  }
  async function confirm() {
    await api("/admin/keys/backup/confirm", { method: "POST" })
    setPrivateKey("")
    setRotate(false)
    await keys.refetch()
    toast.success("New backup key in use")
  }
  async function downloadAppKey() {
    try {
      download("n8n-ops-app.key", await api<string>("/admin/keys/app"))
    } catch (e) {
      toast.error(describeError(e))
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Encryption keys</CardTitle>
        <CardDescription>Keys that protect backups and the secrets n8n-ops stores.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Backup public key</FieldLabel>
              <FieldDescription>
                Archives are encrypted with this. Only the public half is on the server.
              </FieldDescription>
            </FieldContent>
            <code className="min-w-64 font-mono text-xs break-all">{keys.data?.backupRecipient ?? "Not set"}</code>
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Private key</FieldLabel>
              <FieldDescription>Shown once when generated. You need it to restore.</FieldDescription>
            </FieldContent>
            <span className="min-w-64 text-sm">
              {keys.data?.privateKeySavedAt ? (
                <span className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                  <ShieldCheck className="size-4" />
                  You confirmed it is saved ({new Date(keys.data.privateKeySavedAt).toLocaleDateString()})
                </span>
              ) : (
                "Not confirmed"
              )}
            </span>
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Rotate</FieldLabel>
              <FieldDescription>Old archives still need the old private key.</FieldDescription>
            </FieldContent>
            <div className="min-w-64">
              <Button variant="outline" onClick={() => setRotate(true)}>
                <KeyRound /> Generate new key pair
              </Button>
            </div>
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>App secrets key</FieldLabel>
              <FieldDescription>
                Encrypts the API keys, tokens and passwords stored by n8n-ops. Kept in the server's data directory. Keep
                a copy: without it, stored secrets cannot be read after a restore.
              </FieldDescription>
            </FieldContent>
            <div className="min-w-64">
              <Button variant="outline" onClick={() => void downloadAppKey()}>
                <Download /> Download a copy
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </CardContent>
      <Dialog
        open={rotate}
        onOpenChange={(o) => {
          setRotate(o)
          if (!o) setPrivateKey("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogIcon icon={KeyRound} tone="amber" />
            <DialogTitle>New backup key pair</DialogTitle>
            <DialogDescription>
              New backups use the new key. Archives made before keep needing the old private key, so keep it too.
            </DialogDescription>
          </DialogHeader>
          {privateKey ? (
            <div className="space-y-3">
              <pre className="rounded-lg bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">
                {privateKey}
              </pre>
              <Button variant="outline" onClick={() => download("n8n-ops-backup-key.txt", `${privateKey}\n`)}>
                <Download /> Download key file
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            {privateKey ? (
              <Button onClick={() => void confirm()}>I saved it</Button>
            ) : (
              <Button onClick={() => void generate()}>Generate</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
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
    if (error) toast.error(authErrorText(error))
    else toast.success("Password changed. Other sessions were signed out.")
  }
  const username = (session.data?.user as { username?: string } | undefined)?.username
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Signed in as {username}.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Two-factor (TOTP)</FieldLabel>
              <FieldDescription>Required for this installation.</FieldDescription>
            </FieldContent>
            <span className="flex min-w-64 items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="size-4" /> On
            </span>
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void changePassword(new FormData(e.currentTarget))
              e.currentTarget.reset()
            }}
          >
            <FieldGroup>
              <Field orientation="responsive">
                <FieldLabel htmlFor="current">Current password</FieldLabel>
                <Input id="current" name="current" type="password" className="min-w-64" required />
              </Field>
              <Field orientation="responsive">
                <FieldLabel htmlFor="next">New password</FieldLabel>
                <Input id="next" name="next" type="password" minLength={12} className="min-w-64" required />
              </Field>
              <div>
                <Button type="submit" variant="outline" disabled={busy}>
                  Change password
                </Button>
              </div>
            </FieldGroup>
          </form>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Locked out?</FieldLabel>
              <FieldDescription>Reset the password and two-factor from the server.</FieldDescription>
            </FieldContent>
            <code className="min-w-64 font-mono text-xs">
              docker compose exec server node dist/cli.js reset-password
            </code>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
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
  const create = useApiMutation<{ name: string; kind: string; canRequestAccess: boolean }, { token: string }>(
    "POST",
    "/admin/tokens",
    {
      invalidate: ["/admin/tokens"],
    },
  )
  const revoke = useApiMutation<string>("DELETE", (id) => `/admin/tokens/${id}`, {
    invalidate: ["/admin/tokens"],
    success: "Token revoked",
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>API & MCP tokens</CardTitle>
        <CardDescription>
          Read-only tokens for agents (MCP at <code>/mcp</code>) and scripts (REST at <code>/api/v1</code>). A token may
          also be allowed to request temporary access to n8n instances, which a person approves each time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tokens.data?.length === 0 ? (
          <EmptyState
            icon={KeySquare}
            title="No tokens yet"
            description="Create one for each agent or script, so each can be revoked on its own."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tokens.data ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      {t.name} <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t.kind === "mcp" ? "MCP · read" : "REST · read"}</Badge>
                      {t.canRequestAccess && (
                        <Badge variant="outline" className="ml-1">
                          may request access
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => revoke.mutate(t.id)}
                      >
                        <Trash2 /> Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t">
        <Button
          onClick={() => {
            setCreated("")
            setCanRequestAccess(false)
            setOpen(true)
          }}
        >
          <Plus /> New token
        </Button>
      </CardFooter>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon icon={KeySquare} />
            <DialogTitle>New token</DialogTitle>
            <DialogDescription>The token is shown once. Store it where the agent or script reads it.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="new-token">
                {created}
              </pre>
              <Button
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(created).then(() => toast.success("Copied"))}
              >
                <Copy /> Copy
              </Button>
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
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button type="submit" form="token" disabled={create.isPending}>
                Create
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
