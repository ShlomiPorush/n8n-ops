import { Copy, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Page } from "@/app/shell"
import { Dot, TimeAgo, Tone } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useApi, useApiMutation } from "@/lib/api"

export type Worker = {
  id: string
  name: string
  version: string | null
  lastSeenAt: string | null
  createdAt: string
  online: boolean
  instances: { id: string; name: string }[]
}

export function WorkersPage() {
  const workers = useApi<Worker[]>("/workers", { refetchInterval: 10_000 })
  const [open, setOpen] = useState(false)
  const [revoking, setRevoking] = useState<Worker | null>(null)
  const revoke = useApiMutation<string>("DELETE", (id) => `/workers/${id}`, {
    invalidate: ["/workers", "/overview/summary"],
    success: "Worker revoked",
  })
  return (
    <Page
      title="Workers"
      description="Agents on n8n Docker hosts. They back up credential secrets, move credentials and check endpoints that are only reachable on the host. Outbound HTTPS only; no open ports."
      actions={
        <Button onClick={() => setOpen(true)}>
          <Plus /> Add worker
        </Button>
      }
    >
      {workers.isLoading ? (
        <Skeleton className="h-32" />
      ) : workers.data?.length ? (
        <div className="space-y-4">
          {workers.data.map((w) => (
            <Card key={w.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Dot health={w.online ? "ok" : "down"} />
                  {w.name}
                  <Tone tone={w.online ? "green" : "red"}>{w.online ? "online" : "offline"}</Tone>
                </CardTitle>
                <CardDescription>
                  Serves{" "}
                  {w.instances.length
                    ? w.instances.map((i) => i.name).join(", ")
                    : "no instances yet (assign it on the instance)"}
                </CardDescription>
                <CardAction>
                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRevoking(w)}>
                    <Trash2 /> Revoke
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
                <div>
                  <div className="text-muted-foreground">Last seen</div>
                  <TimeAgo value={w.lastSeenAt} />
                </div>
                <div>
                  <div className="text-muted-foreground">Version</div>
                  {w.version ?? "unknown"}
                </div>
                <div>
                  <div className="text-muted-foreground">Paired</div>
                  {new Date(w.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>No workers yet</CardTitle>
            <CardDescription>
              Without a worker, n8n-ops backs up workflows through the API, but not credential secrets.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      <AddWorkerDialog open={open} onOpenChange={setOpen} />
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              It stops being accepted immediately and is removed from its instances. Remove the container on the host
              too.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}

function AddWorkerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("")
  const [result, setResult] = useState<{ token: string; command: string; expiresInMinutes: number } | null>(null)
  const create = useApiMutation<{ name: string }, { token: string; command: string; expiresInMinutes: number }>(
    "POST",
    "/workers/pairing",
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setResult(null)
          setName("")
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a worker</DialogTitle>
          <DialogDescription>
            {result
              ? `Run this on the n8n Docker host. The token works once and expires in ${result.expiresInMinutes} minutes.`
              : "Name it after the host it runs on."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">
              {result.command}
            </pre>
            <p className="text-sm text-muted-foreground">
              To keep the token out of the command line, write it to <code>/srv/n8n-ops-worker/pairing-token</code>{" "}
              instead of passing <code>PAIRING_TOKEN</code>.
            </p>
            <pre className="hidden" data-testid="pairing-token">
              {result.token}
            </pre>
          </div>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="worker-name">Name</FieldLabel>
              <Input
                id="worker-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="docker-host-1"
              />
              <FieldDescription>Letters, digits, dot, dash and underscore.</FieldDescription>
            </Field>
          </FieldGroup>
        )}
        <DialogFooter>
          {result ? (
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(result.command).then(() => toast.success("Copied"))}
            >
              <Copy /> Copy command
            </Button>
          ) : (
            <Button
              disabled={!name || create.isPending}
              onClick={() => create.mutate({ name }, { onSuccess: setResult })}
            >
              Create pairing token
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
