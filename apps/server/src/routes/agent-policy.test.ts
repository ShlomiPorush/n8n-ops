import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { features } from "../features.ts"
import { agentGuard } from "../http/agent-guard.ts"
import { AREAS, DATA_SENTENCE, honoPath, listing, OPEN, REVISION, updateSkillNotice } from "./agent-policy.ts"

/*
 * The closed route table (the agent-access standard): every route of the app is open to agents in OPEN
 * (agent-policy.ts), or MCP, or closed here with the reason. A new route fails this test until someone decides.
 * Agents reach only /api/v1 and /mcp with their tokens; a Bearer token anywhere else is refused before any route
 * runs (http/agent-guard.ts), and the console's routes take only a browser session.
 */

const PEOPLE = "a page or API of the console, for a signed-in person only"
const OAUTH = "the authorization server's own endpoint, not a call made as the person"
const SIGN_IN = "sign-in, two-factor and passkeys (Better Auth), for people only"
const CLOSED: Record<string, string> = {
  "ALL /*": "the console's web pages and their files",
  "ALL /api/*": "the API's catch-all (not found)",
  "ALL /api/access/*": "approving or ending temporary access is for people only",
  "ALL /api/admin/*": "agent connections, tokens, keys and the audit log are for people only",
  "ALL /api/alerts/*": PEOPLE,
  "ALL /api/auth/sign-up/*": SIGN_IN,
  "ALL /api/backups/*": PEOPLE,
  "ALL /api/destinations/*": PEOPLE,
  "ALL /api/events/*": PEOPLE,
  "ALL /api/instances/*": PEOPLE,
  "ALL /api/overview/*": PEOPLE,
  "ALL /api/problems/*": PEOPLE,
  "ALL /api/session/*": "the browser session's clocks, for a signed-in person only",
  "ALL /api/settings/*": "settings are for people only",
  "ALL /api/v1/*": "the agent API's token check and body limit, and its catch-all (not found)",
  "ALL /api/workers/*": PEOPLE,
  "ALL /api/workflows/*": PEOPLE,
  "ALL /assets/*": "the console's web pages and their files",
  "ALL /compact/assets/*": "the console's web pages and their files",
  "ALL /connect/device": OAUTH,
  "ALL /connect/device/*": OAUTH,
  "ALL /n8n/*": "the temporary access proxy, with a key a person approved for one task",
  "ALL /n8n/:instance/api/v1/*": "the temporary access proxy, with a key a person approved for one task",
  "ALL /oauth/*": OAUTH,
  "DELETE /api/admin/tokens/:id": "agent connections, tokens, keys and the audit log are for people only",
  "DELETE /api/backups/restores/:id": PEOPLE,
  "DELETE /api/destinations/:id": PEOPLE,
  "DELETE /api/instances/:id{[0-9a-fA-F-]{36}}": PEOPLE,
  "DELETE /api/instances/:id{[0-9a-fA-F-]{36}}/capabilities/:capability": PEOPLE,
  "DELETE /api/workers/:id": PEOPLE,
  "GET /*": "the console's web pages and their files",
  "GET /.well-known/oauth-authorization-server": OAUTH,
  "GET /.well-known/oauth-protected-resource": OAUTH,
  "GET /.well-known/oauth-protected-resource/api/v1": OAUTH,
  "GET /.well-known/oauth-protected-resource/mcp": OAUTH,
  "GET /.well-known/openid-configuration": OAUTH,
  "GET /api/access": "approving or ending temporary access is for people only",
  "GET /api/access/:id": "approving or ending temporary access is for people only",
  "GET /api/admin/agents": "agent connections, tokens, keys and the audit log are for people only",
  "GET /api/admin/database": "measuring and compacting the database is for people only",
  "GET /api/admin/database/status": "measuring and compacting the database is for people only",
  "POST /api/admin/database/compact": "measuring and compacting the database is for people only",
  "POST /api/admin/database/measure": "measuring and compacting the database is for people only",
  "GET /api/admin/audit": "agent connections, tokens, keys and the audit log are for people only",
  "GET /api/admin/keys": "agent connections, tokens, keys and the audit log are for people only",
  "GET /api/admin/keys/app": "agent connections, tokens, keys and the audit log are for people only",
  "GET /api/admin/tokens": "agent connections, tokens, keys and the audit log are for people only",
  "GET /api/alerts/report-preview": PEOPLE,
  "GET /api/auth/*": SIGN_IN,
  "GET /api/backups": PEOPLE,
  "GET /api/backups/:instanceId/restores": PEOPLE,
  "GET /api/backups/:instanceId/runs": PEOPLE,
  "GET /api/backups/restores/:id": PEOPLE,
  "GET /api/destinations": PEOPLE,
  "GET /api/events": PEOPLE,
  "GET /api/instances": PEOPLE,
  "GET /api/instances/:id{[0-9a-fA-F-]{36}}": PEOPLE,
  "GET /api/instances/:id{[0-9a-fA-F-]{36}}/health-history": PEOPLE,
  "GET /api/instances/:id{[0-9a-fA-F-]{36}}/setup": PEOPLE,
  "GET /api/overview": PEOPLE,
  "GET /api/overview/attention": PEOPLE,
  "GET /api/overview/summary": PEOPLE,
  "GET /api/problems": PEOPLE,
  "GET /api/problems/:id": PEOPLE,
  "GET /api/problems/:id/failures/:failureId": PEOPLE,
  "GET /api/problems/rows": PEOPLE,
  "GET /api/session": "the browser session's clocks, for a signed-in person only",
  "GET /api/settings/:section": "settings are for people only",
  "GET /api/setup/checklist": "first-run setup, for a person in the browser",
  "GET /api/setup/status": "first-run setup, for a person in the browser",
  "GET /api/worker/jobs/next": "the Worker's own API, with the Worker's token",
  "GET /api/workers": PEOPLE,
  "GET /api/workers/:id/health": PEOPLE,
  "GET /api/workflows": PEOPLE,
  "GET /assets/*": "the console's web pages and their files",
  "GET /compact/assets/*": "the console's web pages and their files",
  "GET /connect/approve/:uid/request": "approving an agent is for a signed-in person only",
  "GET /connect/skill": "the skill's files, public and without a token, for agents to install",
  "GET /connect/skill/*": "the skill's files, public and without a token, for agents to install",
  "GET /healthz/live": "the container's health checks, with no data",
  "GET /healthz/ready": "the container's health checks, with no data",
  "PATCH /api/destinations/:id": PEOPLE,
  "PATCH /api/instances/:id{[0-9a-fA-F-]{36}}": PEOPLE,
  "POST /api/access/:id/approve": "approving or ending temporary access is for people only",
  "POST /api/access/:id/deny": "approving or ending temporary access is for people only",
  "POST /api/access/:id/revoke": "approving or ending temporary access is for people only",
  "POST /api/admin/agents/disconnect-all": "agent connections, tokens, keys and the audit log are for people only",
  "POST /api/admin/keys/backup": "agent connections, tokens, keys and the audit log are for people only",
  "POST /api/admin/keys/backup/confirm": "agent connections, tokens, keys and the audit log are for people only",
  "POST /api/admin/tokens": "agent connections, tokens, keys and the audit log are for people only",
  "POST /api/alerts/test/email": PEOPLE,
  "POST /api/alerts/test/telegram": PEOPLE,
  "POST /api/auth/*": SIGN_IN,
  "POST /api/backups/:instanceId/run": PEOPLE,
  "POST /api/backups/restores/:id/check": PEOPLE,
  "POST /api/backups/restores/:id/confirm": PEOPLE,
  "POST /api/backups/runs/:runId/inspect": PEOPLE,
  "POST /api/backups/runs/:runId/restores": PEOPLE,
  "POST /api/backups/runs/:runId/workflows/:workflowId": PEOPLE,
  "POST /api/backups/versions/:restoreId/inspect": PEOPLE,
  "POST /api/backups/versions/:restoreId/restores": PEOPLE,
  "POST /api/backups/versions/:restoreId/workflows/:workflowId": PEOPLE,
  "POST /api/destinations": PEOPLE,
  "POST /api/destinations/:id/test": PEOPLE,
  "POST /api/destinations/host-key": PEOPLE,
  "POST /api/instances": PEOPLE,
  "POST /api/instances/:id/export-credentials": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/activate": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/refresh": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/setup/api": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/setup/backup": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/setup/health": PEOPLE,
  "POST /api/instances/:id{[0-9a-fA-F-]{36}}/setup/worker": PEOPLE,
  "POST /api/instances/test": PEOPLE,
  "POST /api/problems/:id/merge": PEOPLE,
  "POST /api/problems/:id/mute": PEOPLE,
  "POST /api/problems/:id/reopen": PEOPLE,
  "POST /api/problems/:id/resolve": PEOPLE,
  "POST /api/problems/:id/undo/:receipt": PEOPLE,
  "POST /api/problems/:id/unmute": PEOPLE,
  "POST /api/problems/:id/workflows/:workflowId/mute": PEOPLE,
  "POST /api/problems/:id/workflows/:workflowId/reopen": PEOPLE,
  "POST /api/problems/:id/workflows/:workflowId/resolve": PEOPLE,
  "POST /api/problems/:id/workflows/:workflowId/split": PEOPLE,
  "POST /api/problems/:id/workflows/:workflowId/unmute": PEOPLE,
  "POST /api/session/activity": "the browser session's clocks, for a signed-in person only",
  "POST /api/setup/account": "first-run setup, for a person in the browser",
  "POST /api/telegram/webhook": "Telegram's webhook, with its secret header",
  "POST /api/worker/heartbeat": "the Worker's own API, with the Worker's token",
  "POST /api/worker/jobs/:id/result": "the Worker's own API, with the Worker's token",
  "POST /api/worker/jobs/:id/upload-url": "the Worker's own API, with the Worker's token",
  "POST /api/worker/pair": "the Worker's own API, with the Worker's token",
  "POST /api/workers/:id/allowed/patterns": PEOPLE,
  "POST /api/workers/pairing": PEOPLE,
  "POST /api/workflows/moves": PEOPLE,
  "POST /api/workflows/moves/preview": PEOPLE,
  "POST /api/workflows/sync": PEOPLE,
  "POST /connect/approve/:uid/decision": "approving an agent is for a signed-in person only",
  "PUT /api/instances/:id{[0-9a-fA-F-]{36}}/backup-destinations": PEOPLE,
  "PUT /api/settings/:section": "settings are for people only",
  "PUT /api/worker/jobs/:id/archive": "the Worker's own API, with the Worker's token",
  "PUT /api/workers/:id/allowed": PEOPLE,
}

