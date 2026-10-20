import { ChevronRight, KeySquare as KeySquareIcon, Plus, Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { useConfirm } from "@/components/confirm"
import {
  Command,
  Copyable,
  Empty,
  LoadError,
  Loading,
  Locked,
  Page,
  Panel,
  PanelHead,
  UserText,
} from "@/components/kit"
import { When } from "@/components/status"
import { Badge } from "@/components/ui/badge"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useApi, useApiMutation } from "@/lib/api"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

type Token = {
  id: string
  name: string
  kind: "mcp" | "rest" | "agent"
  canRequestAccess: boolean
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  connectedVia: "browser" | "code" | null
  redirectHost: string | null
  approvedBy: string | null
}

/** The agents and scripts that use n8n-ops: how to connect one, the ones connected, and tokens made by hand. */
export function AgentsPage() {
  return (
    <Page
      title="Connected agents"
      description="Agents and scripts that read n8n-ops. Each one connects only once you approve it, and you can disconnect it here at any time."
      className="max-w-5xl"
    >
      <ConnectCard />
      <AgentsCard />
    </Page>
  )
}

/** How an agent connects, one tab per kind of agent. Needs the public URL. */
function ConnectCard() {
  const general = useApi<{ publicUrl: string }>("/settings/general")
  const base = (general.data?.publicUrl ?? "").replace(/\/+$/, "")
  if (general.isLoading) return null
  if (!base)
    return (
      <Locked title="Set the public URL first" to="/settings/general" action="Open General">
        Agents connect to the address people open. Set it in Settings → General, then come back here.
      </Locked>
    )
  return (
    <Panel>
      <PanelHead
        title="Connect an agent"
        description="The agent asks, you approve it in this browser, and it appears below. Nothing to create or paste by hand."
      />
      <Tabs defaultValue="skill" className="px-pad-x pb-5">
        <TabsList aria-label="Kind of agent">
          <TabsTrigger value="skill">Coding agent</TabsTrigger>
          <TabsTrigger value="mcp">MCP client</TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
        </TabsList>
        <TabsContent value="skill" className="grid gap-3">
          <p className="max-w-[75ch]">
            For T3 Code, Claude Code, Codex and other agents that run commands. Paste this to the agent: it installs the
            n8n-ops skill and shows you a link and a code to approve.
          </p>
          {base.startsWith("https://") ? (
            <Command
              value={`Install the n8n-ops skill into your personal skills folder as described at ${base}/connect/skill/, then connect to n8n-ops.`}
              label="Copy the sentence for the agent"
            />
          ) : (
            <p className="text-muted-foreground">
              Agents download the skill from n8n-ops, so its public URL must start with https://.
            </p>
          )}
          <p className="text-small text-muted-foreground">Each agent you install it in connects on its own.</p>
        </TabsContent>
        <TabsContent value="mcp" className="grid gap-3">
          <p className="max-w-[75ch]">
            For apps that add MCP servers, such as Cursor or Claude Code. Add this address as an MCP server; a browser
            opens here to approve it.
          </p>
          <Labelled label="MCP address">
            <Command value={`${base}/mcp`} label="Copy the MCP address" />
          </Labelled>
          <Labelled label="In Claude Code">
            <Command
              value={`claude mcp add --transport http n8n-ops ${base}/mcp`}
              label="Copy the Claude Code command"
            />
          </Labelled>
        </TabsContent>
        <TabsContent value="script" className="grid gap-3">
          <p className="max-w-[75ch]">
            For your own programs. Ask for a code, open the link it returns and approve, then fetch the tokens with the
            device code. The README shows the whole exchange.
          </p>
          <Command
            value={`curl -s ${base}/oauth/device -d client_id=n8n-ops-cli -d resource=${base}/api/v1 -d "scope=ops:read offline_access"`}
            label="Copy the command"
          />
        </TabsContent>
      </Tabs>
    </Panel>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-small font-semibold">{label}</span>
      {children}
    </div>
  )
}

