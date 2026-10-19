// A stand-in for n8n-ops' authorization server and REST API, strict like the real one: a refresh token or device code
// used twice ends the whole grant. Tests drive it through its state and a few switches.
import { randomBytes } from "node:crypto"
import http from "node:http"

const id = () => randomBytes(18).toString("base64url")

export async function startFakeServer(port = 0) {
  const s = {
    issuer: "",
    devices: new Map(), // device_code -> { userCode, label, state: pending|approved|denied|used, scope }
    refresh: new Map(), // token -> { grant, consumed }
    access: new Map(), // token -> { grant, exp }
    grants: new Map(), // id -> { alive, scope }
    counts: { device: 0, deviceToken: 0, refresh: 0, revoke: 0, api: 0, reuse: 0 },
    accessTtl: 900,
    refreshAccessTtl: null,
    deviceInterval: undefined,
    dropNextRefresh: false,
    truncateNextRefresh: false,
    refreshDelayMs: 0,
    revokeStatus: 200,
    slowDownOnce: false,
    lastLabel: null,
    lastBody: null,
  }

  const issue = (grant, ttl) => {
    const refresh = id()
    const access = id()
    s.refresh.set(refresh, { grant, consumed: false })
    s.access.set(access, { grant, exp: Date.now() + ttl * 1000 })
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: ttl,
      scope: s.grants.get(grant).scope,
    }
  }
  const endGrant = (grant) => {
    const g = s.grants.get(grant)
    if (g) g.alive = false
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString("utf8")
    const url = new URL(req.url, s.issuer)
    const form = Object.fromEntries(new URLSearchParams(raw))
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(JSON.stringify(body))
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server")
      return send(200, { issuer: s.issuer, token_endpoint: `${s.issuer}/oauth/token` })

    if (req.method === "POST" && url.pathname === "/oauth/device") {
      s.counts.device++
      if (form.client_id !== "n8n-ops-cli") return send(400, { error: "invalid_client" })
      s.lastLabel = form.client_label ?? null
      const deviceCode = id()
      const userCode = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`
      s.devices.set(deviceCode, {
        userCode,
        label: form.client_label,
        state: "pending",
        scope: form.scope,
        resource: form.resource,
      })
      return send(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${s.issuer}/connect/device`,
        verification_uri_complete: `${s.issuer}/connect/device?user_code=${userCode}`,
        expires_in: 600,
        ...(s.deviceInterval ? { interval: s.deviceInterval } : {}),
      })
    }

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      if (form.client_id !== "n8n-ops-cli") return send(400, { error: "invalid_client" })
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        s.counts.deviceToken++
        const d = s.devices.get(form.device_code)
        if (!d) return send(400, { error: "invalid_grant" })
        if (s.slowDownOnce) {
          s.slowDownOnce = false
          return send(400, { error: "slow_down" })
        }
        if (d.state === "pending") return send(400, { error: "authorization_pending" })
        if (d.state === "denied") return send(400, { error: "access_denied" })
        if (d.state === "used") {
          s.counts.reuse++
          if (d.grant) endGrant(d.grant)
          return send(400, { error: "invalid_grant" })
        }
        d.state = "used"
        const grant = id()
        d.grant = grant
        s.grants.set(grant, { alive: true, scope: d.grantScope ?? "ops:read ops:access offline_access" })
        return send(200, issue(grant, s.accessTtl))
      }
      if (form.grant_type === "refresh_token") {
        s.counts.refresh++
        const t = s.refresh.get(form.refresh_token)
        if (!t) return send(400, { error: "invalid_grant" })
        if (t.consumed) {
          s.counts.reuse++
          endGrant(t.grant)
          return send(400, { error: "invalid_grant" })
        }
        if (!s.grants.get(t.grant)?.alive) return send(400, { error: "invalid_grant" })
        t.consumed = true
        if (s.refreshDelayMs) await new Promise((r) => setTimeout(r, s.refreshDelayMs))
        const tokens = issue(t.grant, s.refreshAccessTtl ?? s.accessTtl)
        if (s.dropNextRefresh) {
          s.dropNextRefresh = false
          s.orphan = tokens.refresh_token
          req.socket.destroy()
          return
        }
        if (s.truncateNextRefresh) {
          // The answer starts, then the connection breaks.
          s.truncateNextRefresh = false
          s.orphan = tokens.refresh_token
          res.writeHead(200, { "content-type": "application/json", "content-length": "400" })
          res.write('{"access_token":"')
          setTimeout(() => req.socket.destroy(), 50)
          return
        }
        return send(200, tokens)
      }
      return send(400, { error: "unsupported_grant_type" })
    }

    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      s.counts.revoke++
      if (s.revokeStatus !== 200) return send(s.revokeStatus, { error: "server_error" })
      const t = s.refresh.get(form.token)
      if (t) endGrant(t.grant)
      return send(200, {})
    }

    if (url.pathname.startsWith("/api/v1/")) {
      s.counts.api++
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      const a = s.access.get(bearer)
      if (!a || a.exp < Date.now() || !s.grants.get(a.grant)?.alive)
        return send(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer error="invalid_token"' })
      const scope = s.grants.get(a.grant).scope
      if (url.pathname === "/api/v1/access-requests" && req.method === "POST" && !scope.includes("ops:access"))
        return send(403, { error: "not_allowed", message: "This token may not request access to n8n instances." })
      s.lastBody = raw
      return send(200, {
        data: { method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null },
      })
    }
    send(404, { error: "not_found" })
  })

  await new Promise((r) => server.listen(port, "127.0.0.1", r))
  s.port = server.address().port
  s.issuer = `http://127.0.0.1:${s.port}`
  s.close = () =>
    new Promise((r) => {
      server.closeAllConnections?.()
      server.close(r)
    })
  /** Goes away and comes back on the same address, with the same state. */
  s.stop = s.close
  s.start = () => new Promise((r) => server.listen(s.port, "127.0.0.1", r))
  /** The person approves the latest code, optionally without instance access. */
  s.approve = ({ access = true } = {}) => {
    const d = [...s.devices.values()].at(-1)
    d.state = "approved"
    d.grantScope = access ? "ops:read ops:access offline_access" : "ops:read offline_access"
  }
  s.deny = () => {
    ;[...s.devices.values()].at(-1).state = "denied"
  }
  s.aliveGrants = () => [...s.grants.values()].filter((g) => g.alive).length
  s.expireAccessTokens = () => {
    for (const a of s.access.values()) a.exp = 0
  }
  s.endAllGrants = () => {
    for (const g of s.grants.values()) g.alive = false
  }
  /** Every secret it ever handed out, to check that none shows up in the command's output. */
  s.secrets = () => [...s.refresh.keys(), ...s.access.keys(), ...s.devices.keys()]
  return s
}
