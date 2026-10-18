import {
  CalendarCheck,
  Clock,
  Copy,
  Cpu,
  type LucideIcon,
  Plus,
  Server,
  Tag,
  Trash2,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { Page } from "@/app/shell"
import { DialogIcon } from "@/components/dialog-icon"
import { EmptyState } from "@/components/empty-state"
import { Dot, TimeAgo, Tone } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
        <div className="grid gap-4 lg:grid-cols-2">
          {workers.data.map((w) => (
            <Card key={w.id} className="gap-0 py-0">
              <div className="flex items-start gap-4 p-5">
                <div className="relative grid size-11 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground">
                  <Cpu className="size-5" />
                  <Dot health={w.online ? "ok" : "down"} className="absolute -top-0.5 -right-0.5" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-lg font-semibold tracking-tight">{w.name}</span>
                    <Tone tone={w.online ? "green" : "red"} icon={w.online ? Wifi : WifiOff}>
                      {w.online ? "online" : "offline"}
                    </Tone>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                    Serves
                    {w.instances.length ? (
                      w.instances.map((i) => (
                        <Link key={i.id} to={`/instances/${i.id}`}>
                          <Badge variant="outline" className="hover:bg-muted">
                            <Server /> {i.name}
                          </Badge>
                        </Link>
                      ))
                    ) : (
                      <span>no instances yet (assign it on the instance)</span>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(w)}>
                  <Trash2 /> Revoke
                </Button>
              </div>
              <div className="grid grid-cols-3 divide-x border-t text-sm">
                <WorkerFact icon={Clock} label="Last seen" value={<TimeAgo value={w.lastSeenAt} />} />
                <WorkerFact
                  icon={Tag}
                  label="Version"
                  value={<span className="font-mono text-xs">{w.version ?? "unknown"}</span>}
                />
                <WorkerFact icon={CalendarCheck} label="Paired" value={new Date(w.createdAt).toLocaleDateString()} />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Cpu}
          title="No workers yet"
          description="Without a worker, n8n-ops backs up workflows through the API, but not credential secrets."
        />
      )}
      <AddWorkerDialog open={open} onOpenChange={setOpen} />
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon icon={TriangleAlert} tone="red" />
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              It stops being accepted immediately and is removed from its instances. Remove the container on the host
              too.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
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

type Pairing = { token: string; compose: string; commands: string; expiresInMinutes: number }

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}
        >
          <Copy /> Copy
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  )
}

function AddWorkerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("")
  const [socketProxy, setSocketProxy] = useState(true)
  const [containers, setContainers] = useState("")
  const [result, setResult] = useState<Pairing | null>(null)
  const create = useApiMutation<{ name: string; socketProxy: boolean; containers: string[] }, Pairing>(
    "POST",
    "/workers/pairing",
  )
  const containerList = containers.split(/[\s,]+/).filter(Boolean)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setResult(null)
          setName("")
          setContainers("")
          setSocketProxy(true)
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogIcon icon={Cpu} />
          <DialogTitle>Add a worker</DialogTitle>
          <DialogDescription>
            {result
              ? `Run this on the n8n Docker host. The token works once and expires in ${result.expiresInMinutes} minutes.`
              : "Name it after the host it runs on."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="min-w-0 space-y-4">
            <CopyBlock label="1. Commands" text={result.commands} />
            <CopyBlock label="2. docker-compose.yml" text={result.compose} />
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
            <Field orientation="horizontal">
              <Checkbox id="worker-proxy" checked={socketProxy} onCheckedChange={(v) => setSocketProxy(v === true)} />
              <FieldContent>
                <FieldLabel htmlFor="worker-proxy">Limit Docker access with a socket proxy</FieldLabel>
                <FieldDescription>
                  Recommended. The worker gets no Docker socket; a proxy lets it run commands only in the n8n containers
                  you list. Without it, the worker has full control of Docker on the host.
                </FieldDescription>
              </FieldContent>
            </Field>
            {socketProxy && (
              <Field>
                <FieldLabel htmlFor="worker-containers">n8n containers</FieldLabel>
                <Input
                  id="worker-containers"
                  value={containers}
                  onChange={(e) => setContainers(e.target.value)}
                  placeholder="n8n1, n8n2, flow"
                />
                <FieldDescription>
                  Container names on this host, separated by commas. Use * to also cover containers added later, for
                  example <code>n8n*</code>; a plain list is tighter, but a new container then needs to be added to
                  docker-compose.yml.
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
        )}
        {!result && (
          <DialogFooter>
            <Button
              disabled={!name || (socketProxy && containerList.length === 0) || create.isPending}
              onClick={() =>
                create.mutate(
                  { name, socketProxy, containers: socketProxy ? containerList : [] },
                  { onSuccess: setResult },
                )
              }
            >
              Create pairing token
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function WorkerFact({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5 px-5 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="font-medium">{value}</div>
    </div>
  )
}
