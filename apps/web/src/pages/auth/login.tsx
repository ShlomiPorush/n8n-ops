import { useRef, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { useApi } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { AuthFrame, TotpInput } from "./shared"

/** Where to go after signing in: the page that was asked for, if it is a page of this app (NL-18). */
function safeNext(next: string | null): string {
  if (!next || next.length > 2048 || !next.startsWith("/") || next.startsWith("//")) return "/"
  const path = new URL(next, window.location.origin).pathname
  return /^\/(login|setup|api)(\/|$)/.test(path) ? "/" : next
}

export function LoginPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const passwordRef = useRef<HTMLInputElement>(null)
  const status = useApi<{ hasUser: boolean }>("/setup/status")
  const [step, setStep] = useState<"password" | "totp">("password")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  if (status.data && !status.data.hasUser) return <Navigate to="/setup" replace />

  async function signIn(form: FormData) {
    setBusy(true)
    setError("")
    const { data, error } = await authClient.signIn.username({
      username: String(form.get("username")),
      password: String(form.get("password")),
    })
    setBusy(false)
    if (error) {
      // The username stays; the password is cleared for the next try.
      if (passwordRef.current) passwordRef.current.value = ""
      passwordRef.current?.focus()
      return setError(authErrorText(error))
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setStep("totp")
    // Signed in without two-factor: it must be set up before anything else.
    navigate("/setup", { replace: true })
  }

  async function verify(code: string) {
    setBusy(true)
    setError("")
    const { error } = await authClient.twoFactor.verifyTotp({ code })
    setBusy(false)
    if (error) return setError(authErrorText(error))
    navigate(next, { replace: true })
  }

  if (step === "totp")
    return (
      <AuthFrame title="Two-factor code" description="Enter the 6-digit code from your authenticator app.">
        <div className="grid justify-items-start gap-4">
          <TotpInput onComplete={(code) => void verify(code)} disabled={busy} />
          {error && <FieldError>{error}</FieldError>}
          <Button variant="link" onClick={() => setStep("password")}>
            Back
          </Button>
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame title="Welcome back" description="Sign in to n8n-ops.">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void signIn(new FormData(e.currentTarget))
        }}
      >
        <FieldGroup>
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
              {busy ? "Signing in…" : "Continue"}
            </Button>
            <FieldDescription>
              Locked out? Run <code>reset-password</code> inside the server container.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
    </AuthFrame>
  )
}
