import { describe, expect, it } from "vitest"
import type { N8nExecution } from "../n8n/client.ts"
import { extractFailure } from "../n8n/execution.ts"
import { type CauseInput, causeOf, displayReasonOf, hostOf, normalize, serviceAnswer } from "./cause.ts"

const BAD = "Bad request - please check your parameters"
const NOT_FOUND = "The resource you are requesting could not be found"
const SERVER = "The service was not able to process your request"
const GATEWAY_TIMEOUT = "Gateway timed out - perhaps try again later?"

const base: CauseInput = {
  instanceId: "i1",
  workflowId: "w1",
  nodeName: "Call API",
  nodeType: "n8n-nodes-base.httpRequest",
  message: BAD,
  description: null,
  url: null,
  credentials: [],
  calledWorkflow: null,
}
const cause = (patch: Partial<CauseInput>) => causeOf({ ...base, ...patch })

describe("target", () => {
  it("is the host of a literal URL, also when an expression follows it", () => {
    expect(cause({ url: "https://API.example.com/v1/orders" })).toMatchObject({
      target: "api.example.com",
      targetKey: "host:api.example.com",
      targetSource: "host",
    })
    expect(cause({ url: "=https://api.example.com/orders/{{ $json.id }}" }).target).toBe("api.example.com")
    expect(cause({ url: "http://mailbox:80/api/search" }).target).toBe("mailbox")
  })

  it("reads the host only from a literal authority", () => {
    expect(hostOf("https://user:secret@api.example.com:8443/x")).toBe("api.example.com")
    expect(hostOf("https://[2001:db8::1]/x")).toBe("[2001:db8::1]")
    expect(hostOf("https://[2001:db9::2]:8443/x")).toBe("[2001:db9::2]")
    expect(hostOf("=https://api.{{ $json.region }}.example/x")).toBeNull()
    expect(hostOf("=https://user:{{ $json.password }}@api.example.com/x")).toBeNull()
    expect(hostOf("={{ $json.endpoint }}/x")).toBeNull()
    expect(hostOf("https://")).toBeNull()
    expect(hostOf("ftp://files.example.com/")).toBeNull()
  })

  it("falls back to the credential, keyed by its id so a rename keeps the key", () => {
    const before = cause({ url: "={{ $json.endpoint }}/list", credentials: [{ id: "c9", name: "Billing key" }] })
    const after = cause({ url: "={{ $json.endpoint }}/list", credentials: [{ id: "c9", name: "Billing key (new)" }] })
    expect(before).toMatchObject({ target: "Billing key", targetKey: "credential:i1:c9", targetSource: "credential" })
    expect(after.target).toBe("Billing key (new)")
    expect(after.key).toBe(before.key)
  })

  it("keeps workflow and credential ids apart per instance, and joins one host across instances", () => {
    const credential = { credentials: [{ id: "c1", name: "Key" }] }
    expect(cause({ ...credential, instanceId: "a" }).key).not.toBe(cause({ ...credential, instanceId: "b" }).key)
    const host = { url: "https://api.example.com/x" }
    expect(cause({ ...host, instanceId: "a" }).key).toBe(cause({ ...host, instanceId: "b" }).key)
  })

  it("names a host from the error only when the node has no URL", () => {
    const description =
      "[Provider Error]: Error fetching from https://ai.example.net/v1/models/m-1:run: [404 Not Found]"
    expect(cause({ nodeType: "x.agent", message: NOT_FOUND, description })).toMatchObject({
      target: "ai.example.net",
      targetSource: "error-host",
    })
    expect(cause({ message: NOT_FOUND, description, url: "={{ $json.u }}" }).targetSource).toBe("node")
  })

  it("is the node as a last resort, and then never joins two workflows", () => {
    const one = cause({ url: "={{ $json.u }}" })
    expect(one).toMatchObject({ target: "Call API", targetKey: "node:i1:w1:Call API", targetSource: "node" })
    expect(cause({ url: "={{ $json.u }}", workflowId: "w2" }).key).not.toBe(one.key)
  })

  it("is the workflow an Execute Workflow node runs, keyed by its id, before its URL or credential", () => {
    const run = (name: string | null) =>
      cause({
        nodeType: "n8n-nodes-base.executeWorkflow",
        message: "Error executing workflow with item at index 0",
        description: "certificate has expired",
        calledWorkflow: { id: "child1", name },
        credentials: [{ id: "c1", name: "Key" }],
      })
    expect(run("Lookup")).toMatchObject({
      target: 'Runs "Lookup"',
      targetKey: "workflow:i1:child1",
      targetSource: "workflow",
      reason: "certificate has expired",
      kind: "sub",
    })
    expect(run(null).target).toBe("Runs workflow child1")
    expect(run(null).key).toBe(run("Lookup").key)
  })

  it("prefers the URL's host to the credential", () => {
    expect(cause({ url: "https://api.example.com/x", credentials: [{ id: "c1", name: "Key" }] }).targetSource).toBe(
      "host",
    )
  })
})

