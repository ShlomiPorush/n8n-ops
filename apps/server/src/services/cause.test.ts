import { describe, expect, it } from "vitest"
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

  it("is the workflow an Execute Workflow node runs, keyed by its id", () => {
    const run = (name: string | null) =>
      cause({
        nodeType: "n8n-nodes-base.executeWorkflow",
        message: "Error executing workflow with item at index 0",
        description: "certificate has expired",
        calledWorkflow: { id: "child1", name },
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
})

describe("reason", () => {
  it("adds the HTTP status that n8n's message stands for to the service's answer", () => {
    expect(cause({ description: "Auth Error" })).toMatchObject({ reason: "HTTP 400 · Auth Error", httpStatus: 400 })
    expect(cause({ description: null }).reason).toBe("HTTP 400")
  })

  it("reads the text of a JSON body, also when it is encoded twice", () => {
    const body = { result: { error: "Access denied", data: { reason: "Access denied" } } }
    expect(
      cause({ message: "Forbidden - perhaps check your credentials?", description: `403 - ${JSON.stringify(body)}` }),
    ).toMatchObject({ reason: "HTTP 403 · Access denied", kind: "cred" })
    expect(
      cause({ description: `400 - ${JSON.stringify(JSON.stringify({ status: "error", error: "" }))}` }).reason,
    ).toBe("HTTP 400")
  })

  it("reads the code and message of an XML error and the title of an HTML page", () => {
    const xml =
      '<?xml version="1.0"?><Error><Code>BlobNotFound</Code><Message>The blob is gone.\nRequestId:1</Message></Error>'
    expect(cause({ message: NOT_FOUND, description: xml }).reason).toBe("HTTP 404 · BlobNotFound: The blob is gone.")
    const html = "<!doctype html>\n<html><head><title>Proxy Login</title></head><body>...</body></html>"
    const proxied = cause({ message: GATEWAY_TIMEOUT, description: html })
    expect(proxied).toMatchObject({ reason: 'HTTP 504 · HTML page "Proxy Login"', kind: "svc" })
    expect(proxied.hint).toBe("A proxy answered instead of the service.")
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
    expect(cause({ description: `${head}The model was removed.` }).key).not.toBe(
      cause({ description: `${head}The file was removed.` }).key,
    )
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
  ] as const)("%o is %s", (patch, kind, hint) => {
    expect(cause(patch)).toMatchObject({ kind, hint })
  })
})

describe("display reason", () => {
  it("drops wrapper tags and long asides and keeps the first sentence", () => {
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
})

describe("hostile input", () => {
  it("never throws and falls back to the node and the error text", () => {
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
      { calledWorkflow: { id: "", name: null }, nodeType: "n8n-nodes-base.executeWorkflow" },
    ]
    for (const patch of inputs) {
      const c = cause(patch)
      expect(typeof c.key).toBe("string")
      expect(typeof c.reason).toBe("string")
      expect(c.displayReason.length).toBeLessThanOrEqual(300)
    }
    expect(
      cause({ description: `400 - ${JSON.stringify({ a: { b: { c: { d: { e: { f: { error: "deep" } } } } } } })}` })
        .reason,
    ).toBe("HTTP 400")
  })

  it("reads only the start of very long fields", () => {
    expect(serviceAnswer(`${"a".repeat(9000)}<title>`)).toHaveLength(8192)
    expect(hostOf(`https://${"h".repeat(3000)}`)?.length).toBeLessThan(2048)
  })
})
