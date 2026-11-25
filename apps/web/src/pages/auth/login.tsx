import { Clock, Fingerprint, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { UNREACHABLE_TEXT, useApi } from "@/lib/api"
import { authClient, authErrorText, signInErrorText } from "@/lib/auth-client"
import { passkeyBlock, passkeyCancelled } from "@/lib/passkeys"
import { endedTexts } from "@/lib/session-clock"
import { AuthFrame, type TotpAnswer, TotpInput, totpAnswer } from "./shared"

function safeNext(next: string | null): string {
  if (!next || next.length > 2048 || !next.startsWith("/") || next.startsWith("//")) return "/"
  const path = new URL(next, window.location.origin).pathname
  return /^\/(login|setup|api)(\/|$)/.test(path) ? "/" : next
}

export function LoginPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const reason = params.get("ended") ?? ""
  const ended = Object.hasOwn(endedTexts, reason) ? endedTexts[reason] : undefined
  const passwordRef = useRef<HTMLInputElement>(null)
  const status = useApi<{ hasUser: boolean; passkeys: string | null }>("/setup/status")
  const passkeys = status.data && !passkeyBlock(status.data.passkeys)
  const [step, setStep] = useState<"password" | "totp">("password")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = "Sign In · n8n-ops"
  }, [])

  if (status.data && !status.data.hasUser) return <Navigate to="/setup" replace />

  async function signIn(form: FormData) {
    setBusy(true)
    setError("")
    try {
      const { data, error } = await authClient.signIn.username({
        username: String(form.get("username")),
        password: String(form.get("password")),
      })
      if (error) {
        if (error.status && passwordRef.current) {
          passwordRef.current.value = ""
          passwordRef.current.focus()
        }
        return setError(signInErrorText(error))
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setStep("totp")
      navigate("/setup", { replace: true })
    } catch {
      setError(UNREACHABLE_TEXT)
    } finally {
      setBusy(false)
    }
  }

  async function signInWithPasskey() {
    setBusy(true)
    setError("")
    try {
      const { data, error } = await authClient.signIn.passkey()
      if (error) {
        const e = error as { code?: string; status?: number; message?: string }
        if (passkeyCancelled(e.code)) return setError("Passkey sign-in was cancelled or timed out.")
        if (e.status === 429 || !e.status) return setError(authErrorText(e))
        if (e.status >= 500) return setError("Could not sign in. Try again in a moment.")
        return setError("This passkey did not sign you in. Try another one, or your password.")
      }
      const u = (data as { user?: { twoFactorEnabled?: boolean | null } } | null)?.user
      navigate(u?.twoFactorEnabled ? next : "/setup", { replace: true })
    } catch {
      setError(UNREACHABLE_TEXT)
    } finally {
      setBusy(false)
    }
  }

  async function verify(code: string): Promise<TotpAnswer> {
    setBusy(true)
    setError("")
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code })
      if (error) {
        setError(authErrorText(error))
        return totpAnswer(error)
      }
      navigate(next, { replace: true })
      return "done"
    } catch {
      setError(UNREACHABLE_TEXT)
      return "unreached"
    } finally {
      setBusy(false)
    }
  }

  if (step === "totp")
    return (
      <AuthFrame title="Two-Factor Code" description="Enter the 6-digit code from your authenticator app.">
        <div className="grid justify-items-start gap-4">
          <TotpInput onSubmit={verify} disabled={busy} error={error} />
          <Button variant="link" onClick={() => setStep("password")}>
            Back
          </Button>
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame title="Welcome Back" description="Sign in to n8n-ops.">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void signIn(new FormData(e.currentTarget))
        }}
      >
        <FieldGroup>
          {ended && (
            <Alert variant="info">
              <Clock />
              <AlertDescription>{ended}</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="username">Username</FieldLabel>
            <Input id="username" name="username" autoComplete="username" required autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <PasswordInput ref={passwordRef} id="password" name="password" autoComplete="current-password" required />
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Field>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle aria-hidden className="animate-spin" /> Signing in…
                </>
              ) : (
                "Continue"
              )}
            </Button>
            {passkeys && (
              <Button type="button" disabled={busy} onClick={() => void signInWithPasskey()}>
                <Fingerprint aria-hidden /> Sign in with a passkey
              </Button>
            )}
            <FieldDescription>
              Locked out? On the server, run:{" "}
              <code className="break-all">docker compose exec -u node server node dist/cli.js reset-password</code>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
    </AuthFrame>
  )
}
