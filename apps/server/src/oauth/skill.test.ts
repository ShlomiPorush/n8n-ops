import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanLabel } from "./label.ts"
import { type AgentProvider, createAgentProvider, resources, SCOPES } from "./provider.ts"
import { servesSkill, skillRoutes } from "./skill.ts"

/*
 * The skill's command (every version this computer runs) against the real authorization server, over loopback:
 * it connects with a code a person approves, reads, refreshes the rotating token, survives ten parallel
 * refreshes, ends when its token is replayed, and disconnects. The provider keeps its records in memory here.
 */

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/skill/n8n-ops")
const win = process.platform === "win32"
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0
const impls = ["node", ...(!win && has("curl", ["--version"]) ? ["sh"] : []), ...(win ? ["ps"] : [])]

let base = ""
let provider: AgentProvider
let server: ReturnType<typeof serve>
const stale = new Set<string>()
let refreshes = 0
let revoked = 0
type Bindings = { incoming: IncomingMessage; outgoing: ServerResponse }
// biome-ignore lint/suspicious/noExplicitAny: responses in these tests are loose JSON or HTML
type Loose = any

const pages = {
  codeInput: (form: string) => `<html>${form}</html>`,
  codeConfirm: (form: string, _name: string, code: string, label: string | null) =>
    `<html><b>${code}</b><i>${label ?? ""}</i>${form}</html>`,
  success: () => "<html>connected</html>",
  error: (code: string) => `<html>error ${code}</html>`,
}

beforeAll(async () => {
  const app = new Hono<{ Bindings: Bindings }>()
  app.post("/connect/approve/:uid/decision", async (c) => {
    const { incoming, outgoing } = c.env
    const { scopes } = (await c.req.json()) as { scopes: string[] }
    const details = await provider.interactionDetails(incoming, outgoing)
    const params = details.params as Record<string, string>
    const grant = new provider.Grant({ accountId: "person", clientId: params.client_id })
    const resource = params.resource ?? resources(base).rest
    grant.addResourceScope(resource, scopes.join(" "))
    // What was asked and not ticked is refused, as on the real approval page.
    const refused = String(params.scope)
      .split(" ")
      .filter((s) => s.startsWith("ops:") && !scopes.includes(s))
    if (refused.length) grant.rejectResourceScope(resource, refused.join(" "))
    grant.addOIDCScope("offline_access")
    const grantId = await grant.save()
    const redirectTo = await provider.interactionResult(
      incoming,
      outgoing,
      { login: { accountId: "person" }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    )
    return c.json({ redirectTo, grantId, label: cleanLabel(params.client_label) })
  })
  // The REST API, stripped to its token check; a token marked stale answers 401 once more, as an expired one would.
  app.all("/api/v1/*", async (c) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "")
    const at = await provider.AccessToken.find(token)
    if (!at || at.aud !== resources(base).rest || stale.has(token)) return c.json({ error: "unauthorized" }, 401)
    return c.json({ data: { path: new URL(c.req.url).pathname, scope: at.scope } })
  })
  app.all("*", (c) => {
    provider.callback()(c.env.incoming, c.env.outgoing)
    return RESPONSE_ALREADY_SENT
  })
  server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.once("listening", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  provider = createAgentProvider({ issuer: base, cookieKeys: ["test-key"], pages })
  provider.on("refresh_token.consumed", () => {
    refreshes++
  })
  provider.on("grant.revoked", () => {
    revoked++
  })
})
afterAll(() => server.close())

const root = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-ops-skill-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function install() {
  const dir = fs.mkdtempSync(path.join(root, "agent-"))
  const target = path.join(dir, ".codex-test", "skills", "n8n-ops")
  fs.cpSync(skill, target, { recursive: true })
  return { scripts: path.join(target, "scripts"), creds: path.join(dir, "creds") }
}

