import { useQueryClient } from "@tanstack/react-query"
import { Download } from "lucide-react"
import QRCode from "qrcode"
import { useEffect, useState } from "react"
import { Navigate, useNavigate } from "react-router"
import { Loading, Panel } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { ApiError, api, describeError, useApi } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { download } from "@/lib/download"
import { cn } from "@/lib/utils"
import { AuthFrame, TotpInput } from "./shared"

type Checklist = { twoFactor: boolean; backupKey: boolean; telegram: boolean; storage: boolean; instance: boolean }
const steps = ["Account", "Two-factor", "Backup key", "Telegram", "Storage"] as const
type Step = (typeof steps)[number]

export function SetupPage() {
  const status = useApi<{ hasUser: boolean }>("/setup/status")
  const checklist = useApi<Checklist>(status.data?.hasUser ? "/setup/checklist" : null)
  const [password, setPassword] = useState("")
  const [skipped, setSkipped] = useState<Step[]>([])
  const navigate = useNavigate()
  const client = useQueryClient()

  if (status.isLoading || checklist.isLoading)
    return (
      <AuthFrame>
        <Loading />
      </AuthFrame>
    )
  const notSignedIn = checklist.error instanceof ApiError && checklist.error.status === 401
  if (status.data?.hasUser && notSignedIn) return <Navigate to="/login" replace />

  const c = checklist.data
  let step: Step | "done" = "done"
  if (!status.data?.hasUser) step = "Account"
  else if (c && !c.twoFactor) step = "Two-factor"
  else if (c && !c.backupKey) step = "Backup key"
  else if (c && !c.telegram && !skipped.includes("Telegram")) step = "Telegram"
  else if (c && !c.storage && !skipped.includes("Storage")) step = "Storage"
  if (step === "done") return <Navigate to="/" replace />

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["/setup/status"] })
    await client.invalidateQueries({ queryKey: ["/setup/checklist"] })
  }
  const skip = (s: Step) => setSkipped([...skipped, s])
  const index = steps.indexOf(step)

  return (
    <AuthFrame wide>
      <ol aria-label="Setup steps" className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 text-ctl font-semibold",
              i === index ? "text-ink" : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-5 place-items-center rounded-full text-meta font-bold tabular-nums",
                i === index ? "bg-primary text-primary-foreground" : i < index ? "tint-ok" : "tint-muted",
              )}
            >
              {i + 1}
            </span>
            {s}
            {i < index && <span className="sr-only"> (done)</span>}
          </li>
        ))}
      </ol>
      {step === "Account" && (
        <AccountStep
          onDone={async (pw) => {
            setPassword(pw)
            await refresh()
          }}
        />
      )}
      {step === "Two-factor" && <TwoFactorStep password={password} onDone={refresh} />}
      {step === "Backup key" && <BackupKeyStep onDone={refresh} />}
      {step === "Telegram" && <TelegramStep onDone={refresh} onSkip={() => skip("Telegram")} />}
      {step === "Storage" && (
        <StorageStep
          onDone={async () => {
            await refresh()
            navigate("/")
          }}
          onSkip={() => {
            skip("Storage")
            navigate("/")
          }}
        />
      )}
    </AuthFrame>
  )
}

/** One setup step: a heading with the question it answers, the form, and the actions under it. */
function StepFrame({
  title,
  description,
  children,
  actions,
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="grid gap-gap">
      <div>
        <h1 className="text-h1">{title}</h1>
        <p className="mt-1.5 text-muted-foreground">{description}</p>
      </div>
      {children}
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </section>
  )
}

