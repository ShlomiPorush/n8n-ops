import { useQueryClient } from "@tanstack/react-query"
import { Cloud, FolderOpen, Globe, HardDrive, type LucideIcon, Plus, Server, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import {
  Empty,
  LoadError,
  Loading,
  Panel,
  PanelHead,
  SecretField,
  SwitchRow,
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { n, plural } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

export type DestinationKind = "s3" | "local" | "sftp" | "webdav"
type Retention = { daily: number; weekly: number; monthly: number }
type Lock = { mode: "COMPLIANCE" | "GOVERNANCE"; days: number }

export type Destination = {
  id: string
  name: string
  kind: DestinationKind
  location: Record<string, string | number | boolean>
  credentials: Record<string, string | boolean>
  retention: Retention
  objectLock: Lock | null
  enabled: boolean
  isDefault: boolean
  lockedAt: string | null
  where: string
  copies: number
  lastOkAt: string | null
  lastFailure: { error: string | null; at: string | null } | null
}

type FieldDef = {
  name: string
  label: string
  hint?: string
  placeholder?: string
  type?: "text" | "number" | "switch" | "secret" | "key"
}

/** Each kind: its name, what it suits, where archives go and with what it connects. */
export const kinds: Record<
  DestinationKind,
  { label: string; icon: LucideIcon; hint: string; location: FieldDef[]; credentials: FieldDef[] }
> = {
  s3: {
    label: "S3",
    icon: Cloud,
    hint: "Any S3-compatible service: AWS, Backblaze B2, Wasabi, Cloudflare R2, MinIO.",
    location: [
      { name: "endpoint", label: "Endpoint", placeholder: "https://s3.example.com", hint: "Empty for AWS." },
      { name: "region", label: "Region", placeholder: "us-east-1" },
      { name: "bucket", label: "Bucket" },
      { name: "prefix", label: "Key prefix", placeholder: "n8n-ops", hint: "A folder in the bucket, or empty." },
      {
        name: "forcePathStyle",
        label: "Path-style URLs",
        hint: "Needed by most self-hosted services such as MinIO.",
        type: "switch",
      },
    ],
    credentials: [
      { name: "accessKeyId", label: "Access key ID" },
      { name: "secretAccessKey", label: "Secret access key", type: "secret" },
    ],
  },
  local: {
    label: "Folder",
    icon: HardDrive,
    hint: "A folder on the host, mapped into the server container at /backups.",
    location: [
      {
        name: "folder",
        label: "Folder under /backups",
        placeholder: "nightly",
        hint: "Empty to use /backups itself. The host folder is set in docker-compose.yml (./backups by default).",
      },
    ],
    credentials: [],
  },
  sftp: {
    label: "SFTP",
    icon: Server,
    hint: "Any server you can reach with SSH: a NAS, a VPS, a storage box.",
    location: [
      { name: "host", label: "Host", placeholder: "nas.example.com" },
      { name: "port", label: "Port", type: "number" },
      { name: "username", label: "User name" },
      { name: "path", label: "Folder on the server", placeholder: "/backups/n8n-ops", hint: "It must exist." },
    ],
    credentials: [
      {
        name: "hostKey",
        label: "Host key",
        placeholder: "SHA256:…",
        hint: "The server's key fingerprint. n8n-ops connects only to a server with this key.",
      },
      { name: "password", label: "Password", type: "secret", hint: "Or a private key below." },
      { name: "privateKey", label: "Private key", type: "key", hint: "OpenSSH format. Used instead of the password." },
      { name: "passphrase", label: "Key passphrase", type: "secret" },
    ],
  },
  webdav: {
    label: "WebDAV",
    icon: Globe,
    hint: "Nextcloud, ownCloud and most NAS, over HTTPS.",
    location: [
      {
        name: "url",
        label: "URL",
        placeholder: "https://cloud.example.com/remote.php/dav/files/me/n8n-ops/",
        hint: "An https:// URL of a folder that exists.",
      },
      { name: "username", label: "User name" },
    ],
    credentials: [
      { name: "password", label: "Password", type: "secret", hint: "An app password, where the service has them." },
    ],
  },
}

const blankLocation: Record<DestinationKind, Record<string, string | number | boolean>> = {
  s3: { endpoint: "", region: "us-east-1", bucket: "", prefix: "n8n-ops", forcePathStyle: true },
  local: { folder: "" },
  sftp: { host: "", port: 22, username: "", path: "" },
  webdav: { url: "", username: "" },
}

export const retentionText = (r: Retention) =>
  `${plural(r.daily, "day")}, ${plural(r.weekly, "week")}, ${plural(r.monthly, "month")}`

export function KindIcon({ kind, className }: { kind: DestinationKind; className?: string }) {
  const Icon = kinds[kind].icon
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
}

/** Tags of a destination: off, default, Object Lock. */
function Tags({ d }: { d: Destination }) {
  return (
    <>
      {!d.enabled && <Badge variant="muted">Off</Badge>}
      {d.enabled && d.isDefault && <Badge variant="info">Default</Badge>}
      {d.objectLock && <Badge variant="line">Object Lock {plural(d.objectLock.days, "day")}</Badge>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Settings > Backup Destinations
// ---------------------------------------------------------------------------

export function DestinationsSection() {
  const list = useApi<Destination[]>("/destinations")
  const [editing, setEditing] = useState<Destination | "new" | null>(null)
  const test = useApiMutation<string>("POST", (id) => `/destinations/${id}/test`)
  const data = list.data ?? []
  return (
    <>
      <Panel>
        <PanelHead
          title="Destinations"
          count={list.data ? n(data.length) : undefined}
          action={
            <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
              <Plus /> Add destination
            </Button>
          }
        />
        {list.error ? (
          <LoadError what="the destinations" error={list.error} retry={() => list.refetch()} />
        ) : list.isLoading ? (
          <Loading>Loading the destinations…</Loading>
        ) : data.length === 0 ? (
          <Empty title="No backup destination yet.">
            Add one: an S3 bucket, a folder on this server, an SFTP server or a WebDAV folder. Every backup is encrypted
            before it is written.
          </Empty>
        ) : (
          data.map((d) => (
            <div
              key={d.id}
              data-testid={`destination-${d.name}`}
              className="grid min-w-0 gap-x-4 gap-y-2 border-t border-line px-pad-x py-pad-y md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <KindIcon kind={d.kind} />
                  <span className="min-w-0 font-semibold">
                    <UserText>{d.name}</UserText>
                  </span>
                  <Tags d={d} />
                </div>
                <div className="mt-1 font-mono text-small break-all text-muted-foreground">{d.where}</div>
                <div className="mt-1 text-small text-muted-foreground">
                  Keeps {retentionText(d.retention)} · {plural(d.copies, "archive")}
                  {d.lastOkAt && (
                    <>
                      {" "}
                      · last written <When value={d.lastOkAt} />
                    </>
                  )}
                </div>
                {d.lastFailure && (!d.lastOkAt || (d.lastFailure.at ?? "") > d.lastOkAt) && (
                  <div className="mt-1 text-small break-words text-fail">
                    Last copy failed <When value={d.lastFailure.at} />: {d.lastFailure.error}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  disabled={test.isPending}
                  onClick={() =>
                    test.mutate(d.id, {
                      onSuccess: (res) => {
                        const notes = (res as { notes?: string[] }).notes ?? []
                        toast.success(`${d.name} works${notes.length ? `. ${notes.join(" ")}` : ""}`)
                      },
                    })
                  }
                >
                  {test.isPending && test.variables === d.id ? "Testing…" : "Test"}
                </Button>
                <Button size="sm" onClick={() => setEditing(d)}>
                  Edit
                </Button>
              </div>
            </div>
          ))
        )}
      </Panel>
      <SelfBackupCard destinations={data} />
      <DestinationDialog
        destination={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </>
  )
}

type Form = {
  name: string
  kind: DestinationKind
  location: Record<string, string | number | boolean>
  /** Plain fields as typed; a secret is undefined while unchanged, a string when replaced, null to remove. */
  credentials: Record<string, string | null | undefined>
  retention: { daily: string; weekly: string; monthly: string }
  lock: boolean
  lockMode: Lock["mode"]
  lockDays: string
  enabled: boolean
  isDefault: boolean
}

function formOf(d: Destination | null, kind: DestinationKind = "s3"): Form {
  const k = d?.kind ?? kind
  const credentials: Form["credentials"] = {}
  for (const f of kinds[k].credentials)
    credentials[f.name] = f.type === "secret" || f.type === "key" ? undefined : String(d?.credentials[f.name] ?? "")
  return {
    name: d?.name ?? "",
    kind: k,
    location: { ...blankLocation[k], ...(d?.location ?? {}) },
    credentials,
    retention: {
      daily: String(d?.retention.daily ?? 7),
      weekly: String(d?.retention.weekly ?? 4),
      monthly: String(d?.retention.monthly ?? 6),
    },
    lock: Boolean(d?.objectLock),
    lockMode: d?.objectLock?.mode ?? "COMPLIANCE",
    lockDays: String(d?.objectLock?.days ?? 30),
    enabled: d?.enabled ?? true,
    isDefault: d?.isDefault ?? true,
  }
}

/** What to send: on an edit only what changed, so a rename does not test the connection again. */
function bodyOf(form: Form, d: Destination | null) {
  const location = Object.fromEntries(
    kinds[form.kind].location.map((f) => {
      const v = form.location[f.name]
      return [f.name, f.type === "number" ? Number(v) : f.type === "switch" ? Boolean(v) : String(v ?? "").trim()]
    }),
  )
  const credentials: Record<string, string | null> = {}
  for (const f of kinds[form.kind].credentials) {
    const v = form.credentials[f.name]
    if (f.type === "secret" || f.type === "key") {
      if (v === null || (typeof v === "string" && v)) credentials[f.name] = v
    } else if (!d || String(v ?? "") !== String(d.credentials[f.name] ?? ""))
      credentials[f.name] = String(v ?? "").trim()
  }
  const objectLock = form.kind === "s3" && form.lock ? { mode: form.lockMode, days: Number(form.lockDays) } : null
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    retention: {
      daily: Number(form.retention.daily),
      weekly: Number(form.retention.weekly),
      monthly: Number(form.retention.monthly),
    },
    enabled: form.enabled,
    isDefault: form.isDefault,
  }
  if (!d) return { ...body, kind: form.kind, location, credentials, objectLock }
  if (!d.lockedAt) body.location = location
  if (Object.keys(credentials).length) body.credentials = credentials
  // Compared field by field: the stored lock may list its fields in another order.
  if (
    (objectLock?.mode ?? null) !== (d.objectLock?.mode ?? null) ||
    (objectLock?.days ?? null) !== (d.objectLock?.days ?? null)
  )
    body.objectLock = objectLock
  return body
}

/** Adds or edits a destination. The server tests it before anything is stored. */
export function DestinationDialog({
  destination,
  open,
  onOpenChange,
}: {
  destination: Destination | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const client = useQueryClient()
  const [form, setForm] = useState<Form>(() => formOf(destination))
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (!open) return
    setForm(formOf(destination))
    setError("")
  }, [open, destination])
  const locked = Boolean(destination?.lockedAt)

  async function submit() {
    setBusy(true)
    setError("")
    try {
      const res = destination
        ? await api<{ notes?: string[] }>(`/destinations/${destination.id}`, {
            method: "PATCH",
            json: bodyOf(form, destination),
          })
        : await api<{ notes?: string[] }>("/destinations", { method: "POST", json: bodyOf(form, null) })
      const notes = res.notes ?? []
      toast.success(
        `${destination ? "Saved" : "Added"} ${form.name.trim()}${notes.length ? `. ${notes.join(" ")}` : ""}`,
      )
      onOpenChange(false)
      await client.invalidateQueries()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open && !deleting} onOpenChange={onOpenChange}>
        <DialogContent className="md:max-w-xl" keepOnBackdrop>
          <DialogHeader icon={destination ? kinds[destination.kind].icon : FolderOpen}>
            <DialogTitle>{destination ? `Edit ${destination.name}` : "Add a Backup Destination"}</DialogTitle>
            <DialogDescription>
              {destination
                ? "Changes to how it connects are tested before they are saved. Where archives go stays as set, so earlier archives are always found."
                : "It is tested with a small file before it is saved. Archives are encrypted before they are written."}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="contents">
            <DestinationFields form={form} setForm={setForm} destination={destination} locked={locked} />
          </fieldset>
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter>
            {destination && (
              <Button variant="danger" className="me-auto" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !form.name.trim()}>
              {busy ? "Testing…" : destination ? "Save" : "Test and add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {destination && (
        <DeleteDestination
          destination={destination}
          open={open && deleting}
          onClose={(done) => {
            setDeleting(false)
            if (done) onOpenChange(false)
          }}
        />
      )}
    </>
  )
}

/** The fields of a destination, also used by the first-run setup. */
export function DestinationFields({
  form,
  setForm,
  destination,
  locked,
  only,
}: {
  form: Form
  setForm: (update: (f: Form) => Form) => void
  destination: Destination | null
  locked: boolean
  /** The kinds offered for a new destination. */
  only?: DestinationKind[]
}) {
  const kind = kinds[form.kind]
  const setLocation = (k: string, v: string | number | boolean) =>
    setForm((f) => ({ ...f, location: { ...f.location, [k]: v } }))
  const setCredential = (k: string, v: string | null | undefined) =>
    setForm((f) => ({ ...f, credentials: { ...f.credentials, [k]: v } }))
  const [hostKeyBusy, setHostKeyBusy] = useState(false)
  const [hostKeyError, setHostKeyError] = useState("")
  async function readHostKey() {
    setHostKeyBusy(true)
    setHostKeyError("")
    try {
      const res = await api<{ hostKey: string }>("/destinations/host-key", {
        method: "POST",
        json: { host: String(form.location.host ?? "").trim(), port: Number(form.location.port || 22) },
      })
      setCredential("hostKey", res.hostKey)
    } catch (e) {
      setHostKeyError(describeError(e))
    } finally {
      setHostKeyBusy(false)
    }
  }

  return (
    <FieldGroup>
      {!destination && (
        <Field>
          <FieldLabel>Kind</FieldLabel>
          <ToggleGroup
            type="single"
            aria-label="Kind"
            value={form.kind}
            onValueChange={(v) =>
              v && setForm((f) => ({ ...formOf(null, v as DestinationKind), name: f.name, isDefault: f.isDefault }))
            }
          >
            {(only ?? (Object.keys(kinds) as DestinationKind[])).map((k) => (
              <ToggleGroupItem key={k} value={k}>
                {kinds[k].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>{kind.hint}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="d-name">Name</FieldLabel>
        <Input
          id="d-name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder={form.kind === "local" ? "This server" : form.kind === "s3" ? "Offsite S3" : "NAS"}
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label" className="w-full border-t border-line pt-4">
          Where
        </FieldLegend>
        {locked && (
          <FieldDescription>
            Fixed once set: earlier archives stay where they were written. For another place, add a new destination.
          </FieldDescription>
        )}
        {kind.location.map((f) =>
          f.type === "switch" ? (
            <SwitchRow
              key={f.name}
              id={`d-${f.name}`}
              title={f.label}
              description={f.hint}
              checked={Boolean(form.location[f.name])}
              onCheckedChange={(v) => setLocation(f.name, v)}
              disabled={locked}
            />
          ) : (
            <Field key={f.name}>
              <FieldLabel htmlFor={`d-${f.name}`}>{f.label}</FieldLabel>
              <Input
                id={`d-${f.name}`}
                type={f.type === "number" ? "number" : "text"}
                value={String(form.location[f.name] ?? "")}
                onChange={(e) => setLocation(f.name, f.type === "number" ? e.target.value : e.target.value)}
                placeholder={f.placeholder}
                readOnly={locked}
                className={cn(locked && "text-muted-foreground")}
              />
              {f.hint && !locked && <FieldDescription>{f.hint}</FieldDescription>}
            </Field>
          ),
        )}
      </FieldSet>
      {kind.credentials.length > 0 && (
        <FieldSet>
          <FieldLegend variant="label" className="w-full border-t border-line pt-4">
            Sign-in
          </FieldLegend>
          {kind.credentials.map((f) => (
            <Field key={f.name}>
              <FieldLabel htmlFor={`d-${f.name}`}>{f.label}</FieldLabel>
              {f.type === "secret" ? (
                <SecretField
                  id={`d-${f.name}`}
                  stored={Boolean(destination?.credentials[`${f.name}Set`])}
                  value={form.credentials[f.name]}
                  onChange={(v) => setCredential(f.name, v)}
                />
              ) : f.type === "key" ? (
                destination?.credentials[`${f.name}Set`] && form.credentials[f.name] === undefined ? (
                  <SecretField id={`d-${f.name}`} stored value={undefined} onChange={(v) => setCredential(f.name, v)} />
                ) : (
                  <Textarea
                    id={`d-${f.name}`}
                    className="font-mono text-small"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={form.credentials[f.name] ?? ""}
                    onChange={(e) => setCredential(f.name, e.target.value || undefined)}
                  />
                )
              ) : (
                <div className="flex min-w-0 gap-2">
                  <Input
                    id={`d-${f.name}`}
                    className={cn(f.name === "hostKey" && "font-mono text-small")}
                    value={form.credentials[f.name] ?? ""}
                    onChange={(e) => setCredential(f.name, e.target.value)}
                    placeholder={f.placeholder}
                  />
                  {f.name === "hostKey" && (
                    <Button
                      onClick={() => void readHostKey()}
                      disabled={hostKeyBusy || !String(form.location.host ?? "").trim()}
                    >
                      {hostKeyBusy ? "Reading…" : "Read from server"}
                    </Button>
                  )}
                </div>
              )}
              {f.name === "hostKey" && hostKeyError && <FieldError>{hostKeyError}</FieldError>}
              {f.hint && <FieldDescription>{f.hint}</FieldDescription>}
              {f.name === "hostKey" && (
                <FieldDescription>
                  "Read from server" shows the key the server presents, before any password is sent. Compare it with the
                  one your server shows (ssh-keygen -lf on its host key) before you save.
                </FieldDescription>
              )}
            </Field>
          ))}
        </FieldSet>
      )}
      <FieldSet>
        <FieldLegend variant="label" className="w-full border-t border-line pt-4">
          Retention
        </FieldLegend>
        <FieldDescription>
          The newest archive of each of the last days, weeks and months is kept, per instance; older ones are removed
          here. The newest archive is always kept.
        </FieldDescription>
        <div className="grid gap-3 min-[480px]:grid-cols-3">
          {(["daily", "weekly", "monthly"] as const).map((k) => (
            <Field key={k}>
              <FieldLabel htmlFor={`d-keep-${k}`}>Keep {k}</FieldLabel>
              <Input
                id={`d-keep-${k}`}
                type="number"
                min={k === "daily" ? 1 : 0}
                value={form.retention[k]}
                onChange={(e) => setForm((f) => ({ ...f, retention: { ...f.retention, [k]: e.target.value } }))}
              />
            </Field>
          ))}
        </div>
      </FieldSet>
      {form.kind === "s3" && (
        <FieldSet>
          <FieldLegend variant="label" className="w-full border-t border-line pt-4">
            Immutable Copies
          </FieldLegend>
          <SwitchRow
            id="d-lock"
            title="Object Lock"
            description="Every archive is locked when it is written: nobody can delete or change it until the lock ends, not even with these keys. The bucket must have been created with Object Lock."
            checked={form.lock}
            onCheckedChange={(v) => setForm((f) => ({ ...f, lock: v }))}
          />
          {form.lock && (
            <div className="grid gap-3 min-[480px]:grid-cols-2">
              <Field>
                <FieldLabel>Lock mode</FieldLabel>
                <Select
                  value={form.lockMode}
                  onValueChange={(v) => setForm((f) => ({ ...f, lockMode: v as Lock["mode"] }))}
                >
                  <SelectTrigger className="w-full" aria-label="Lock mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="COMPLIANCE">Compliance: nobody can remove it early</SelectItem>
                    <SelectItem value="GOVERNANCE">Governance: users with a bypass right can</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="d-lock-days">Lock for (days)</FieldLabel>
                <Input
                  id="d-lock-days"
                  type="number"
                  min={1}
                  value={form.lockDays}
                  onChange={(e) => setForm((f) => ({ ...f, lockDays: e.target.value }))}
                />
              </Field>
              <FieldDescription className="min-[480px]:col-span-2">
                Retention removes an archive only after its lock ends. A lock longer than the retention keeps archives
                (and their cost) for the whole lock.
              </FieldDescription>
            </div>
          )}
        </FieldSet>
      )}
      <FieldSet>
        <FieldLegend variant="label" className="w-full border-t border-line pt-4">
          Use
        </FieldLegend>
        <SwitchRow
          id="d-default"
          title="Default destination"
          description="Instances that use the default destinations back up here, new ones included."
          checked={form.isDefault}
          onCheckedChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
        />
        <SwitchRow
          id="d-enabled"
          title="On"
          description="Off: no new archives are written here. Existing ones can still be restored and expire as usual."
          checked={form.enabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
        />
      </FieldSet>
    </FieldGroup>
  )
}

export type { Form as DestinationForm }
export { bodyOf as destinationBody, formOf as destinationForm }

/** Removing a destination: its archives stay where they are, or go with it. */
function DeleteDestination({
  destination,
  open,
  onClose,
}: {
  destination: Destination
  open: boolean
  onClose: (done: boolean) => void
}) {
  const client = useQueryClient()
  const [files, setFiles] = useState<"keep" | "delete">("keep")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setFiles("keep")
      setError("")
    }
  }, [open])
  async function remove() {
    setBusy(true)
    setError("")
    try {
      await api(`/destinations/${destination.id}?files=${files}`, { method: "DELETE" })
      toast.success(`Deleted ${destination.name}`)
      onClose(true)
      await client.invalidateQueries()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="md:max-w-[520px]" keepOnBackdrop>
        <DialogHeader icon={Trash2} tone="fail">
          <DialogTitle>Delete {destination.name}?</DialogTitle>
          <DialogDescription>
            No new backup is written here. {plural(destination.copies, "archive")} on it can no longer be restored from
            n8n-ops. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ToggleGroup
          type="single"
          aria-label="Its archives"
          className="w-full flex-col items-stretch min-[480px]:flex-row"
          value={files}
          onValueChange={(v) => v && setFiles(v as "keep" | "delete")}
        >
          <ToggleGroupItem value="keep">Keep its archives where they are</ToggleGroupItem>
          <ToggleGroupItem value="delete">Delete its archives too</ToggleGroupItem>
        </ToggleGroup>
        {destination.objectLock && files === "delete" && (
          <p className="text-small text-muted-foreground">Archives still under Object Lock cannot be deleted.</p>
        )}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="danger-solid" onClick={() => void remove()} disabled={busy}>
            {busy ? "Deleting…" : files === "delete" ? "Delete destination and archives" : "Delete destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Choosing destinations: an instance, or n8n-ops's own database
// ---------------------------------------------------------------------------

type Choice = { mode: "default" | "custom"; ids: string[] }

/** The default destinations, or a choice of them. The choice is kept while the defaults are used. */
function DestinationChoice({
  id,
  destinations,
  choice,
  onChange,
}: {
  id: string
  destinations: Destination[]
  choice: Choice
  onChange: (choice: Choice) => void
}) {
  const defaults = destinations.filter((d) => d.enabled && d.isDefault)
  if (!destinations.length)
    return (
      <p className="text-muted-foreground">
        No backup destination yet.{" "}
        <Link to="/settings/destinations" className="font-semibold text-ink underline">
          Add one
        </Link>
        .
      </p>
    )
  return (
    <div className="grid gap-3">
      <ToggleGroup
        type="single"
        aria-label="Backup destinations"
        value={choice.mode}
        onValueChange={(v) => v && onChange({ ...choice, mode: v as Choice["mode"] })}
      >
        <ToggleGroupItem value="default">Default destinations</ToggleGroupItem>
        <ToggleGroupItem value="custom">Choose</ToggleGroupItem>
      </ToggleGroup>
      {choice.mode === "default" ? (
        <p className="text-muted-foreground">
          {defaults.length
            ? `Now: ${defaults.map((d) => d.name).join(", ")}. Follows the defaults as they change.`
            : "No destination is marked as default, so nothing is backed up."}
        </p>
      ) : (
        <div className="grid gap-2">
          {destinations.map((d) => (
            <label key={d.id} htmlFor={`${id}-${d.id}`} className="flex min-w-0 cursor-pointer items-center gap-2.5">
              <Checkbox
                id={`${id}-${d.id}`}
                checked={choice.ids.includes(d.id)}
                onCheckedChange={(v) =>
                  onChange({
                    ...choice,
                    ids: v === true ? [...choice.ids, d.id] : choice.ids.filter((x) => x !== d.id),
                  })
                }
              />
              <KindIcon kind={d.kind} />
              <span className={cn("min-w-0 truncate font-medium", !d.enabled && "text-muted-foreground")}>
                {d.name}
              </span>
              {!d.enabled && <Badge variant="muted">Off</Badge>}
            </label>
          ))}
          {!choice.ids.some((x) => destinations.find((d) => d.id === x)?.enabled) && (
            <p className="font-semibold text-warn">No destination chosen that is on: nothing is backed up.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** The choice as stored, with unsaved changes counted against it and kept through refreshes. */
function useChoice(stored: Choice | null) {
  const [choice, setChoice] = useState<Choice | null>(stored)
  const base = useRef<Choice | null>(stored)
  const count = choice && base.current ? changes(choice, base.current) : 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new stored choice replaces an unchanged form
  useEffect(() => {
    if (!stored) return
    if (!base.current || count === 0) {
      base.current = stored
      setChoice(stored)
    }
  }, [JSON.stringify(stored)])
  return {
    choice,
    setChoice,
    count,
    saved: () => {
      base.current = choice
    },
    discard: () => setChoice(base.current),
  }
}

const changes = (a: Choice, b: Choice) =>
  Number(a.mode !== b.mode) +
  (a.mode === "custom"
    ? a.ids.filter((x) => !b.ids.includes(x)).length + b.ids.filter((x) => !a.ids.includes(x)).length
    : 0)

/** On an instance: where its backups go. */
export function InstanceBackupCard({
  instanceId,
  mode,
  destinationIds,
}: {
  instanceId: string
  mode: "default" | "custom"
  destinationIds: string[]
}) {
  const destinations = useApi<Destination[]>("/destinations")
  const state = useChoice({ mode, ids: destinationIds })
  const save = useApiMutation<{ mode: string; destinationIds: string[] }>(
    "PUT",
    `/instances/${instanceId}/backup-destinations`,
    { invalidate: [`/instances/${instanceId}`, "/backups"] },
  )
  useSaveSource(`backup-destinations-${instanceId}`, {
    label: "the backup destinations",
    saved: "Backup destinations saved",
    count: state.count,
    save: async () => {
      if (!state.choice) return
      await save.mutateAsync({ mode: state.choice.mode, destinationIds: state.choice.ids })
      state.saved()
    },
    discard: state.discard,
  })
  return (
    <Panel className="overflow-visible">
      <PanelHead title="Backup Destinations" description="Where this instance's encrypted backups are written." />
      <fieldset disabled={save.isPending} className="border-t border-line p-pad-x">
        {destinations.error ? (
          <LoadError what="the destinations" error={destinations.error} retry={() => destinations.refetch()} />
        ) : !destinations.data || !state.choice ? (
          <Loading />
        ) : (
          <DestinationChoice
            id={`ib-${instanceId}`}
            destinations={destinations.data}
            choice={state.choice}
            onChange={state.setChoice}
          />
        )}
      </fieldset>
    </Panel>
  )
}

type BackupSettings = { selfDestinations: "default" | "custom"; selfDestinationIds: string[]; maxArchiveMb: number }

/** Where the n8n-ops database backup goes, and the largest archive accepted. */
function SelfBackupCard({ destinations }: { destinations: Destination[] }) {
  const query = useApi<BackupSettings>("/settings/backups")
  const stored = query.data ? { mode: query.data.selfDestinations, ids: query.data.selfDestinationIds } : null
  const state = useChoice(stored)
  const [max, setMax] = useState("")
  const maxBase = useRef("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: only new stored settings replace an unchanged field
  useEffect(() => {
    if (!query.data) return
    if (max === maxBase.current) setMax(String(query.data.maxArchiveMb))
    maxBase.current = String(query.data.maxArchiveMb)
  }, [query.data?.maxArchiveMb])
  const save = useApiMutation<Partial<BackupSettings>>("PUT", "/settings/backups", {
    invalidate: ["/settings/backups", "/backups"],
  })
  const count = state.count + Number(max !== maxBase.current)
  useSaveSource("backup-settings", {
    label: "the backup settings",
    saved: "Backup settings saved",
    count,
    save: async () => {
      if (!state.choice) return
      await save.mutateAsync({
        selfDestinations: state.choice.mode,
        selfDestinationIds: state.choice.ids,
        maxArchiveMb: Number(max),
      })
      state.saved()
      maxBase.current = max
    },
    discard: () => {
      state.discard()
      setMax(maxBase.current)
    },
  })
  return (
    <Panel className="overflow-visible">
      <PanelHead
        title="n8n-ops Database"
        description="n8n-ops backs up its own database every night, encrypted with the same key."
      />
      <fieldset disabled={save.isPending} className="grid gap-4 border-t border-line p-pad-x">
        {query.error ? (
          <LoadError what="the backup settings" error={query.error} retry={() => query.refetch()} />
        ) : !state.choice ? (
          <Loading />
        ) : (
          <>
            <DestinationChoice id="self" destinations={destinations} choice={state.choice} onChange={state.setChoice} />
            <Field>
              <FieldLabel htmlFor="max-archive">Largest archive (MiB)</FieldLabel>
              <Input id="max-archive" type="number" min={16} value={max} onChange={(e) => setMax(e.target.value)} />
              <FieldDescription>
                For every backup. Archives are built in memory, so this also bounds the memory a backup takes.
              </FieldDescription>
            </Field>
          </>
        )}
      </fieldset>
    </Panel>
  )
}