function run(impl: string, inst: ReturnType<typeof install>, args: string[]) {
  const file = (name: string) => path.join(inst.scripts, name)
  const [cmd, pre] =
    impl === "node"
      ? [process.execPath, [file("n8n-ops.mjs")]]
      : impl === "sh"
        ? ["sh", [file("n8n-ops.sh")]]
        : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file("n8n-ops.ps1")]]
  return new Promise<{ code: number | null; json: Loose; out: string }>((resolve) => {
    const child = spawn(cmd as string, [...(pre as string[]), ...args, "--url", base], {
      env: {
        ...process.env,
        N8N_OPS_CREDENTIALS: inst.creds,
        N8N_OPS_NO_NODE: impl === "node" ? "" : "1",
        N8N_OPS_TEST_POLL_SECONDS: "1",
        N8N_OPS_WAIT_SECONDS: "20",
        ...(win ? { USERPROFILE: root } : {}),
      },
    })
    let out = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      out += d
    })
    child.on("close", (code) => {
      let json: Loose = null
      try {
        json = JSON.parse(out.trim().split("\n").at(-1) ?? "")
      } catch {}
      resolve({ code, json, out })
    })
  })
}

/** A browser that keeps cookies and does not follow redirects. */
function browser() {
  const jar = new Map<string, string>()
  return async (p: string, init: { form?: Record<string, string>; json?: unknown } = {}) => {
    const headers: Record<string, string> = {}
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
    let body: string | undefined
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded"
      body = new URLSearchParams(init.form).toString()
    }
    if (init.json) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(init.json)
    }
    const res = await fetch(p.startsWith("http") ? p : base + p, {
      method: body ? "POST" : "GET",
      headers,
      body,
      redirect: "manual",
    })
    for (const c of res.headers.getSetCookie()) {
      const [kv = ""] = c.split(";")
      const [k = "", ...v] = kv.split("=")
      jar.set(k, v.join("="))
    }
    const text = await res.text()
    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {}
    return { status: res.status, location: res.headers.get("location"), data: data as Loose }
  }
}

/** The person opens the link the agent showed, compares the code, and approves with these scopes. */
async function approve(link: string, scopes: string[]) {
  const go = browser()
  const xsrfOf = (html: string) => /name="xsrf" value="([^"]+)"/.exec(html)?.[1] ?? ""
  // The link carries the code: its page submits it at once, and the answer asks to compare it.
  const input = await go(new URL(link).pathname + new URL(link).search)
  const userCode = new URL(link).searchParams.get("user_code") ?? ""
  const page = await go("/connect/device", { form: { xsrf: xsrfOf(input.data), user_code: userCode } })
  const confirm = await go("/connect/device", {
    form: { xsrf: xsrfOf(page.data), user_code: userCode, confirm: "yes" },
  })
  const uid = confirm.location?.split("/connect/approve/")[1] ?? ""
  const approval = await go(`/connect/approve/${uid}/decision`, { json: { scopes } })
  await go(approval.data.redirectTo)
  return { page: page.data as string, label: approval.data.label as string | null }
}

const record = (inst: ReturnType<typeof install>) => {
  const [file] = fs.readdirSync(inst.creds).filter((f) => f.endsWith(".json"))
  return JSON.parse(fs.readFileSync(path.join(inst.creds, file ?? ""), "utf8"))
}