describe("reason", () => {
  it("puts the HTTP status that n8n's message stands for before the service's answer, else before the message", () => {
    expect(cause({ description: "Auth Error" })).toMatchObject({ reason: "HTTP 400 · Auth Error", httpStatus: 400 })
    expect(cause({ description: null }).reason).toBe(`HTTP 400 · ${BAD}`)
  })

  it("keeps an answer that starts with a number", () => {
    const a = cause({ description: "400 accounts are invalid" })
    const b = cause({ description: "400 records exceeded quota" })
    expect(a.reason).toBe("HTTP 400 · 400 accounts are invalid")
    expect(a.key).not.toBe(b.key)
  })

  it("reads the text of a JSON body, also when it is encoded twice", () => {
    const body = { result: { error: "Access denied", data: { reason: "Access denied" } } }
    expect(
      cause({ message: "Forbidden - perhaps check your credentials?", description: `403 - ${JSON.stringify(body)}` }),
    ).toMatchObject({ reason: "HTTP 403 · Access denied", kind: "cred" })
    expect(
      cause({ description: `400 - ${JSON.stringify(JSON.stringify({ status: "error", error: "" }))}` }).reason,
    ).toBe(`HTTP 400 · ${BAD}`)
  })

  it("reads the code and the whole message of an XML error, and the title of an HTML page", () => {
    const xml = (second: string) =>
      `<?xml version="1.0"?><Error><Code>Rejected</Code><Message>Request rejected.\n${second}</Message></Error>`
    const quota = cause({ message: NOT_FOUND, description: xml("The quota is used up.") })
    expect(quota.reason).toBe("HTTP 404 · Rejected: Request rejected.\nThe quota is used up.")
    expect(quota.key).not.toBe(cause({ message: NOT_FOUND, description: xml("The file is gone.") }).key)
    expect(cause({ message: NOT_FOUND, description: xml("RequestId: 1") }).key).toBe(
      cause({ message: NOT_FOUND, description: xml("RequestId: 2") }).key,
    )
    const html = "<!doctype html>\n<html><head><title>Proxy Login</title></head><body>...</body></html>"
    const proxied = cause({ message: GATEWAY_TIMEOUT, description: html })
    expect(proxied).toMatchObject({ reason: 'HTTP 504 · HTML page "Proxy Login"', kind: "svc" })
    expect(proxied.hint).toBe("A proxy answered instead of the service.")
  })

  it("keeps an XML message whose closing tag the input cap cut off", () => {
    const xml = (start: string) =>
      `<?xml version="1.0"?><Error><Code>Rejected</Code><Message>${start} ${"x".repeat(9000)}</Message></Error>`
    const quota = cause({ description: xml("Quota exceeded.") })
    expect(quota.reason).toMatch(/^HTTP 400 · Rejected: Quota exceeded\. x+$/)
    expect(quota.key).not.toBe(cause({ description: xml("File gone.") }).key)
  })

  it("reads an HTML page or an XML error inside n8n's NNN - body, also as a JSON string", () => {
    const page = "<html><head><title>Login</title></head><body>x</body></html>"
    expect(serviceAnswer(`500 - ${JSON.stringify(page)}`)).toBe('HTML page "Login"')
    expect(serviceAnswer(`500 - ${page}`)).toBe('HTML page "Login"')
    expect(serviceAnswer("404 - <Error><Code>NoSuchKey</Code><Message>Gone</Message></Error>")).toBe("NoSuchKey: Gone")
  })

  it("is n8n's message when there is no answer, and the answer alone without an HTTP status", () => {
    expect(cause({ message: "connect ENETUNREACH 192.0.2.10:25" }).reason).toBe("connect ENETUNREACH 192.0.2.10:25")
    expect(cause({ message: "Error executing workflow", description: "Access Denied" }).reason).toBe("Access Denied")
    expect(cause({ message: "", description: null }).reason).toBe("Unknown error")
  })
})

