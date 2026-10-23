import { describe, expect, it } from "vitest"
import { N8nError, type N8nWorkflow } from "../n8n/client.ts"
import { calledWorkflowIds, credentialIds, executionsSince, structureHash } from "./workflows.ts"

const base: N8nWorkflow = {
  id: "1",
  name: "Price list export",
  active: true,
  nodes: [
    { name: "Daily", type: "n8n-nodes-base.scheduleTrigger", parameters: { hour: 5 } },
    { name: "Read", type: "n8n-nodes-base.postgres", credentials: { postgres: { id: "c1", name: "DB" } } },
    { name: "Upload", type: "n8n-nodes-base.ftp", credentials: { ftp: { id: "c2", name: "SFTP" } } },
  ],
  connections: {
    Daily: { main: [[{ node: "Read", type: "main", index: 0 }]] },
    Read: { main: [[{ node: "Upload", type: "main", index: 0 }]] },
  },
}

describe("structureHash", () => {
  it("matches a renamed copy with different parameters", () => {
    const copy: N8nWorkflow = {
      ...base,
      id: "2",
      name: "Price list export (copy)",
      nodes: base.nodes.map((n) => ({ ...n, name: `${n.name} 2`, parameters: { changed: true } })),
      connections: {
        "Daily 2": { main: [[{ node: "Read 2", type: "main", index: 0 }]] },
        "Read 2": { main: [[{ node: "Upload 2", type: "main", index: 0 }]] },
      },
    }
    expect(structureHash(copy)).toBe(structureHash(base))
  })

  it("differs when the wiring differs", () => {
    const other: N8nWorkflow = {
      ...base,
      connections: { Daily: { main: [[{ node: "Upload", type: "main", index: 0 }]] } },
    }
    expect(structureHash(other)).not.toBe(structureHash(base))
  })

  it("ignores sticky notes", () => {
    const withNote = { ...base, nodes: [...base.nodes, { name: "Note", type: "n8n-nodes-base.stickyNote" }] }
    expect(structureHash(withNote)).toBe(structureHash(base))
  })
})

describe("references", () => {
  it("lists credential ids once", () => {
    expect(credentialIds(base)).toEqual(["c1", "c2"])
  })

  it("finds workflows called by id, in both parameter styles, and skips expressions", () => {
    const caller: N8nWorkflow = {
      ...base,
      nodes: [
        { name: "A", type: "n8n-nodes-base.executeWorkflow", parameters: { workflowId: "w9" } },
        {
          name: "B",
          type: "n8n-nodes-base.executeWorkflow",
          parameters: { workflowId: { value: "w10", mode: "list" } },
        },
        { name: "C", type: "n8n-nodes-base.executeWorkflow", parameters: { workflowId: "={{ $json.id }}" } },
      ],
    }
    expect(calledWorkflowIds(caller)).toEqual(["w9", "w10"])
  })
})

describe("executionsSince", () => {
  const since = "2026-10-01T00:00:00.000Z"
  const run = (workflowId: string, startedAt: string | null) => ({ workflowId, status: "success", startedAt })
  type Query = { limit?: number; cursor?: string; startedAfter?: string }
  const rejected = () =>
    new N8nError("n8n answered 400 for GET /executions", 400, `{"message":"Unknown query parameter 'startedAfter'"}`)

  it("filters with startedAfter where n8n knows it", async () => {
    const queries: Query[] = []
    const client = {
      listExecutions: async (q: Query) => {
        queries.push(q)
        return q.cursor
          ? { data: [run("b", "2026-10-02T00:00:00.000Z")], nextCursor: null }
          : { data: [run("a", "2026-10-03T00:00:00.000Z")], nextCursor: "c1" }
      },
    }
    expect((await executionsSince(client, since)).map((e) => e.workflowId)).toEqual(["a", "b"])
    expect(queries.map((q) => q.startedAfter)).toEqual([since, since])
  })

  it("pages without the filter where n8n rejects it, to the end, keeping what started in the window", async () => {
    const queries: Query[] = []
    // Newest ID first, as n8n lists them. "queued" has a lower ID than the whole page before it but waited in the
    // queue and started inside the window.
    const pages: Record<string, { data: ReturnType<typeof run>[]; nextCursor: string | null }> = {
      first: { data: [run("cancelled", null), run("b", "2026-10-05T00:00:00.000Z")], nextCursor: "c1" },
      c1: { data: [run("c", "2026-10-01T00:00:00.000Z"), run("old", "2026-09-30T23:59:00.000Z")], nextCursor: "c2" },
      c2: { data: [run("older", "2026-09-20T00:00:00.000Z")], nextCursor: "c3" },
      c3: {
        data: [run("queued", "2026-10-01T00:01:00.000Z"), run("oldest", "2026-09-10T00:00:00.000Z")],
        nextCursor: null,
      },
    }
    const client = {
      listExecutions: async (q: Query) => {
        queries.push(q)
        if (q.startedAfter) throw rejected()
        const page = pages[q.cursor ?? "first"]
        if (!page) throw new Error("read past the end")
        return page
      },
    }
    expect((await executionsSince(client, since)).map((e) => e.workflowId)).toEqual(["b", "c", "queued"])
    expect(queries).toEqual([
      { limit: 250, cursor: undefined, startedAfter: since },
      { limit: 250 },
      { limit: 250, cursor: "c1" },
      { limit: 250, cursor: "c2" },
      { limit: 250, cursor: "c3" },
    ])
  })

  it("stops at the page cap", async () => {
    let calls = 0
    const client = {
      listExecutions: async (q: Query) => {
        calls++
        if (q.startedAfter) throw rejected()
        return { data: [run("a", "2026-10-02T00:00:00.000Z")], nextCursor: `c${calls}` }
      },
    }
    expect(await executionsSince(client, since, 3)).toHaveLength(3)
    expect(calls).toBe(4) // the refused first try, then three pages
  })

  it("passes other errors on", async () => {
    const bad = new N8nError("n8n answered 400 for GET /executions", 400, `{"message":"bad cursor"}`)
    const client = {
      listExecutions: async () => {
        throw bad
      },
    }
    await expect(executionsSince(client, since)).rejects.toBe(bad)
    // A rejection after the first page is not the missing filter: n8n accepted it a page before.
    const first = { data: [run("a", "2026-10-03T00:00:00.000Z")], nextCursor: "c1" }
    const later = { listExecutions: async (q: Query) => (q.cursor ? Promise.reject(rejected()) : first) }
    await expect(executionsSince(later, since)).rejects.toThrow("400")
  })
})