for (const impl of impls) {
  describe(`the skill's command (${impl}) against the real authorization server`, () => {
    it("connects with a code, reads, refreshes once for ten at a time, and ends on a replayed token", async () => {
      const inst = install()
      const c = await run(impl, inst, ["connect"])
      expect(c.json?.status, c.out).toBe("pending")
      const { page, label } = await approve(c.json.link, [SCOPES.read, SCOPES.access])
      expect(label).toMatch(/^Codex \(\.codex-test\) on /)
      expect(page).toContain(`<i>${label}</i>`)
      const w = await run(impl, inst, ["connect", "--wait"])
      expect(w.json, w.out).toMatchObject({ status: "connected", scope: "ops:read ops:access" })

      const r = await run(impl, inst, ["get", "problems"])
      expect(r.json?.data, r.out).toMatchObject({ path: "/api/v1/problems", scope: "ops:read ops:access" })

      // The access token stops working: ten commands at once refresh it once, and none replays the old token.
      stale.add(record(inst).accessToken)
      const before = refreshes
      const all = await Promise.all(Array.from({ length: 10 }, () => run(impl, inst, ["get", "instances"])))
      for (const one of all) expect(one.code, one.out).toBe(0)
      expect(refreshes - before).toBe(1)
      expect(revoked).toBe(0)

      // A copy of the refresh token used elsewhere: the provider ends the grant, and the command says so.
      const copy = record(inst).refreshToken
      const thief = await browser()("/oauth/token", {
        form: { grant_type: "refresh_token", refresh_token: copy, client_id: "n8n-ops-cli" },
      })
      expect(thief.status).toBe(200)
      stale.add(record(inst).accessToken)
      const after = await run(impl, inst, ["get", "instances"])
      expect(after.json?.error, after.out).toBe("connection_ended")
      expect(revoked).toBe(1)
      revoked = 0
    }, 120_000)

    it("disconnects, ending the grant at the authorization server", async () => {
      const inst = install()
      const c = await run(impl, inst, ["connect"])
      await approve(c.json.link, [SCOPES.read])
      const w = await run(impl, inst, ["connect", "--wait"])
      expect(w.json?.status, w.out).toBe("connected")
      const { refreshToken } = record(inst)
      const d = await run(impl, inst, ["disconnect"])
      expect(d.json, d.out).toEqual({ status: "disconnected" })
      expect(revoked).toBe(1)
      revoked = 0
      const reuse = await browser()("/oauth/token", {
        form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: "n8n-ops-cli" },
      })
      expect(reuse.data.error).toBe("invalid_grant")
    }, 60_000)
  })
}

describe("a script's name for itself", () => {
  it("keeps plain words, and drops control, direction and markup characters", () => {
    expect(cleanLabel("  Claude Code (.claude-ai2) on SHLOMI-PC ")).toBe("Claude Code (.claude-ai2) on SHLOMI-PC")
    expect(cleanLabel("Agentür on PC")).toBe("Agentür on PC")
    expect(cleanLabel("evil‮txt.exe")).toBeNull()
    expect(cleanLabel("<b>x</b>")).toBeNull()
    expect(cleanLabel("a\nb")).toBeNull()
    expect(cleanLabel("x".repeat(61))).toBeNull()
    expect(cleanLabel("")).toBeNull()
    expect(cleanLabel(42)).toBeNull()
  })
})

describe("serving the skill", () => {
  const app = (issuer: string | null, dir: string | undefined = skill) => {
    const a = new Hono()
    a.route("/", skillRoutes(async () => issuer, dir) as unknown as Hono)
    return a
  }

  it("serves its files with the public URL filled in, never cached", async () => {
    const res = await app("https://ops.example.com").request("/connect/skill/SKILL.md")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    const text = await res.text()
    expect(text).toContain("https://ops.example.com")
    expect(text).not.toContain("__N8N_OPS_URL__")
    const script = await (await app("https://ops.example.com").request("/connect/skill/scripts/n8n-ops.mjs")).text()
    expect(script).toContain('const DEFAULT_URL = "https://ops.example.com"')
    const note = await (await app("https://ops.example.com").request("/connect/skill/")).text()
    expect(note).toContain("https://ops.example.com/connect/skill/scripts/n8n-ops.ps1 → n8n-ops/scripts/n8n-ops.ps1")
    // Text between commands is often folded away, so the link and the code must close the agent's turn.
    expect(note).toContain("prints in the reply that ends your turn")
  })

  it("serves nothing over plain http to another computer, nor other files", async () => {
    expect((await app("http://ops.example.com").request("/connect/skill/SKILL.md")).status).toBe(404)
    expect((await app(null).request("/connect/skill/SKILL.md")).status).toBe(404)
    expect((await app("https://ops.example.com").request("/connect/skill/../package.json")).status).toBe(404)
    expect((await app("https://ops.example.com").request("/connect/skill/scripts/other")).status).toBe(404)
    expect((await app("https://ops.example.com", "").request("/connect/skill/SKILL.md")).status).toBe(404)
    expect(servesSkill("http://127.0.0.1:8080")).toBe(true)
  })
})