describe("cause key", () => {
  it("is the same when only ids and times change", () => {
    const a = cause({
      message: SERVER,
      description: "Token expired for app 6ccf7ba8-2538-4167-aea4-735589761809. Trace ID: 1",
    })
    const b = cause({
      message: SERVER,
      description: "Token expired for app 0b626eaa-6cc9-45ba-bef4-cfc15f514952. Trace ID: 2",
    })
    expect(a.key).toBe(b.key)
    expect(normalize("at 2026-11-02T10:22:53.135Z id deadbeefdeadbeef01")).toBe("at <time> id <hex>")
  })

  it("differs for reasons that share their first sentence or their first 1,000 characters", () => {
    const head = "The request failed. "
    const tail = " Some more words to make this reason long enough to be cut on screens to its first sentence."
    const model = cause({ description: `${head}The model was removed.${tail}` })
    const file = cause({ description: `${head}The file was removed.${tail}` })
    expect(model.key).not.toBe(file.key)
    expect(model.displayReason).toBe(file.displayReason)
    const long = "x".repeat(1200)
    expect(cause({ description: `${long} code 1` }).key).not.toBe(cause({ description: `${long} code 2` }).key)
  })

  it("keeps service error codes", () => {
    expect(normalize("invalid_client: AADSTS7000222: keys expired")).toContain("AADSTS7000222")
  })
})

describe("kind and known error", () => {
  it.each([
    [{ nodeType: "n8n-nodes-base.stopAndError", message: "Check the mail queue" }, "alert", null],
    [
      { nodeType: "n8n-nodes-base.code", message: "Task request timed out after 60 seconds" },
      "runner",
      "The n8n task runner did not take the Code node's task. A problem of the instance, not the workflow.",
    ],
    [{ message: "certificate has expired" }, "cert", "The server's TLS certificate has expired."],
    [{ message: "connect ENETUNREACH 192.0.2.10:443" }, "net", "No network route to the server."],
    [
      { message: "The DNS server returned an error, perhaps the server is offline" },
      "net",
      "The server name could not be resolved.",
    ],
    [
      { message: SERVER, description: "Could not get token: invalid_client:AADSTS7000222: The secret is expired." },
      "cred",
      "The client secret of the Microsoft Entra app has expired.",
    ],
    [
      { message: "Client authentication failed (e.g., unknown client)." },
      "cred",
      "The OAuth app's client ID or secret was rejected.",
    ],
    [{ message: "Authorization failed - please check your credentials" }, "cred", null],
    [{ message: "Bad gateway - the service failed to handle your request", description: "Bad Gateway" }, "svc", null],
    [
      { message: NOT_FOUND, description: "This model is no longer available." },
      "req",
      "The provider no longer offers what the node asks for.",
    ],
    [{ message: "Something odd" }, "other", null],
    // Precedence between rules.
    [
      { nodeType: "n8n-nodes-base.stopAndError", message: "certificate has expired" },
      "alert",
      "The server's TLS certificate has expired.",
    ],
    [
      { nodeType: "n8n-nodes-base.executeWorkflow", message: "certificate has expired" },
      "sub",
      "The server's TLS certificate has expired.",
    ],
    [
      { message: "Authorization failed - please check your credentials", description: "connect ENETUNREACH" },
      "cred",
      "No network route to the server.",
    ],
    [
      { message: "connect ENETUNREACH 192.0.2.1:443 after certificate has expired" },
      "cert",
      "The server's TLS certificate has expired.",
    ],
  ] as const)("%o is %s", (patch, kind, hint) => {
    expect(cause(patch)).toMatchObject({ kind, hint })
  })

  it("explains an HTML page also without an HTTP status", () => {
    const c = cause({ message: "Request failed", description: "<html><head><title>Login</title></head></html>" })
    expect(c).toMatchObject({ reason: 'HTML page "Login"', hint: "A proxy answered instead of the service." })
  })
})

