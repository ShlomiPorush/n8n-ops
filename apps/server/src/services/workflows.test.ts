import { describe, expect, it } from "vitest"
import type { N8nWorkflow } from "../n8n/client.ts"
import { calledWorkflowIds, credentialIds, structureHash } from "./workflows.ts"

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
