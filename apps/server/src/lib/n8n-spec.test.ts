import { describe, expect, it } from "vitest"
import { checkCall } from "../services/access.ts"
import { matchOperation, parseSpec, specHasScopes } from "./n8n-spec.ts"

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
      parameters:
        - name: workflowId
          in: path
        - name: publishIfActive
          in: query
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

const wideSpec = parseSpec(`
paths:
  /workflows/{workflowId}:
    get:
      x-required-scope: workflow:read
  /workflows/{workflowId}/dependencies:
    get:
      x-required-scope: workflow:read
  /workflows/{workflowId}/{workflowVersionId}:
    get:
      x-required-scope: workflow:read
  /n8n-packages/export:
    post:
      x-required-scope: project:export,workflow:export
  /n8n-packages/import:
    post:
      x-required-scope: workflow:import
  /source-control/pull:
    post:
      x-required-scope: sourceControl:pull
  /promotions/projects/{projectId}/apply:
    post:
      x-required-scope: promotions:apply
  /projects/{projectId}:
    delete:
      x-required-scope: project:delete
  /tags/{tagId}:
    put:
      x-required-scope: tag:update
  /archive/{workflowId}:
    post:
      x-required-scope: workflow:delete
  /credentials:
    get:
      x-required-scope: credential:list
    post:
      x-required-scope: credential:create
  /credentials/{credentialId}:
    get:
      x-required-scope: credential:read
    patch:
      x-required-scope: credential:update
    delete:
      x-required-scope: credential:delete
  /credentials/{credentialId}/test:
    post:
      x-required-scope: credential:read
  /credentials/{credentialId}/transfer:
    put:
      x-required-scope: credential:move
  /credentials/{credentialId}/dependencies:
    get:
      x-required-scope: credential:read
  /credentials/schema/{credentialTypeName}:
    get: {}
  /discover:
    get:
      x-required-scope: none
`)

