import { Fingerprint, Pencil, Trash2 } from "lucide-react"
import { useState } from "react"
import { useConfirm } from "@/components/confirm"
import { BusyButton, Empty, LoadError, Panel, PanelHead, Row, UserText } from "@/components/kit"
import { When } from "@/components/status"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { UNREACHABLE_TEXT, useApi } from "@/lib/api"
import { authClient, authErrorText } from "@/lib/auth-client"
import { passkeyBlock, passkeyCancelled } from "@/lib/passkeys"
import { toast } from "@/lib/toast"

type Passkey = { id: string; name?: string | null; createdAt?: string | Date | null }
type AuthError = { code?: string; status?: number; message?: string }

/** The sentence for a passkey change that failed. */
function failure(error: AuthError): string {
  if (error.code === "SESSION_NOT_FRESH") return "Sign in again to add a passkey: your sign-in is more than a day old."
  if (passkeyCancelled(error.code)) return "The passkey prompt was closed or timed out."
  if (error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "This passkey is already added."
  return authErrorText(error)
}

/**
 * The signed-in person's passkeys: each one signs in alone, in place of the password and the two-factor code. A
 * passkey belongs to the public URL's host name, so the panel says when it cannot be added from this page.
 */
export function PasskeysPanel() {
  const status = useApi<{ passkeys: string | null }>("/setup/status")
  const block = status.data ? passkeyBlock(status.data.passkeys) : null
  const list = authClient.useListPasskeys()
  const confirm = useConfirm()
  const [name, setName] = useState("")
  const [renaming, setRenaming] = useState<Passkey | null>(null)
  const passkeys = (list.data ?? []) as Passkey[]

  // The button shows how it went (FB-7); the toast says why it failed.
  async function add() {
    let error: AuthError | null = null
    try {
      ;({ error } = await authClient.passkey.addPasskey({ name: name.trim() || undefined }))
    } catch {
      error = { message: UNREACHABLE_TEXT }
    }
    if (error) {
      toast.error(`Passkey not added: ${error.status ? failure(error) : UNREACHABLE_TEXT}`)
      throw new Error("passkey not added")
    }
    setName("")
    toast.success("Passkey added. You can sign in with it now.")
  }

  async function remove(p: Passkey) {
    const ok = await confirm({
      title: `Delete the passkey ${p.name || "without a name"}?`,
      message: "It no longer signs in to n8n-ops. Your password and two-factor code still work.",
      confirmLabel: "Delete passkey",
      danger: true,
    })
    if (!ok) return
    try {
      const { error } = await authClient.passkey.deletePasskey({ id: p.id })
      if (error) return toast.error(`Passkey not deleted: ${failure(error as AuthError)}`)
      toast.success("Passkey deleted")
    } catch {
      toast.error(`Passkey not deleted: ${UNREACHABLE_TEXT}`)
    }
  }

  return (
    <Panel>
      <PanelHead
        title="Passkeys"
        count={list.data ? passkeys.length : undefined}
        description="Sign in with your fingerprint, face or device PIN, in place of the password and the two-factor code."
      />
      {/* "No passkeys" only from a list that loaded: a failed load is said, with a retry. */}
      {list.error && !list.data ? (
        <LoadError error={list.error} retry={() => void list.refetch()} what="your passkeys" />
      ) : passkeys.length === 0 ? (
        list.isPending ? null : (
          <Empty icon={Fingerprint} title="No passkeys yet" className="border-t border-line regular:border-t-0" />
        )
      ) : (
        passkeys.map((p) => (
          <Row key={p.id}>
            <Fingerprint aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 font-semibold">
              {p.name ? <UserText>{p.name}</UserText> : <span className="text-muted-foreground">No name</span>}
            </span>
            <span className="text-small text-muted-foreground">
              Added <When value={p.createdAt ?? null} />
            </span>
            <span className="ms-auto flex gap-2">
              <Button size="sm" onClick={() => setRenaming(p)} aria-label={`Rename ${p.name || "passkey"}`}>
                <Pencil aria-hidden /> Rename
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void remove(p)}
                aria-label={`Delete ${p.name || "passkey"}`}
              >
                <Trash2 aria-hidden /> Delete
              </Button>
            </span>
          </Row>
        ))
      )}
      <div className="grid gap-3 border-t border-line px-pad-x py-3 regular:border-t-0 regular:py-4">
        <b className="font-semibold">Add a Passkey</b>
        {status.error && !status.data ? (
          <LoadError error={status.error} retry={() => void status.refetch()} what="where passkeys work" />
        ) : block ? (
          <p className="text-muted-foreground" data-testid="passkey-block">
            {block}
          </p>
        ) : (
          // The name and its button on one line; on a narrow screen the button goes under the field.
          <form
            onSubmit={(e) => {
              e.preventDefault()
            }}
          >
            <Field>
              <FieldLabel htmlFor="passkey-name">Name</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="passkey-name"
                  className="max-w-sm min-w-48 flex-1"
                  value={name}
                  maxLength={64}
                  placeholder="Work laptop"
                  aria-describedby="passkey-name-hint"
                  onChange={(e) => setName(e.target.value)}
                />
                <BusyButton type="submit" run={add} busyLabel="Adding…" icon={Fingerprint} disabled={!status.data}>
                  Add passkey
                </BusyButton>
              </div>
              <FieldDescription id="passkey-name-hint">So you can tell your passkeys apart.</FieldDescription>
            </Field>
          </form>
        )}
      </div>
      {renaming && <RenameDialog passkey={renaming} onClose={() => setRenaming(null)} />}
    </Panel>
  )
}

function RenameDialog({ passkey, onClose }: { passkey: Passkey; onClose: () => void }) {
  const [name, setName] = useState(passkey.name ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save() {
    setBusy(true)
    setError("")
    try {
      const { error } = await authClient.passkey.updatePasskey({ id: passkey.id, name: name.trim() })
      if (error) return setError(failure(error as AuthError))
      toast.success("Passkey renamed")
      onClose()
    } catch {
      setError(UNREACHABLE_TEXT)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:max-w-[480px]">
        <DialogHeader icon={Pencil}>
          <DialogTitle>Rename Passkey</DialogTitle>
          <DialogDescription>The name is only for you, to tell your passkeys apart.</DialogDescription>
        </DialogHeader>
        <form
          id="passkey-rename"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field>
            <FieldLabel htmlFor="passkey-rename-name">Name</FieldLabel>
            <Input
              id="passkey-rename-name"
              value={name}
              required
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {error && <FieldError>{error}</FieldError>}
        </form>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <BusyButton type="submit" form="passkey-rename" variant="primary" busy={busy} busyLabel="Saving…">
            Save
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