function AgentsCard() {
  const tokens = useApi<Token[]>("/admin/tokens")
  const confirm = useConfirm()
  const revoke = useApiMutation<string>("DELETE", (id) => `/admin/tokens/${id}`, {
    invalidate: ["/admin/tokens"],
  })
  async function askRevoke(t: Token) {
    const agent = t.kind === "agent"
    const ok = await confirm({
      title: agent ? `Disconnect ${t.name}?` : `Revoke the token ${t.name}?`,
      message: agent
        ? "It loses access at once, with any n8n instance access it holds. It can connect again only with a new approval."
        : "The agent or script using it loses access at once. This cannot be undone; create a new token to give access again.",
      confirmLabel: agent ? "Disconnect" : "Revoke token",
      danger: true,
    })
    if (ok)
      revoke.mutate(t.id, {
        onSuccess: () => toast.success(agent ? `${t.name} disconnected` : `Token ${t.name} revoked`),
      })
  }
  const list = tokens.data ?? []
  return (
    <>
      <Panel>
        <PanelHead
          title="Agents and tokens"
          count={tokens.data ? list.length : undefined}
          description="Each can read n8n-ops; some may also ask for temporary access to an n8n instance, which a person approves each time."
        />
        {tokens.error ? (
          <LoadError what="tokens" error={tokens.error} retry={() => tokens.refetch()} />
        ) : tokens.isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty title="No agent is connected.">Connect one above; it appears here once you approve it.</Empty>
        ) : (
          <Table bare>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Rights</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead className="text-end">Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-semibold">
                    <UserText>{t.name}</UserText>{" "}
                    {t.kind === "agent" ? (
                      <span className="text-meta font-normal text-muted-foreground">
                        {t.connectedVia === "code" ? "with a code" : "through the browser"}
                        {t.redirectHost ? ` · ${t.redirectHost}` : ""}
                      </span>
                    ) : (
                      <span className="font-mono text-meta font-normal text-muted-foreground">{t.prefix}…</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="line">
                        {t.kind === "agent" ? "read" : t.kind === "mcp" ? "MCP token · read" : "REST token · read"}
                      </Badge>
                      {t.canRequestAccess && <Badge variant="line">may request access</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <When value={t.createdAt} />
                    {t.approvedBy ? (
                      <>
                        {" "}
                        by <UserText>{t.approvedBy}</UserText>
                      </>
                    ) : t.kind !== "agent" ? (
                      " (made by hand)"
                    ) : (
                      ""
                    )}
                  </TableCell>
                  <TableCell className="text-end text-muted-foreground">
                    {t.lastUsedAt ? <When value={t.lastUsedAt} /> : "Never"}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button size="sm" variant="danger" onClick={() => void askRevoke(t)}>
                      <Trash2 /> {t.kind === "agent" ? "Disconnect" : "Revoke"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      <HandMadeToken />
    </>
  )
}

/** Advanced, and folded away: a long-lived token made by hand, for a program that cannot connect by approval. */
function HandMadeToken() {
  const [shown, setShown] = useState(false)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<"mcp" | "rest">("mcp")
  const [canRequestAccess, setCanRequestAccess] = useState(false)
  const [created, setCreated] = useState("")
  const id = useId()
  const create = useApiMutation<{ name: string; kind: string; canRequestAccess: boolean }, { token: string }>(
    "POST",
    "/admin/tokens",
    { invalidate: ["/admin/tokens"] },
  )
  return (
    <Panel>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setShown((s) => !s)}
        className="flex w-full items-center gap-2 px-pad-x py-3 text-start font-semibold outline-none focus-visible:outline-offset-[-2px] [@media(hover:hover)]:hover:bg-accent"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform duration-150", shown && "rotate-90")}
        />
        Advanced: a token made by hand
      </button>
      {shown && (
        <div id={id} className="grid justify-items-start gap-3 border-t border-line px-pad-x py-3">
          <p className="max-w-[75ch] text-muted-foreground">
            For a program that cannot open the approval link. The token lasts until you revoke it; store it like a
            password.
          </p>
          <Button
            onClick={() => {
              setCreated("")
              setCanRequestAccess(false)
              setOpen(true)
            }}
          >
            <Plus /> New token
          </Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent keepOnBackdrop>
          <DialogHeader icon={KeySquareIcon}>
            <DialogTitle>New token</DialogTitle>
            <DialogDescription>The token is shown once. Store it where the agent or script reads it.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="grid gap-3">
              <pre
                className="overflow-x-auto rounded-sm bg-fill p-3 font-mono text-small whitespace-pre-wrap break-all"
                data-testid="new-token"
              >
                {created}
              </pre>
              <Copyable value={created} label="Copy token">
                Copy the token
              </Copyable>
            </div>
          ) : (
            <form
              id="token"
              onSubmit={(e) => {
                e.preventDefault()
                const name = String(new FormData(e.currentTarget).get("name"))
                create.mutate({ name, kind, canRequestAccess }, { onSuccess: (r) => setCreated(r.token) })
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="token-name">Name</FieldLabel>
                  <Input id="token-name" name="name" placeholder="claude-desktop" required />
                </Field>
                <Field>
                  <FieldLabel>Kind</FieldLabel>
                  <Select value={kind} onValueChange={(v) => setKind(v as "mcp" | "rest")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcp">MCP (agents)</SelectItem>
                      <SelectItem value="rest">REST (scripts)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="token-access"
                    checked={canRequestAccess}
                    onCheckedChange={(v) => setCanRequestAccess(v === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="token-access">May request access to n8n instances</FieldLabel>
                    <FieldDescription>
                      The agent can ask for temporary API access to an instance for a task. Nothing is granted until a
                      person approves the request.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            {created ? (
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="primary" type="submit" form="token" disabled={create.isPending}>
                  Create
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
