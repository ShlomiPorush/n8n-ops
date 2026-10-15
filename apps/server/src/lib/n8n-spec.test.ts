import { describe, expect, it } from "vitest"
import { checkCall } from "../services/access.ts"
import { matchOperation, parseSpec, specHasScopes } from "./n8n-spec.ts"

// A trimmed copy of the shape of n8n's /api/v1/openapi.yml.
const spec = parseSpec(`
openapi: 3.0.0
paths:
  /workflows:
    get:
      x-required-scope: workflow:list
    post:
      x-required-scope: workflow:create
  /workflows/{workflowId}:
    get:
      x-required-scope: workflow:read
    put:
      x-required-scope: workflow:update
    delete:
      x-required-scope: workflow:delete
  /workflows/{workflowId}/activate:
    post:
      x-required-scope: workflow:activate
  /executions:
    get:
      x-required-scope: execution:list
  /executions/stop:
    post:
      x-required-scope: execution:stop
  /executions/{executionId}:
    get:
      x-required-scope: execution:read
  /n8n-packages/export:
    post:
      x-required-scope: project:export,workflow:export
  /discover:
    get:
      x-required-scope: none
`)

const none = new URLSearchParams()

describe("n8n API description", () => {
  it("reads every operation with its scopes", () => {
    expect(specHasScopes(spec)).toBe(true)
    expect(matchOperation(spec, "PUT", "/workflows/abc")?.op.scopes).toEqual(["workflow:update"])
    expect(matchOperation(spec, "GET", "/workflows/abc")?.params).toEqual({ workflowId: "abc" })
    expect(matchOperation(spec, "POST", "/n8n-packages/export")?.op.scopes).toEqual([
      "project:export",
      "workflow:export",
    ])
    expect(matchOperation(spec, "GET", "/discover")?.op.scopes).toEqual([])
  })

  it("prefers a literal path over a parameter", () => {
    expect(matchOperation(spec, "POST", "/executions/stop")?.op.template).toBe("/executions/stop")
  })

  it("knows nothing outside the description", () => {
    expect(matchOperation(spec, "GET", "/users")).toBeNull()
    expect(matchOperation(spec, "PATCH", "/workflows/abc")).toBeNull()
  })

  it("treats a document without scopes as unusable", () => {
    expect(specHasScopes(parseSpec("paths:\n  /workflows:\n    get: {}\n"))).toBe(false)
  })
})

describe("access checks", () => {
  const read = { scopes: ["workflow:list", "workflow:read", "execution:list", "execution:read"], workflowIds: [] }

  it("allows calls inside the scopes", () => {
    expect(checkCall(spec, read, "GET", "/workflows/abc", none).allowed).toBe(true)
    expect(checkCall(spec, read, "GET", "/discover", none).allowed).toBe(true)
  })

  it("refuses calls that need a scope the access does not include", () => {
    const d = checkCall(spec, read, "PUT", "/workflows/abc", none)
    expect(d.allowed).toBe(false)
    expect(!d.allowed && d.reason).toContain("workflow:update")
  })

  it("requires every scope of a composite list", () => {
    const some = { scopes: ["workflow:export"], workflowIds: [] }
    expect(checkCall(spec, some, "POST", "/n8n-packages/export", none).allowed).toBe(false)
  })

  it("refuses operations that are not in the description", () => {
    expect(checkCall(spec, read, "GET", "/users", none).allowed).toBe(false)
  })

  describe("limited to workflows", () => {
    const limited = {
      scopes: [
        "workflow:list",
        "workflow:read",
        "workflow:update",
        "workflow:create",
        "execution:list",
        "execution:read",
        "execution:stop",
      ],
      workflowIds: ["w1"],
    }

    it("allows only the listed workflows", () => {
      expect(checkCall(spec, limited, "PUT", "/workflows/w1", none).allowed).toBe(true)
      expect(checkCall(spec, limited, "PUT", "/workflows/w2", none).allowed).toBe(false)
    })

    it("filters the workflow list and cannot create workflows", () => {
      expect(checkCall(spec, limited, "GET", "/workflows", none)).toMatchObject({ allowed: true, workflowFilter: true })
      expect(checkCall(spec, limited, "POST", "/workflows", none).allowed).toBe(false)
    })

    it("lists executions only for a listed workflow", () => {
      expect(checkCall(spec, limited, "GET", "/executions", none).allowed).toBe(false)
      expect(checkCall(spec, limited, "GET", "/executions", new URLSearchParams("workflowId=w1")).allowed).toBe(true)
      expect(checkCall(spec, limited, "GET", "/executions", new URLSearchParams("workflowId=w2")).allowed).toBe(false)
    })

    it("checks one execution's workflow with n8n, and refuses operations across executions", () => {
      expect(checkCall(spec, limited, "GET", "/executions/77", none)).toMatchObject({
        allowed: true,
        executionId: "77",
      })
      expect(checkCall(spec, limited, "POST", "/executions/stop", none).allowed).toBe(false)
    })
  })
})