/** The MCP server: open to agents, each tool with its area and kind in routes/agent.ts. */
const MCP = new Set(["ALL /mcp", "ALL /mcp/*"])

function fakeCtx(): Ctx {
  const agents = {
    hooks: {},
    skillDir: undefined,
    provider: async () => null,
    enabled: async () => false,
  }
  return {
    version: "test",
    checkDatabase: async () => true,
    log: { info() {}, warn() {}, error() {} },
    auth: async () => ({ auth: { handler: async () => new Response("auth"), api: { getSession: async () => null } } }),
    events: { emit() {}, on() {}, off() {} },
    agents,
  } as unknown as Ctx
}

const web = `.test-policy-web-${process.pid}`
let routes: string[] = []

beforeAll(() => {
  mkdirSync(`${web}/assets`, { recursive: true })
  writeFileSync(`${web}/index.html`, "<html></html>")
  const ctx = fakeCtx()
  const app = createApp(ctx, { webDir: web, mounts: features(ctx).mounts })
  routes = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].sort()
})
afterAll(() => rmSync(web, { recursive: true, force: true }))

const open = new Set(OPEN.map((r) => `${r.method} ${honoPath(r.path)}`))

describe("the closed route table", () => {
  it("classifies every route of the app, once", () => {
    const unclassified = routes.filter((r) => !open.has(r) && !MCP.has(r) && !(r in CLOSED))
    expect(
      unclassified,
      `Classify these routes in agent-policy.ts (OPEN) or here (CLOSED, with a reason):\n${unclassified.join("\n")}`,
    ).toEqual([])
    for (const r of Object.keys(CLOSED)) expect(open.has(r) || MCP.has(r), r).toBe(false)
  })

  it("names only routes the app has", () => {
    for (const r of [...open, ...Object.keys(CLOSED)]) expect(routes, r).toContain(r)
  })

  it("gives every closed route a reason, and every open route a known area, kind and description", () => {
    for (const [r, reason] of Object.entries(CLOSED)) expect(reason.length, r).toBeGreaterThan(10)
    for (const r of OPEN) {
      expect(r.area === null || r.area in AREAS, r.path).toBe(true)
      expect(["read", "act"]).toContain(r.kind)
      expect(r.description.length).toBeGreaterThan(20)
      expect(r.path.startsWith("/api/v1/"), r.path).toBe(true)
    }
  })

  it("keeps people's things closed: connections, tokens, settings, sign-in, audit, keys", () => {
    for (const r of routes.filter((x) => /\/api\/(admin|settings|auth|session|setup)\b/.test(x)))
      expect(open.has(r) || MCP.has(r), r).toBe(false)
  })

  it("says the data sentence in every description of a route that returns n8n's data", () => {
    for (const r of OPEN.filter((x) => x.area === "read")) expect(r.description, r.path).toContain(DATA_SENTENCE)
  })

  it("classifies by effect: collecting the one-time key is an act, though it is a GET", () => {
    expect(OPEN.find((r) => r.path === "/api/v1/access-requests/{id}")).toMatchObject({ method: "GET", kind: "act" })
  })
})

