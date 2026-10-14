import { useQueryClient } from "@tanstack/react-query"
import { Check, Download } from "lucide-react"
import QRCode from "qrcode"
import { useEffect, useState } from "react"
import { Navigate, useNavigate } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ApiError, api, describeError, useApi } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { download } from "@/lib/download"
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

  if (status.isLoading || checklist.isLoading) return <AuthFrame>{null}</AuthFrame>
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
      <ol className="flex flex-wrap justify-center gap-1.5">
        {steps.map((s, i) => (
          <li key={s}>
            <Badge variant={i === index ? "default" : i < index ? "secondary" : "outline"}>
              {i < index && <Check />}
              {s}
            </Badge>
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
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          n8n-ops has one user. Two-factor authentication is set up next and is required.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm">Repeat password</FieldLabel>
              <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button type="submit" form="account" disabled={busy}>
          Create account
        </Button>
      </CardFooter>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Set up two-factor authentication</CardTitle>
        <CardDescription>
          Required. Scan the code with an authenticator app such as 1Password or Google Authenticator.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        {!uri ? (
          <form
            className="w-full"
            onSubmit={(e) => {
              e.preventDefault()
              void start(password)
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="pw">Confirm your password</FieldLabel>
                <Input
                  id="pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" disabled={busy}>
                Continue
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <>
            {qr && <img src={qr} alt="Two-factor QR code" className="size-48 rounded-md border bg-white p-2" />}
            <p className="text-center text-sm text-muted-foreground">
              Can't scan it? Enter this key:{" "}
              <code className="font-mono break-all" data-testid="totp-secret">
                {secret}
              </code>
            </p>
            <p className="text-sm">Then enter the code it shows:</p>
            <TotpInput onComplete={(code) => void verify(code)} disabled={busy} />
          </>
        )}
        {error && <FieldError>{error}</FieldError>}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Your backup key</CardTitle>
        <CardDescription>
          Backups are encrypted with a key pair. The server keeps only the public half. Save the private key now: it is
          shown once, and without it no backup can be restored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!privateKey ? (
          <Button onClick={() => void generate()}>Generate key pair</Button>
        ) : (
          <>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="private-key">
              {privateKey}
            </pre>
            <Button variant="outline" onClick={() => download("n8n-ops-backup-key.txt", `${privateKey}\n`)}>
              <Download /> Download key file
            </Button>
            <Field orientation="horizontal">
              <Checkbox id="saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
              <FieldLabel htmlFor="saved" className="font-normal">
                I saved the private key somewhere safe, such as a password manager
              </FieldLabel>
            </Field>
          </>
        )}
        {error && <FieldError>{error}</FieldError>}
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button disabled={!privateKey || !saved} onClick={() => void confirm()}>
          Continue
        </Button>
      </CardFooter>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
      <CardFooter className="justify-between border-t">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button type="submit" form={section}>
          Save and continue
        </Button>
      </CardFooter>
    </Card>
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