const idSpec = parseSpec(`
paths:
  /workflows/{id}:
    get:
      x-required-scope: workflow:read
    put:
      x-required-scope: workflow:update
  /workflows/{id}/{versionId}:
    get:
      x-required-scope: workflow:read
  /executions/{id}:
    get:
      x-required-scope: execution:read
  /executions/{id}/retry:
    post:
      x-required-scope: execution:retry
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

  it("matches paths without regard to case, as n8n routes them, and keeps the values as sent", () => {
    expect(matchOperation(spec, "POST", "/Executions/STOP")?.op.template).toBe("/executions/stop")
    expect(matchOperation(spec, "GET", "/WORKFLOWS/AbC")?.params).toEqual({ workflowId: "AbC" })
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

    const everyScope = [
      "workflow:read",
      "workflow:delete",
      "workflow:import",
      "project:export",
      "workflow:export",
      "project:delete",
      "sourceControl:pull",
      "promotions:apply",
      "tag:update",
      "credential:list",
      "credential:create",
      "credential:read",
      "credential:update",
      "credential:delete",
      "credential:move",
    ]
    const beyondWorkflows: [string, string][] = [
      ["POST", "/n8n-packages/export"],
      ["POST", "/n8n-packages/import"],
      ["POST", "/source-control/pull"],
      ["POST", "/promotions/projects/p1/apply"],
      ["DELETE", "/projects/p1"],
      ["PUT", "/tags/t1"],
      ["GET", "/workflows/w1/dependencies"],
      ["GET", "/workflows/w1/Dependencies/"],
      ["GET", "/credentials/c1/dependencies"],
      ["POST", "/archive/w1"],
      ["GET", "/discover"],
    ]
    const credentialCalls: [string, string][] = [
      ["GET", "/credentials"],
      ["POST", "/credentials"],
      ["GET", "/credentials/c1"],
      ["PATCH", "/credentials/c1"],
      ["DELETE", "/credentials/c1"],
      ["POST", "/credentials/c1/test"],
      ["PUT", "/credentials/c1/transfer"],
      ["GET", "/credentials/schema/slackApi"],
    ]

    it("refuses every operation that is not on its workflows, their executions or a credential", () => {
      const wide = { scopes: everyScope, workflowIds: ["w1"] }
      for (const [method, path] of beyondWorkflows) {
        const d = checkCall(wideSpec, wide, method, path, none)
        expect(d.allowed, `${method} ${path}`).toBe(false)
        expect(!d.allowed && d.reason, `${method} ${path}`).toContain("whole instance")
      }
      expect(checkCall(wideSpec, wide, "GET", "/workflows/w1", none).allowed).toBe(true)
      expect(checkCall(wideSpec, wide, "GET", "/workflows/w1/v3", none).allowed).toBe(true)
    })

    it("reaches the instance's credentials", () => {
      const wide = { scopes: everyScope, workflowIds: ["w1"] }
      for (const [method, path] of credentialCalls)
        expect(checkCall(wideSpec, wide, method, path, none).allowed, `${method} ${path}`).toBe(true)
    })

    it("leaves access to the whole instance to its scopes", () => {
      const whole = { scopes: everyScope, workflowIds: [] }
      for (const [method, path] of [...beyondWorkflows, ...credentialCalls])
        expect(checkCall(wideSpec, whole, method, path, none).allowed, `${method} ${path}`).toBe(true)
    })

    it("finds the workflow and the execution by their place in the path, whatever n8n names the parameter", () => {
      const scopes = ["workflow:read", "workflow:update", "execution:read", "execution:retry"]
      const limitedById = { scopes, workflowIds: ["w1"] }
      expect(checkCall(idSpec, limitedById, "GET", "/workflows/w1", none).allowed).toBe(true)
      expect(checkCall(idSpec, limitedById, "PUT", "/workflows/w2", none).allowed).toBe(false)
      expect(checkCall(idSpec, limitedById, "GET", "/workflows/w1/v3", none).allowed).toBe(true)
      expect(checkCall(idSpec, limitedById, "GET", "/workflows/w2/v3", none).allowed).toBe(false)
      expect(checkCall(idSpec, limitedById, "GET", "/executions/77", none)).toMatchObject({
        allowed: true,
        executionId: "77",
      })
      expect(checkCall(idSpec, limitedById, "POST", "/executions/77/retry", none)).toMatchObject({
        allowed: true,
        executionId: "77",
      })
    })
  })
})

describe("what the access proxy sends to n8n", () => {
  const whole = { scopes: ["workflow:list", "workflow:read", "execution:list", "execution:read"], workflowIds: [] }
  const limited = { ...whole, workflowIds: ["w1"] }
  const q = (text: string) => new URLSearchParams(text)

  it("sends the operation's own path, with each parameter written out again", () => {
    expect(checkCall(spec, whole, "GET", "/WORKFLOWS/AbC/", none)).toMatchObject({
      allowed: true,
      path: "/workflows/AbC",
      query: "",
    })
    expect(checkCall(wideSpec, limited, "GET", "/workflows/w1/v3", none)).toMatchObject({
      allowed: true,
      path: "/workflows/w1/v3",
    })
  })

  it("refuses a path parameter that a server or proxy could read as another path", () => {
    for (const path of [
      "/workflows/x%2F..%2F..%2Fusers",
      "/workflows/a%2Fb",
      "/workflows/w1%2Fdependencies",
      "/workflows/a%2F%2Fb",
      "/workflows/a%5Cb",
      "/workflows/a%252Fb",
      "/workflows/a%00b",
      "/workflows/%2E%2E",
      "/workflows/%E0%A4%A",
    ])
      expect(checkCall(wideSpec, whole, "GET", path, none).allowed, path).toBe(false)
  })

  it("refuses a path whose written-out form is another operation", () => {
    for (const grant of [whole, limited]) {
      expect(checkCall(wideSpec, grant, "GET", "/workflows/w1/%64ependencies", none).allowed).toBe(false)
      expect(checkCall(wideSpec, grant, "GET", "/workflows/w1/%44EPENDENCIES/", none).allowed).toBe(false)
    }
  })

  it("takes a slash only in the parameters n8n documents with one, whatever else the description lists", () => {
    const older = parseSpec(`
paths:
  /credentials/{credentialId}:
    get:
      x-required-scope: credential:read
`)
    const grant = { scopes: ["credential:read"], workflowIds: ["w1"] }
    expect(checkCall(older, grant, "GET", "/credentials/c1", none).allowed).toBe(true)
    expect(checkCall(older, grant, "GET", "/credentials/c1%2Fdependencies", none).allowed).toBe(false)
    expect(checkCall(older, { ...grant, workflowIds: [] }, "GET", "/credentials/c1%2Fx", none).allowed).toBe(false)
  })

  it("takes a slash in a package name and a repository path", () => {
    const slashes = parseSpec(`
paths:
  /community-packages/{name}:
    patch:
      x-required-scope: communityPackage:update
  /promotions/providers/{promotionProviderId}/repositories/{repositoryId}/branches:
    get:
      x-required-scope: promotions:discover
  /workflows/{workflowId}:
    put:
      x-required-scope: workflow:update
      parameters:
        - name: publishIfActive
          in: query
  /workflows/{workflowId}/transfer:
    put:
      x-required-scope: workflow:move
`)
    const grant = { scopes: ["communityPackage:update", "promotions:discover", "workflow:update"], workflowIds: [] }
    expect(checkCall(slashes, grant, "PATCH", "/community-packages/%40scope%2Fnodes", none)).toMatchObject({
      allowed: true,
      path: "/community-packages/%40scope%2Fnodes",
    })
    expect(
      checkCall(slashes, grant, "GET", "/promotions/providers/p1/repositories/group%2Fsub%2Frepo/branches", none),
    ).toMatchObject({ allowed: true, path: "/promotions/providers/p1/repositories/group%2Fsub%2Frepo/branches" })
    for (const name of ["%40scope%2F..", "%2Fnodes", "nodes%2F", "a%2F%2Fb"])
      expect(checkCall(slashes, grant, "PATCH", `/community-packages/${name}`, none).allowed, name).toBe(false)
    expect(
      checkCall(slashes, grant, "GET", "/promotions/providers/p1%2Fx/repositories/group%2Frepo/branches", none).allowed,
    ).toBe(false)
    expect(checkCall(slashes, grant, "PUT", "/workflows/w1%2Ftransfer", none).allowed).toBe(false)
  })

  it("sends the query as n8n-ops read it", () => {
    expect(checkCall(spec, whole, "GET", "/executions", q("status=error&limit=5&cursor=a+b%3D"))).toMatchObject({
      allowed: true,
      query: "status=error&limit=5&cursor=a+b%3D",
    })
    const padded = q(`${"&".repeat(1500)}workflowId=w1`)
    expect(checkCall(spec, limited, "GET", "/executions", padded)).toMatchObject({
      allowed: true,
      query: "workflowId=w1",
    })
  })

  it("refuses a query n8n could read differently", () => {
    const many = Array.from({ length: 101 }, (_, i) => `p${i}=1`).join("&")
    for (const text of [
      `${many}&workflowId=w1`,
      "workflowId=w1&workflowId=w2",
      "workflow%49d=w2&workflowId=w1",
      "workflowId[]=w2&workflowId=w1",
      "workflowId=w1&a[b]=1",
    ]) {
      expect(checkCall(spec, limited, "GET", "/executions", q(text)).allowed, text).toBe(false)
      expect(checkCall(spec, whole, "GET", "/executions", q(text)).allowed, text).toBe(false)
    }
    const hundred = Array.from({ length: 99 }, (_, i) => `p${i}=1`).join("&")
    expect(checkCall(spec, limited, "GET", "/executions", q(`${hundred}&workflowId=w1`)).allowed).toBe(true)
  })

  describe("updating a workflow", () => {
    const update = { scopes: ["workflow:update"], workflowIds: [] }
    const publish = { scopes: ["workflow:update", "workflow:activate"], workflowIds: [] }

    it("saves without publishing when the access does not include workflow:activate", () => {
      expect(checkCall(spec, update, "PUT", "/workflows/w1", none)).toMatchObject({
        allowed: true,
        query: "publishIfActive=false",
      })
      expect(checkCall(spec, update, "PUT", "/workflows/w1", q("publishIfActive=false"))).toMatchObject({
        allowed: true,
        query: "publishIfActive=false",
      })
      expect(checkCall(spec, { ...update, workflowIds: ["w1"] }, "PUT", "/workflows/w1", none)).toMatchObject({
        allowed: true,
        query: "publishIfActive=false",
      })
      for (const asked of ["true", "TRUE", ""]) {
        const d = checkCall(spec, update, "PUT", "/workflows/w1", q(`publishIfActive=${asked}`))
        expect(d.allowed, asked).toBe(false)
        expect(!d.allowed && d.reason).toContain("workflow:activate")
      }
    })

    it("leaves publishing to n8n when the access includes workflow:activate", () => {
      expect(checkCall(spec, publish, "PUT", "/workflows/w1", none)).toMatchObject({ allowed: true, query: "" })
      expect(checkCall(spec, publish, "PUT", "/workflows/w1", q("publishIfActive=true"))).toMatchObject({
        allowed: true,
        query: "publishIfActive=true",
      })
    })

    it("needs workflow:activate on an n8n version that publishes every update", () => {
      const d = checkCall(idSpec, update, "PUT", "/workflows/w1", none)
      expect(d.allowed).toBe(false)
      expect(!d.allowed && d.reason).toContain("workflow:activate")
      expect(checkCall(idSpec, publish, "PUT", "/workflows/w1", none).allowed).toBe(true)
    })

    it("finds the parameter where the description refers to it", () => {
      const referred = parseSpec(`
components:
  parameters:
    publish:
      name: publishIfActive
      in: query
paths:
  /workflows/{id}:
    put:
      x-required-scope: workflow:update
      parameters:
        - $ref: '#/components/parameters/publish'
`)
      expect(checkCall(referred, update, "PUT", "/workflows/w1", none)).toMatchObject({
        allowed: true,
        query: "publishIfActive=false",
      })
    })
  })
})
