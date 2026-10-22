import { ShieldCheck } from "lucide-react"
import { useState } from "react"
import { Command, Page, Panel, PanelHead } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { PasswordInput } from "@/components/ui/password-input"
import { authClient, authErrorText } from "@/lib/auth-client"
import { toast } from "@/lib/toast"
import { SettingRow } from "@/pages/settings"

/** The signed-in person's own sign-in: password and two-factor. */
export function AccountPage() {
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
    <Page
      title="Account"
      description={`Your password and two-factor sign-in. Signed in as ${username ?? ""}.`}
      className="max-w-3xl"
    >
      <Panel>
        <PanelHead title="Sign-In" />
        <SettingRow label="Two-factor (TOTP)" hint="Required for this installation.">
          <span className="flex items-center gap-2 font-semibold text-ok">
            <ShieldCheck className="size-4" /> On
          </span>
        </SettingRow>
        <form
          className="grid gap-3 border-t border-line px-pad-x py-3 regular:border-t-0 regular:py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void changePassword(new FormData(e.currentTarget))
            e.currentTarget.reset()
          }}
        >
          <b className="font-semibold">Change Password</b>
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
      </Panel>
      <Panel>
        <PanelHead
          title="Locked Out?"
          description="Run this on the server, in the n8n-ops folder. It prints a new password, signs out every session and turns two-factor off; you set it up again at the next sign-in."
        />
        <div className="px-pad-x pb-4">
          <Command
            value="docker compose exec -u node server node dist/cli.js reset-password"
            label="Copy the command"
          />
        </div>
      </Panel>
    </Page>
  )
}
