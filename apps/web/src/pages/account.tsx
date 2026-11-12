import { ChevronRight, KeyRound, RotateCcw, ShieldCheck } from "lucide-react"
import { type RefObject, useRef, useState } from "react"
import { useDiscardGuard } from "@/components/discard-guard"
import { BusyButton, Command, Page, Panel, PanelHead } from "@/components/kit"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { PasswordInput } from "@/components/ui/password-input"
import { authClient, authErrorText } from "@/lib/auth-client"
import { toast } from "@/lib/toast"
import { clearTwoFactorReset, markTwoFactorReset } from "@/lib/two-factor-reset"
import { PasskeysPanel } from "@/pages/account-passkeys"
import { SettingRow } from "@/pages/settings"

/** The signed-in person's own sign-in: password, two-factor and passkeys. */
export function AccountPage() {
  const session = authClient.useSession()
  const [changing, setChanging] = useState(false)
  const [resetting, setResetting] = useState(false)
  // The dialogs have no trigger of their own, so each gives the focus back to the button that opened it.
  const resetButton = useRef<HTMLButtonElement>(null)
  const changeButton = useRef<HTMLButtonElement>(null)
  const username = (session.data?.user as { username?: string } | undefined)?.username
  return (
    <Page
      title="Account"
      description={`Your password, two-factor sign-in and passkeys.${username ? ` Signed in as ${username}.` : ""}`}
      className="max-w-3xl"
    >
      <Panel>
        <PanelHead title="Sign-In" />
        <SettingRow
          label="Two-factor (TOTP)"
          hint="Required for this installation. Reset it for a new authenticator app."
        >
          <span className="flex items-center gap-2 font-semibold text-ok">
            <ShieldCheck className="size-4" /> On
          </span>
          <Button ref={resetButton} size="sm" className="ms-2" onClick={() => setResetting(true)}>
            <RotateCcw aria-hidden /> Reset
          </Button>
        </SettingRow>
        <SettingRow label="Password" hint="At least 12 characters. Changing it signs out your other sessions.">
          <Button ref={changeButton} size="sm" onClick={() => setChanging(true)}>
            <KeyRound aria-hidden /> Change password
          </Button>
        </SettingRow>
        <ForgotPassword />
      </Panel>
      <PasskeysPanel />
      {changing && <ChangePasswordDialog opener={changeButton} onClose={() => setChanging(false)} />}
      {resetting && <ResetTwoFactorDialog opener={resetButton} onClose={() => setResetting(false)} />}
    </Page>
  )
}

/**
 * What to do without the password, folded away (AX-12): on this page it only helps someone who is still signed in,
 * such as on another device, so it does not take the room of the things done here.
 */
function ForgotPassword() {
  return (
    <details className="group/fold border-t border-line regular:border-t-0">
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 px-pad-x py-3 text-start font-semibold select-none focus-visible:outline-offset-[-2px] regular:py-4 [@media(hover:hover)]:hover:bg-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-150 group-open/fold:rotate-90"
        />
        Forgot your password?
      </summary>
      <div className="grid gap-3 px-pad-x pb-4">
        <p className="max-w-[75ch] text-muted-foreground">
          Run this on the server, in the n8n-ops folder. It prints a new password, signs out every session and turns
          two-factor off; you set it up again at the next sign-in. Your passkeys stay, and sign in again once two-factor
          is set up.
        </p>
        <Command value="docker compose exec -u node server node dist/cli.js reset-password" label="Copy the command" />
      </div>
    </details>
  )
}

/** A dialog of this page and the button that opened it. */
type Opened = { opener: RefObject<HTMLButtonElement | null>; onClose: () => void }

/** Closed, the focus goes back to the button that opened the dialog, where a keyboard user left off. */
const backTo = (opener: Opened["opener"]) => (e: Event) => {
  e.preventDefault()
  opener.current?.focus()
}

/**
 * The fields are emptied only once the change worked: a failure keeps what was typed for another try, and the
 * button comes back also when the request never reached the server (FS-23).
 */
function ChangePasswordDialog({ opener, onClose }: Opened) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const guard = useDiscardGuard(current !== "" || next !== "", onClose)
  async function change() {
    setBusy(true)
    setError("")
    try {
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      })
      if (error) return setError(`Password not changed: ${authErrorText(error)}`)
      toast.success("Password changed. Other sessions were signed out.")
      void guard.requestClose("saved")
    } catch {
      setError(`Password not changed: ${authErrorText({ status: 0 })}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent keepOnBackdrop className="md:max-w-[480px]" onCloseAutoFocus={backTo(opener)}>
        <DialogHeader icon={KeyRound}>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>Your other sessions are signed out; this one stays.</DialogDescription>
        </DialogHeader>
        <form
          id="change-password"
          onSubmit={(e) => {
            e.preventDefault()
            void change()
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="current">Current password</FieldLabel>
              <PasswordInput
                id="current"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="next">New password</FieldLabel>
              <PasswordInput
                id="next"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                minLength={12}
                autoComplete="new-password"
                required
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button onClick={() => void guard.requestClose()}>Cancel</Button>
          <BusyButton type="submit" form="change-password" variant="primary" busy={busy} busyLabel="Changing…">
            Change password
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A new authenticator app: the other sessions are signed out first, so none of them goes on without two-factor;
 * then two-factor is turned off, and the page loads /setup afresh, where the server's answer decides what comes
 * next. Turned off, the person sets up a new code there and comes back to this page (lib/two-factor-reset.ts);
 * still on, they stay in the console; a session that was lost on the way goes to sign-in.
 */
function ResetTwoFactorDialog({ opener, onClose }: Opened) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const guard = useDiscardGuard(password !== "", onClose)
  async function reset() {
    setBusy(true)
    setError("")
    let leaving = false
    try {
      let first: { status?: number; message?: string } | null = null
      try {
        ;({ error: first } = await authClient.revokeOtherSessions())
      } catch {
        first = { status: 0 }
      }
      if (first)
        return setError(
          `Two-factor was not reset and is still on. Some or all of your other sessions may be signed out already. ${authErrorText(first)}`,
        )
      markTwoFactorReset()
      let second: { status?: number; message?: string } | null = null
      try {
        ;({ error: second } = await authClient.twoFactor.disable({ password }))
      } catch {
        second = { status: 0 }
      }
      // Refused: nothing changed. Any other answer, or none, may have turned it off.
      if (second?.status && second.status < 500) {
        clearTwoFactorReset()
        return setError(`Two-factor was not reset and is still on: ${authErrorText(second)}`)
      }
      leaving = true
      window.location.assign("/setup")
    } finally {
      if (!leaving) setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent keepOnBackdrop className="md:max-w-[480px]" onCloseAutoFocus={backTo(opener)}>
        <DialogHeader icon={RotateCcw}>
          <DialogTitle>Reset Two-Factor</DialogTitle>
          <DialogDescription>
            For a new phone or a lost authenticator app. Your other sessions are signed out, two-factor is turned off,
            and you set it up again right away with a new code. Your passkeys stay.
          </DialogDescription>
        </DialogHeader>
        <form
          id="reset-two-factor"
          onSubmit={(e) => {
            e.preventDefault()
            void reset()
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="reset-password">Your password</FieldLabel>
              <PasswordInput
                id="reset-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button onClick={() => void guard.requestClose()}>Cancel</Button>
          <BusyButton type="submit" form="reset-two-factor" variant="danger" busy={busy} busyLabel="Resetting…">
            Reset two-factor
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
