import { Cpu as CpuIcon, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { useConfirm } from "@/components/confirm"
import { Copyable, Empty, LoadError, Loading, Page, Panel, PanelHead, UserText } from "@/components/kit"
import { HostMark } from "@/components/skin/marks"
import { StatusTag, TimeAgo, When } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useApi, useApiMutation } from "@/lib/api"
import { n, plural } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

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
  const confirm = useConfirm()
  const revoke = useApiMutation<string>("DELETE", (id) => `/workers/${id}`, {
    invalidate: ["/workers", "/overview/summary"],
  })
  async function askRevoke(w: Worker) {
    const ok = await confirm({
      title: `Revoke the Worker ${w.name}?`,
      message: `It stops being accepted at once and is removed from its ${plural(w.instances.length, "instance")}. Remove the container on the host too. This cannot be undone; pair it again to bring it back.`,
      confirmLabel: "Revoke worker",
      danger: true,
    })
    if (ok) revoke.mutate(w.id, { onSuccess: () => toast.success(`Worker ${w.name} revoked`) })
  }
  const list = workers.data ?? []
  const online = list.filter((w) => w.online).length
  return (
    <Page
      title="Workers"
      updatedAt={workers.dataUpdatedAt || undefined}
      description={
        workers.data && list.length
          ? `${n(online)} of ${n(list.length)} online. Agents on n8n Docker hosts: they back up credential secrets, move credentials and check endpoints only reachable on the host, over outbound HTTPS only.`
          : "Agents on n8n Docker hosts. They back up credential secrets, move credentials and check endpoints that are only reachable on the host. Outbound HTTPS only; no open ports."
      }
      actions={
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus /> Add worker
        </Button>
      }
    >
      {/* Regular sets each worker on a card of its own (#29); Compact lists them in one panel. */}
      <Panel className="regular:grid regular:gap-3 regular:overflow-visible regular:rounded-none regular:bg-transparent regular:shadow-none regular:ring-0">
        <PanelHead
          title="Paired Workers"
          count={workers.data ? n(list.length) : undefined}
          className="regular:px-0 regular:pt-0 regular:pb-0"
        />
        {workers.error ? (
          <LoadError what="workers" error={workers.error} retry={() => workers.refetch()} />
        ) : workers.isLoading ? (
          <Loading>Loading workers…</Loading>
        ) : list.length === 0 ? (
          <Empty title="No workers yet.">
            Without a worker, n8n-ops backs up workflows through the API, but not credential secrets.
          </Empty>
        ) : (
          list.map((w) => (
            <div
              key={w.id}
              className={cn(
                "grid gap-x-4 gap-y-1.5 border-t border-s-3 border-line px-pad-x py-3 md:grid-cols-[minmax(0,1fr)_auto]",
                "regular:max-w-3xl regular:rounded-lg regular:border-0 regular:bg-panel regular:p-5 regular:shadow-card regular:ring-1 regular:ring-ink/10",
                w.online ? "border-s-ok/55" : "border-s-fail",
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2 regular:gap-3">
                <HostMark />
                <UserText className="font-semibold regular:text-head">{w.name}</UserText>
                <StatusTag kind="worker" status={w.online ? "online" : "offline"} />
              </div>
              <div className="row-span-2 self-center max-md:order-last">
                <Button size="sm" variant="danger" onClick={() => void askRevoke(w)}>
                  <Trash2 /> Revoke
                </Button>
              </div>
              <div className="min-w-0 text-muted-foreground">
                <p>
                  Serves{" "}
                  {w.instances.length ? (
                    w.instances.map((i, idx) => (
                      <span key={i.id}>
                        {idx > 0 && ", "}
                        <Link to={`/instances/${i.id}`} className="font-semibold text-ink underline">
                          <UserText>{i.name}</UserText>
                        </Link>
                      </span>
                    ))
                  ) : (
                    <>no instances yet (assign it on the instance)</>
                  )}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-4 text-small regular:mt-3 regular:gap-x-0 regular:divide-x regular:divide-line regular:border-t regular:border-line regular:pt-3 regular:[&>span]:px-4 regular:[&>span:first-child]:ps-0">
                  <span>
                    Last seen <TimeAgo value={w.lastSeenAt} />
                  </span>
                  <span>
                    Version <span className="font-mono">{w.version ?? "unknown"}</span>
                  </span>
                  <span>
                    Paired <When value={w.createdAt} />
                  </span>
                </p>
              </div>
            </div>
          ))
        )}
      </Panel>
      <AddWorkerDialog open={open} onOpenChange={setOpen} />
    </Page>
  )
}

type Pairing = { token: string; compose: string; expiresInMinutes: number }

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{label}</span>
        <Copyable value={text} label={`Copy ${label}`} className="font-sans text-ctl font-semibold">
          Copy
        </Copyable>
      </div>
      <pre className="max-h-72 overflow-auto rounded-sm bg-fill p-4 font-mono text-small leading-relaxed">{text}</pre>
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
  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) {
      setResult(null)
      setName("")
      setContainers("")
      setSocketProxy(true)
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="md:max-w-2xl" keepOnBackdrop>
        <DialogHeader icon={CpuIcon}>
          <DialogTitle>Add a Worker</DialogTitle>
          <DialogDescription>
            {result
              ? `In an empty folder on the n8n Docker host, save this as docker-compose.yml and run docker compose up -d. The token in it works once and expires in ${result.expiresInMinutes} minutes.`
              : "Name it after the host it runs on."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid min-w-0 gap-4">
            <CopyBlock label="docker-compose.yml" text={result.compose} />
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
                placeholder="Docker Office"
                maxLength={60}
              />
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
        <DialogFooter>
          {result ? (
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!name.trim() || (socketProxy && containerList.length === 0) || create.isPending}
                onClick={() =>
                  create.mutate(
                    { name, socketProxy, containers: socketProxy ? containerList : [] },
                    { onSuccess: setResult },
                  )
                }
              >
                Create pairing token
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