describe("display reason", () => {
  it("drops asides of a long reason and keeps its first sentence", () => {
    const reason =
      "HTTP 404 · [Provider Error]: Error fetching from https://ai.example.net/v1/models/m-1:run: [404 Not Found] This model models/m-1.0 is no longer available. Please move to m-2 for the latest features and improvements, and read the migration guide."
    expect(displayReasonOf(reason)).toBe("HTTP 404 · This model models/m-1.0 is no longer available.")
    expect(
      displayReasonOf(
        "Client authentication failed (e.g., unknown client, no client authentication included, or unsupported).",
      ),
    ).toBe("Client authentication failed.")
    expect(displayReasonOf("y".repeat(900)).length).toBeLessThanOrEqual(300)
  })

  it("leaves a short reason as it is, and cuts a long one at a short first sentence", () => {
    expect(displayReasonOf("HTTP 400 · Bad request [INVALID_FIELD]")).toBe("HTTP 400 · Bad request [INVALID_FIELD]")
    expect(displayReasonOf(`Server failed. ${"More detail follows here. ".repeat(6)}`)).toBe("Server failed.")
  })
})

describe("hostile input", () => {
  it("never throws, and falls back to the node and the error text", () => {
    let deep: unknown = "end"
    for (let i = 0; i < 20_000; i++) deep = [deep]
    const inputs: Partial<CauseInput>[] = [
      { message: deep as string },
      { description: deep as string },
      { description: `400 - ${"[".repeat(5000)}` },
      { description: `400 - ${JSON.stringify({ a: { b: { c: { d: { e: { f: { error: "deep" } } } } } } })}` },
      { description: "z".repeat(1_000_000) },
      { url: "https://" as string },
      { url: 12 as unknown as string },
      { credentials: "x" as unknown as CauseInput["credentials"] },
      { credentials: [null, { id: 3, name: "x" }] as unknown as CauseInput["credentials"] },
      { calledWorkflow: { id: "", name: null }, nodeType: "n8n-nodes-base.executeWorkflow" },
    ]
    for (const patch of inputs) {
      const c = cause(patch)
      expect(typeof c.key).toBe("string")
      expect(c.reason.length).toBeGreaterThan(0)
      expect(c.displayReason.length).toBeLessThanOrEqual(300)
    }
    expect(cause({ message: deep as string })).toMatchObject({ reason: "Unknown error", targetSource: "node" })
    expect(cause({ credentials: [null] as unknown as CauseInput["credentials"] }).targetSource).toBe("node")
    expect(
      cause({ description: `400 - ${JSON.stringify({ a: { b: { c: { d: { e: { f: { error: "deep" } } } } } } })}` })
        .reason,
    ).toBe(`HTTP 400 · ${BAD}`)
  })

  it("reads a cause from a whole stored record with fields of the wrong type", () => {
    let deep: unknown = "end"
    for (let i = 0; i < 20_000; i++) deep = [deep]
    const records: unknown[] = [
      { resultData: { error: { message: deep, node: { name: "HTTP" } } } },
      { resultData: { error: { message: "Bad request - please check your parameters", description: deep } } },
      "not an object",
      null,
    ]
    for (const data of records) {
      const execution = {
        id: "1",
        status: "error",
        workflowId: "w1",
        data,
        workflowData: { id: "w1", name: "W", active: true, nodes: "nope", connections: {} },
      } as unknown as N8nExecution
      const f = extractFailure(execution)
      const c = causeOf({ instanceId: "i1", workflowId: "w1", ...f, ...f.node })
      expect(c.key).toMatch(/^[0-9a-f]{64}$/)
      expect(c.targetSource).toBe("node")
    }
  })

  it("leaves no markup in a reason", () => {
    expect(serviceAnswer("<<b>script>alert(1)<</b>/script> failed")).toBe("scriptalert(1)/script failed")
    expect(cause({ description: "<p>Quota <b>exceeded</b></p>" }).reason).toBe("HTTP 400 · Quota exceeded")
    expect(serviceAnswer("Line one<br/>line two")).toBe("Line one line two")
    expect(serviceAnswer("Limit is 5 < 10 items")).toBe("Limit is 5  10 items")
    expect(serviceAnswer("<scr<script>ipt>x")).toBe("iptx")
  })

  it("reads only the start of very long fields", () => {
    expect(serviceAnswer(`${"a".repeat(9000)}<title>`)).toHaveLength(8192)
    expect(hostOf(`https://${"h".repeat(3000)}`)?.length).toBeLessThan(2048)
  })
})
