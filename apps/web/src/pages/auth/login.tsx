import { useState } from "react"
import { Navigate, useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useApi } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { AuthFrame, TotpInput } from "./shared"

export function LoginPage() {
  const navigate = useNavigate()
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
    if (error) return setError(authErrorText(error))
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
    navigate("/", { replace: true })
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
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
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