describe("the endpoints listing", () => {
  it("lists only the areas a connection holds, with the revision", () => {
    const readOnly = listing(["read"])
    expect(readOnly.revision).toBe(REVISION)
    expect(readOnly.revision).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
    expect(readOnly.endpoints.some((e) => e.area === "access")).toBe(false)
    expect(readOnly.count).toBe(readOnly.endpoints.length)
    expect(listing(["read", "access"]).endpoints.some((e) => e.path === "/api/v1/access-requests")).toBe(true)
    expect(listing(["read", "access"], "access").endpoints.every((e) => e.area === "access" || e.area === "any")).toBe(
      true,
    )
  })
})

describe("the skill version notice", () => {
  const base = "https://ops.example.com"
  it("tells an old served copy where the new one is, and an old Git copy to update where it came from", () => {
    expect(updateSkillNotice("abc123abc123", "abc123abc123", base)).toBeNull()
    expect(updateSkillNotice("000000000000", "abc123abc123", base)).toContain(`${base}/connect/skill/`)
    expect(updateSkillNotice(undefined, "abc123abc123", base)).toContain("newer skill")
    expect(updateSkillNotice("r0", "abc123abc123", base)).toContain("older than this n8n-ops")
    expect(updateSkillNotice("r1", "abc123abc123", base)).toBeNull()
    expect(updateSkillNotice("r9", "abc123abc123", base)).toBeNull()
  })
})

describe("Bearer tokens outside the agent routes", () => {
  const guarded = async (path: string, headers: Record<string, string>) => {
    const { Hono } = await import("hono")
    const app = new Hono()
    app.use("*", agentGuard)
    app.all("*", (c) => c.text("reached"))
    return app.request(path, { headers })
  }

  it("are refused before any route runs, also with a browser session beside them", async () => {
    for (const auth of ["Bearer abc", "bearer abc", "Bearer", "Basic x, Bearer y"]) {
      const res = await guarded("/api/admin/tokens", { authorization: auth, cookie: "better-auth.session_token=x" })
      expect(res.status, auth).toBe(403)
    }
  })

  it("reach the agent routes and the other channels with their own checks", async () => {
    for (const path of ["/api/v1/problems", "/mcp", "/api/worker/jobs", "/n8n/x/api/v1/workflows", "/oauth/token"])
      expect(await (await guarded(path, { authorization: "Bearer abc" })).text(), path).toBe("reached")
    expect(await (await guarded("/api/admin/tokens", { cookie: "x=y" })).text()).toBe("reached")
  })
})