function AccountStep({ onDone }: { onDone: (password: string) => Promise<void> }) {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function submit(form: FormData) {
    const username = String(form.get("username"))
    const password = String(form.get("password"))
    if (password !== String(form.get("confirm"))) return setError("The passwords do not match.")
    setBusy(true)
    setError("")
    try {
      await api("/setup/account", { method: "POST", json: { username, password } })
      const { error } = await authClient.signIn.username({ username, password })
      if (error) throw new Error(authErrorText(error))
      await onDone(password)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <StepFrame
      title="Create your account"
      description="n8n-ops has one user. Two-factor authentication is set up next and is required."
      actions={
        <Button type="submit" form="account" variant="primary" disabled={busy}>
          Create account
        </Button>
      }
    >
      <form
        id="account"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(new FormData(e.currentTarget))
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="username">Username</FieldLabel>
            <Input id="username" name="username" autoComplete="username" required minLength={3} autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={12} />
            <FieldDescription>At least 12 characters.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="confirm">Repeat password</FieldLabel>
            <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required />
          </Field>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
      </form>
    </StepFrame>
  )
}

function TwoFactorStep({ password: known, onDone }: { password: string; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState(known)
  const [uri, setUri] = useState("")
  const [qr, setQr] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function start(pw: string) {
    setBusy(true)
    setError("")
    const { data, error } = await authClient.twoFactor.enable({ password: pw })
    setBusy(false)
    if (error || !data) return setError(authErrorText(error))
    if (!("totpURI" in data)) return setError("The server did not return a TOTP secret.")
    setUri(data.totpURI)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, as soon as the password is known
  useEffect(() => {
    if (known && !uri) void start(known)
  }, [known, uri])

  useEffect(() => {
    if (uri) void QRCode.toDataURL(uri, { margin: 1, width: 200 }).then(setQr)
  }, [uri])

  async function verify(code: string) {
    setBusy(true)
    setError("")
    const { error } = await authClient.twoFactor.verifyTotp({ code })
    setBusy(false)
    if (error) return setError(authErrorText(error))
    await onDone()
  }

  const secret = uri ? (new URL(uri).searchParams.get("secret") ?? "") : ""
  return (
    <StepFrame
      title="Set up two-factor authentication"
      description="Required. Scan the code with an authenticator app such as 1Password or Google Authenticator."
    >
      {!uri ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void start(password)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="pw">Confirm your password</FieldLabel>
              <PasswordInput id="pw" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" className="justify-self-end" disabled={busy}>
              Continue
            </Button>
          </FieldGroup>
        </form>
      ) : (
        <Panel className="grid justify-items-center gap-4 p-pad-x">
          {qr && <img src={qr} alt="Two-factor QR code" className="size-48 rounded-sm bg-white p-2" />}
          <p className="text-center text-muted-foreground">
            Can't scan it? Enter this key:{" "}
            <code className="break-all text-ink" data-testid="totp-secret">
              {secret}
            </code>
          </p>
          <p className="font-semibold">Then enter the code it shows:</p>
          <TotpInput onComplete={(code) => void verify(code)} disabled={busy} />
        </Panel>
      )}
      {error && <FieldError>{error}</FieldError>}
    </StepFrame>
  )
}

function BackupKeyStep({ onDone }: { onDone: () => Promise<void> }) {
  const [privateKey, setPrivateKey] = useState("")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState("")

  async function generate() {
    try {
      const res = await api<{ privateKey: string }>("/admin/keys/backup", { method: "POST" })
      setPrivateKey(res.privateKey)
    } catch (e) {
      setError(describeError(e))
    }
  }
  async function confirm() {
    try {
      await api("/admin/keys/backup/confirm", { method: "POST" })
      await onDone()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <StepFrame
      title="Your backup key"
      description="Backups are encrypted with a key pair. The server keeps only the public half. Save the private key now: it is shown once, and without it no backup can be restored."
      actions={
        <Button variant="primary" disabled={!privateKey || !saved} onClick={() => void confirm()}>
          Continue
        </Button>
      }
    >
      {!privateKey ? (
        <Button className="justify-self-start" onClick={() => void generate()}>
          Generate key pair
        </Button>
      ) : (
        <Panel className="grid gap-3 p-pad-x">
          <pre
            className="overflow-x-auto rounded-sm bg-bg p-3 font-mono text-small whitespace-pre-wrap break-all"
            data-testid="private-key"
          >
            {privateKey}
          </pre>
          <Button className="justify-self-start" onClick={() => download("n8n-ops-backup-key.txt", `${privateKey}\n`)}>
            <Download /> Download key file
          </Button>
          <Field orientation="horizontal">
            <Checkbox id="saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
            <FieldLabel htmlFor="saved" className="font-normal">
              I saved the private key somewhere safe, such as a password manager
            </FieldLabel>
          </Field>
        </Panel>
      )}
      {error && <FieldError>{error}</FieldError>}
    </StepFrame>
  )
}

function OptionalStep({
  title,
  description,
  fields,
  section,
  onDone,
  onSkip,
}: {
  title: string
  description: string
  fields: { name: string; label: string; type?: string; placeholder?: string }[]
  section: string
  onDone: () => Promise<unknown>
  onSkip: () => void
}) {
  const [error, setError] = useState("")
  async function submit(form: FormData) {
    try {
      await api(`/settings/${section}`, { method: "PUT", json: Object.fromEntries(form.entries()) })
      await onDone()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <StepFrame
      title={title}
      description={description}
      actions={
        <>
          <Button variant="ghost" className="me-auto" onClick={onSkip}>
            Skip for now
          </Button>
          <Button type="submit" form={section} variant="primary">
            Save and continue
          </Button>
        </>
      }
    >
      <form
        id={section}
        onSubmit={(e) => {
          e.preventDefault()
          void submit(new FormData(e.currentTarget))
        }}
      >
        <FieldGroup>
          {fields.map((f) => (
            <Field key={f.name}>
              <FieldLabel htmlFor={f.name}>{f.label}</FieldLabel>
              <Input id={f.name} name={f.name} type={f.type ?? "text"} placeholder={f.placeholder} required />
            </Field>
          ))}
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
      </form>
    </StepFrame>
  )
}

function TelegramStep({ onDone, onSkip }: { onDone: () => Promise<void>; onSkip: () => void }) {
  return (
    <OptionalStep
      title="Telegram alerts"
      description="Where alerts go. Create a bot with @BotFather and add it to your chat or group. You can do this later in Settings."
      section="telegram"
      fields={[
        { name: "botToken", label: "Bot token", type: "password", placeholder: "123456:ABC…" },
        { name: "chatId", label: "Chat ID", placeholder: "-100…" },
      ]}
      onDone={onDone}
      onSkip={onSkip}
    />
  )
}

function StorageStep({ onDone, onSkip }: { onDone: () => Promise<void>; onSkip: () => void }) {
  return (
    <OptionalStep
      title="Backup storage"
      description="Any S3-compatible service. You can do this later in Settings."
      section="storage"
      fields={[
        { name: "endpoint", label: "Endpoint", placeholder: "https://s3.example.com" },
        { name: "bucket", label: "Bucket" },
        { name: "region", label: "Region", placeholder: "us-east-1" },
        { name: "accessKeyId", label: "Access key ID" },
        { name: "secretAccessKey", label: "Secret access key", type: "password" },
      ]}
      onDone={onDone}
      onSkip={onSkip}
    />
  )
}
