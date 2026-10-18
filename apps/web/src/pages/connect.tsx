import { useQuery } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { useState } from "react"
import { useParams } from "react-router"
import { KV, LoadError, Loading, Panel } from "@/components/kit"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { ApiError } from "@/lib/api"
import { AuthFrame } from "./auth/shared"

type ConnectRequest = {
  flow: "browser" | "code"
  client: { name: string | null; builtIn: boolean }
  redirect: { host: string; loopback: boolean } | null
  resource: "mcp" | "rest"
  asked: ("ops:read" | "ops:access")[]
}

/** The approval page's own API sits under the request's address, where its cookie is sent. */
async function call<T>(uid: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/connect/approve/${encodeURIComponent(uid)}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `http_${res.status}`, undefined, data.message)
  return data as T
}

/**
 * An agent asks to connect (OAuth): the person sees who asks, where the browser goes back to, what it may do
 * and for how long, and approves or denies. The name is the agent's own word; the page says so.
 */
export function ConnectApprovePage() {
  const { uid = "" } = useParams()
  const request = useQuery({
    queryKey: ["connect", uid],
    queryFn: () => call<ConnectRequest>(uid, "request"),
    retry: false,
  })
  const [access, setAccess] = useState(true)
  const [state, setState] = useState<"open" | "busy" | "approved" | "denied">("open")
  const [error, setError] = useState("")

  async function decide(approve: boolean) {
    setState("busy")
    setError("")
    try {
      const { redirectTo } = await call<{ redirectTo: string }>(uid, "decision", {
        approve,
        scopes: ["ops:read", ...(approve && access ? ["ops:access"] : [])],
      })
      setState(approve ? "approved" : "denied")
      window.location.assign(redirectTo)
    } catch (e) {
      setState("open")
      setError(
        e instanceof ApiError && e.detail
          ? e.detail
          : "That did not work. Try again, or start the connection again in your agent.",
      )
    }
  }

  const r = request.data
  const name = r ? (r.client.builtIn ? "A script" : (r.client.name ?? "An unnamed agent")) : ""
  return (
    <AuthFrame wide title="Connect an agent" description={r ? `${name} asks to use n8n-ops.` : undefined}>
      {request.error ? (
        request.error instanceof ApiError && request.error.status === 410 ? (
          <Alert variant="warn">
            <AlertTitle>This request is no longer open</AlertTitle>
            <AlertDescription>Requests last 10 minutes. Start the connection again in your agent.</AlertDescription>
          </Alert>
        ) : (
          <Panel>
            <LoadError what="the request" error={request.error} retry={() => request.refetch()} />
          </Panel>
        )
      ) : !r ? (
        <Panel>
          <Loading />
        </Panel>
      ) : state === "approved" || state === "denied" ? (
        <Panel>
          <p className="px-pad-x py-pad-y">
            {state === "approved" ? "Approved. Returning to your agent…" : "Denied. Returning to your agent…"}
          </p>
        </Panel>
      ) : (
        <>
          <Panel>
            <KV label="Agent">{r.client.builtIn ? "Script or command line" : (r.client.name ?? "No name given")}</KV>
            {r.redirect && (
              <KV label="Returns to">
                <span className="font-mono">{r.redirect.host}</span>
              </KV>
            )}
            <KV label="Uses">{r.resource === "mcp" ? "The MCP server" : "The REST API"}</KV>
            <KV label="Lasts">Until you revoke it; ends after 90 days unused</KV>
          </Panel>

          <Alert variant="warn">
            <TriangleAlert />
            <AlertTitle>Approve only an agent you started yourself</AlertTitle>
            <AlertDescription>
              {r.flow === "code"
                ? "Check that your agent showed the same code you just confirmed."
                : r.redirect?.loopback
                  ? "It runs as a program on a computer and returns to it through this browser. Any program can give itself this name."
                  : "The name is what the agent says about itself; n8n-ops cannot prove it."}
            </AlertDescription>
          </Alert>

          <div className="grid gap-3">
            <Field orientation="horizontal">
              <Checkbox id="connect-read" checked disabled />
              <FieldContent>
                <FieldLabel htmlFor="connect-read">Read</FieldLabel>
                <FieldDescription>
                  Problems, failed executions, instance health, workflows and backups.
                </FieldDescription>
              </FieldContent>
            </Field>
            {r.asked.includes("ops:access") && (
              <Field orientation="horizontal">
                <Checkbox id="connect-access" checked={access} onCheckedChange={(v) => setAccess(v === true)} />
                <FieldContent>
                  <FieldLabel htmlFor="connect-access">May ask for access to n8n instances</FieldLabel>
                  <FieldDescription>
                    Temporary access to one instance for a task. Nothing is granted until a person approves each
                    request.
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
          </div>

          {error && (
            <p role="alert" className="text-fail">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={state === "busy"} onClick={() => void decide(true)}>
              Approve
            </Button>
            <Button disabled={state === "busy"} onClick={() => void decide(false)}>
              Deny
            </Button>
          </div>
        </>
      )}
    </AuthFrame>
  )
}
