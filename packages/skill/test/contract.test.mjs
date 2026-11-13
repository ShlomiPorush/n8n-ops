// The command's contract, run against every version this computer can run (N8N_OPS_IMPLS picks them): the same
// answers, the same care with the refresh token, which the server cuts off the moment it is used twice, and the same
// care with act calls, which are never sent twice once they may have reached the server.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { startFakeServer } from "./fake-server.mjs"

/* ---- Product constants: the same values as in the scripts' constant block. ---- */
const NAME = "n8n-ops"
const ENV = "N8N_OPS_"
const URL_PLACEHOLDER = "__N8N_OPS_URL__"
const VERSION_PLACEHOLDER = "__N8N_OPS_SKILL_VERSION__"
const SKILL_REVISION = 1
const SCOPE = "ops:read ops:access"
const KINDS_MAGIC = "n8n-ops-kinds"
const CLIENT_ID = "n8n-ops-cli"
const POLICY_HEADER = "x-n8n-ops-policy"
const KIND_HEADER = "x-n8n-ops-kind"
/* ---- End of product constants. ---- */

/*
 * Test-only routes: shapes n8n-ops's table does not have. Each is added to the fake server's table by the one case
 * that needs its shape, so that the protection the case pins stays covered; none of them exists in n8n-ops.
 */
const TEST_ONLY = {
  // Acts next to the read /api/v1/problems/{id}, which an escaped, re-cased or ;-parameter path could reach.
  exportAct: { method: "GET", path: "/api/v1/problems/export", kind: "act", area: "read", description: "Test only." },
  sendAct: { method: "GET", path: "/api/v1/problems/{id}/send", kind: "act", area: "read", description: "Test only." },
  // A static read next to the act GET /api/v1/access-requests/{id}: one path that a read and an act both match.
  staticRead: {
    method: "GET",
    path: "/api/v1/access-requests/export",
    kind: "read",
    area: "access",
    description: "Test only.",
  },
  // A read sent as POST: its kind is read, whatever its method.
  postRead: { method: "POST", path: "/api/v1/problems/search", kind: "read", area: "read", description: "Test only." },
  // A template whose last part takes the rest of the path.
  pathRead: {
    method: "GET",
    path: "/api/v1/test-files/{name:path}",
    kind: "read",
    area: "read",
    description: "Test only.",
  },
}
const route = (name) => ({ ...TEST_ONLY[name] })
// The message a 403 not_allowed becomes: the connection may not ask for instance access.
const NO_ACCESS_SCOPE =
  "This agent may not request access to n8n instances. Ask the person to allow it, then run: n8n-ops connect --replace"
// What the client of earlier releases (up to 0.17) asked for, and the fields of the record it wrote, in its order.
const OLD_SCOPE = "ops:read ops:access offline_access"
const OLD_FIELDS = [
  "v",
  "issuer",
  "label",
  "generation",
  "refreshToken",
  "accessToken",
  "accessExpiresAt",
  "scope",
  "refreshStartedAt",
  "refreshRetried",
  "deviceCode",
  "userCode",
  "link",
  "deviceExpiresAt",
  "interval",
  "nextPollAt",
  "toRevoke",
]

const win = process.platform === "win32"
const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "n8n-ops", "scripts")
// ps is Windows PowerShell 5.1, pwsh PowerShell 7: the same n8n-ops.ps1 runs on both.
const impls = (process.env[`${ENV}IMPLS`] ?? (win ? "node,ps,pwsh" : "node,sh")).split(",").filter(Boolean)
const tmpBase = process.env[`${ENV}TEST_TMP`] || os.tmpdir()
fs.mkdirSync(tmpBase, { recursive: true })
const root = fs.mkdtempSync(path.join(tmpBase, `${NAME}-skill-`))
// A byte order mark, which no JSON starts with.
const BOM = String.fromCharCode(0xfeff)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const connectNext = (issuer) =>
  `End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: ${NAME} connect --wait --url "${issuer}"`
const waitNext = (issuer) => `Not approved yet. Run again: ${NAME} connect --wait --url "${issuer}"`

/**
 * A fresh install of the skill and a credentials folder of its own (a computer user of its own). Pass `creds` for
 * another install of the same user. `url` and `version` fill in the values the server fills in when it serves it.
 */
function install({ creds, url, version } = {}) {
  const base = fs.mkdtempSync(path.join(root, "agent-"))
  const dir = path.join(base, ".claude-test", "skills", NAME, "scripts")
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(scripts)) {
    let text = fs.readFileSync(path.join(scripts, f), "utf8")
    if (url) text = text.replaceAll(URL_PLACEHOLDER, url)
    if (version) text = text.replaceAll(VERSION_PLACEHOLDER, version)
    fs.writeFileSync(path.join(dir, f), text, { mode: fs.statSync(path.join(scripts, f)).mode })
  }
  return { dir, creds: creds ?? path.join(base, "creds"), base }
}

/** Every file under a folder, with its content, to show that nothing in it changed. */
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : "/"])
}

function command(impl, dir) {
  const ps1 = path.join(dir, `${NAME}.ps1`)
  const psArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1]
  if (impl === "node") return [process.execPath, [path.join(dir, `${NAME}.mjs`)]]
  if (impl === "sh") return ["sh", [path.join(dir, `${NAME}.sh`)]]
  if (impl === "pwsh") return ["pwsh", psArgs]
  if (impl === "ps") return ["powershell.exe", psArgs]
  // The entry points agents run, which pick a version themselves.
  if (impl === "entry-sh") return ["sh", [path.join(dir, NAME)]]
  if (impl === "entry-ps") return ["powershell.exe", psArgs]
  throw new Error(`unknown impl ${impl}`)
}

function baseEnv(impl, inst) {
  return {
    ...process.env,
    [`${ENV}URL`]: "",
    [`${ENV}CREDENTIALS`]: inst.creds,
    [`${ENV}NO_NODE`]: impl === "node" ? "" : "1",
    [`${ENV}TEST_POLL_SECONDS`]: "1",
    [`${ENV}TEST_BUSY_WAIT_MS`]: "100",
    [`${ENV}WAIT_SECONDS`]: "8",
    ...(win ? { USERPROFILE: root } : {}),
  }
}

/** Runs one command; resolves with its exit code, its parsed answer and its raw output. No server: no --url. */
function run(impl, inst, server, args, env = {}) {
  const [cmd, base] = command(impl, inst.dir)
  return start(impl, inst, cmd, [...base, ...args, ...(server ? ["--url", server.issuer] : [])], env)
}

/** Starts a process (the command, or a shell that runs it) with the environment of `impl` and `inst`. */
function start(impl, inst, cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...baseEnv(impl, inst), ...env }, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout.on("data", (d) => {
    out += d
  })
  child.stderr.on("data", (d) => {
    err += d
  })
  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      let json = null
      try {
        json = JSON.parse(out.trim().split("\n").at(-1))
      } catch {}
      resolve({ code, json, out, err })
    })
  })
  done.child = child
  return done
}

/**
 * The shells an agent may run a printed hint in, here: each defines the command under test and runs the hint's
 * command as it is. bash with failglob and zsh refuse an unquoted file pattern, such as the brackets of an IPv6
 * address. Returns the shells found and the ones missing.
 */
function hintShells() {
  const works = (cmd, args) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
  const posix = (name, bin, opts) => ({
    name,
    bin,
    args: (line, prefix) => [...opts, "-c", `pre=("$@"); ${NAME}() { "\${pre[@]}" "$@"; }; ${line}`, name, ...prefix],
  })
  const shells = []
  const missing = []
  // On Windows, Git's bash: the bash.exe in System32 is WSL's.
  let bash = "bash"
  if (win) {
    try {
      const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()
      bash = path.resolve(exec, "../../../bin/bash.exe")
    } catch {
      bash = ""
    }
  }
  if (bash && works(bash, ["-O", "failglob", "-c", ":"])) shells.push(posix("bash", bash, ["-O", "failglob"]))
  else missing.push("bash")
  if (!win) {
    if (works("zsh", ["-f", "-c", ":"])) shells.push(posix("zsh", "zsh", ["-f"]))
    else missing.push("zsh")
  }
  if (win)
    shells.push({
      name: "powershell",
      bin: "powershell.exe",
      args: (line) => [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$pre = $env:${ENV}HINT_PREFIX -split "\`n"; function ${NAME} { & $pre[0] $pre[1..($pre.Length - 1)] @args }; ${line}`,
      ],
      env: (prefix) => ({ [`${ENV}HINT_PREFIX`]: prefix.join("\n") }),
    })
  return { shells, missing }
}

/** Runs the command a hint names (what follows `before` in it) in a shell, as an agent would. */
function runHint(shell, impl, inst, text, before) {
  const line = text.split(before)[1]
  assert.ok(line?.startsWith(`${NAME} `), text)
  const [cmd, base] = command(impl, inst.dir)
  const prefix = [win && shell.name === "bash" ? cmd.replaceAll("\\", "/") : cmd, ...base]
  return start(impl, inst, shell.bin, shell.args(line, prefix), {
    // Git's bash would otherwise rewrite arguments that look like paths.
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*",
    [`${ENV}WAIT_SECONDS`]: "2",
    ...shell.env?.(prefix),
  })
}

/**
 * Replaces a file by renaming another onto it, in one step, so the name is never free. On Windows another process
 * may still have the file open for a moment (the PowerShell version reads with delete sharing, and a virus scanner
 * may open a new file), so it tries again for about a second on EPERM or EBUSY.
 */
async function replaceWith(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to)
    } catch (e) {
      if (!win || !["EPERM", "EBUSY"].includes(e.code) || i >= 50) throw e
      await sleep(20)
    }
  }
}

/** Waits until a test hook was reached by a held process. */
async function reached(file) {
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(`${file}.reached`)) return
    await sleep(50)
  }
  throw new Error(`hook ${file} not reached`)
}

async function connected(impl, inst, server, opts) {
  const c = await run(impl, inst, server, ["connect"])
  assert.equal(c.json?.status, "pending", c.out + c.err)
  server.approve(opts)
  const w = await run(impl, inst, server, ["connect", "--wait"])
  assert.equal(w.json?.status, "connected", w.out + w.err)
  return w
}

/** Connected, with the list of allowed calls kept, so the calls after reach the server directly. */
async function listed(impl, inst, server) {
  await connected(impl, inst, server)
  const e = await run(impl, inst, server, ["endpoints"])
  assert.equal(e.code, 0, e.out + e.err)
}

/** A connection made by hand through the device flow, as another client makes it: the tokens the server issues. */
async function handTokens(server, scope = SCOPE) {
  const form = (o) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...o }).toString(),
  })
  const d = await (await fetch(`${server.issuer}/oauth/device`, form({ scope }))).json()
  server.approve()
  const t = await fetch(
    `${server.issuer}/oauth/token`,
    form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code }),
  )
  return t.json()
}

function noSecrets(server, ...results) {
  for (const r of results)
    for (const s of server.secrets()) assert.ok(!r.out.includes(s), "a token appeared in the output")
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

for (const impl of impls) {
  describe(`${NAME} (${impl})`, () => {
    let server
    before(async () => {
      server = await startFakeServer()
    })
    after(() => server.close())
    const fresh = () => {
      server.reset()
      return install()
    }

    it("connects with a code the person approves, named after the computer", async () => {
      const inst = fresh()
      const c = await run(impl, inst, server, ["connect"])
      assert.equal(c.code, 0, c.out + c.err)
      assert.equal(c.json.status, "pending")
      assert.match(c.json.link, new RegExp(`^${server.issuer}/connect/device\\?user_code=`))
      assert.match(c.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      // The same hint from every version: the link and the code go in the reply that ends the agent's turn.
      assert.equal(c.json.next, connectNext(server.issuer))
      assert.match(server.last.label, /^Agents on .+/)
      assert.equal(server.last.deviceScope, SCOPE)
      assert.equal(server.last.resource, `${server.issuer}/api/v1`)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "pending")
      // Asking again while the code is open shows the same code, without a new one.
      const again = await run(impl, inst, server, ["connect"])
      assert.equal(again.json.code, c.json.code)
      // Unless the person needs a new one.
      const renewed = await run(impl, inst, server, ["connect", "--replace"])
      assert.notEqual(renewed.json.code, c.json.code)
      server.approve()
      const w = await run(impl, inst, server, ["connect", "--wait"])
      assert.equal(w.json.status, "connected", w.out + w.err)
      assert.equal(w.json.scope, SCOPE)
      const s = await run(impl, inst, server, ["status"])
      assert.equal(s.json.status, "connected")
      assert.ok(s.json.accessExpiresIn > 800)
      noSecrets(server, c, w, s)
      // Connected already: no new code unless asked to replace.
      assert.equal((await run(impl, inst, server, ["connect"])).json.status, "already_connected")
    })

    it("keeps waiting while the code is not approved, then says so", async () => {
      const inst = fresh()
      await run(impl, inst, server, ["connect"])
      server.slowDownOnce = true
      const w = await run(impl, inst, server, ["connect", "--wait"], { [`${ENV}WAIT_SECONDS`]: "3" })
      assert.equal(w.code, 0, w.out + w.err)
      assert.equal(w.json.status, "still_waiting")
      assert.equal(w.json.next, waitNext(server.issuer))
      server.deny()
      const d = await run(impl, inst, server, ["connect", "--wait"])
      assert.equal(d.json.error, "denied")
      assert.equal(d.code, 1)
    })

    it("reads the API with the stored access token, refreshing only when it runs out", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      const before = server.counts.refresh
      const r = await run(impl, inst, server, ["get", "/api/v1/problems?status=open"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json.data.path, "/api/v1/problems")
      assert.equal(r.json.data.query, "?status=open")
      assert.equal(server.counts.refresh, before, "no refresh while the token lasts")
      server.expireAccessTokens()
      const again = await run(impl, inst, server, ["get", "/api/v1/problems/12"])
      assert.equal(again.code, 0, again.out + again.err)
      assert.equal(server.counts.refresh, before + 1, "one refresh after the token refusal")
      assert.equal(server.counts.reuse, 0)
      noSecrets(server, r, again)
    })

    it("refreshes once when ten commands find the token about to run out at the same time", async () => {
      const inst = fresh()
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      const before = server.counts.refresh
      const all = await Promise.all(
        Array.from({ length: 10 }, () => run(impl, inst, server, ["get", "/api/v1/problems"])),
      )
      for (const r of all) assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.counts.refresh, before + 1)
      assert.equal(server.counts.reuse, 0)
    })

    it("posts a JSON body, and passes on the server's own refusals and failures", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      const body = path.join(inst.base, "body.json")
      const ask = {
        instances: [{ instance: "main", scopes: ["workflow:read"] }],
        reason: "Read a workflow.",
        minutes: 15,
      }
      fs.writeFileSync(body, JSON.stringify(ask))
      const r = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json-file", body])
      assert.equal(r.code, 0, r.out + r.err)
      assert.deepEqual(r.json.data.body, ask)
      const empty = await run(impl, inst, server, ["post", "/api/v1/access-requests/4/release"])
      assert.equal(empty.json?.data?.method, "POST", empty.out + empty.err)
      assert.deepEqual(empty.json.data.body, {})
      server.afterRun.push({
        status: 409,
        body: { error: "request_in_progress", message: "Another access request of this agent is still being made." },
      })
      const refused = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json-file", body])
      assert.equal(refused.json?.error, "request_in_progress", refused.out + refused.err)
      assert.equal(refused.json.message, "Another access request of this agent is still being made.")
      assert.equal(refused.json.status, 409)
      // A connection the person did not allow to ask for instance access: n8n-ops refuses with not_allowed, which
      // the command names insufficient_scope and tells the agent how to get it.
      server.afterRun.push({ status: 403, body: { error: "not_allowed", message: "Ask a person to allow it." } })
      const scope = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json-file", body])
      assert.equal(scope.json?.error, "insufficient_scope", scope.out + scope.err)
      assert.equal(scope.json.message, NO_ACCESS_SCOPE)
      assert.equal(scope.json.status, 403)
      assert.equal(scope.code, 1)
      // Only the exact marker of a top object: another code, or not_allowed under another status, is passed on.
      server.afterRun.push({ status: 403, body: { error: "forbidden", message: "Not for agents." } })
      const other = await run(impl, inst, server, ["post", "/api/v1/access-requests/4/release"])
      assert.equal(other.json?.error, "forbidden", other.out + other.err)
      server.afterRun.push({ status: 403, body: '{"Error":"not_allowed","message":"Other key."}' })
      const otherKey = await run(impl, inst, server, ["post", "/api/v1/access-requests/4/release"])
      assert.equal(otherKey.json?.error, "http_403", otherKey.out + otherKey.err)
      server.afterRun.push({ status: 400, body: { error: "not_allowed", message: "Not this instance." } })
      const notScope = await run(impl, inst, server, ["post", "/api/v1/access-requests/4/release"])
      assert.equal(notScope.json?.error, "not_allowed", notScope.out + notScope.err)
      server.afterRun.push({ status: 200, body: { success: false, reason: "duplicate" } })
      const failed = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", "{}"])
      assert.equal(failed.json?.error, "failed", failed.out + failed.err)
      assert.equal(failed.code, 1)
      const notJson = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", "name=x"])
      assert.equal(notJson.json?.error, "bad_body", notJson.out + notJson.err)
    })

    it("sends a body that is JSON, any JSON, and refuses anything else before sending", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      // From a file, so that no shell or argument quoting changes them on the way.
      const file = path.join(inst.base, "body.json")
      let sent = 0
      for (const [text, value] of [
        ["null", null],
        ["12", 12],
        ['"text"', "text"],
        ["[1,2]", [1, 2]],
        ['{"a":{"b":[true,false,null,-0.5e+2]}}', { a: { b: [true, false, null, -50] } }],
        [' \t{"x":"\\u00e9\\n"}\r\n', { x: "\xe9\n" }],
      ]) {
        fs.writeFileSync(file, text)
        const r = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json-file", file])
        assert.deepEqual(r.json?.data?.body, value, `${JSON.stringify(text)}: ${r.out}${r.err}`)
        sent++
      }
      for (const text of [
        "",
        " ",
        '{"name":',
        '{"name":"a"',
        "{'a':1}",
        "{a:1}",
        "01",
        "NaN",
        "[1,]",
        '{"a":1,}',
        '{"a":1} x',
        '{"a":1}{"b":2}',
        '"\\x"',
        '"a\tb"',
        "/*c*/{}",
        "tru",
        `${BOM}{}`,
      ]) {
        fs.writeFileSync(file, text)
        const r = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json-file", file])
        assert.equal(r.json?.error, "bad_body", `${JSON.stringify(text)}: ${r.out}${r.err}`)
      }
      assert.equal(server.arrivals("POST", "/api/v1/access-requests"), sent, "nothing else was sent")
    })

    it("has only get and post: put, patch and delete are unknown commands that send nothing", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      const arrived = () => [...server.arrivalCounts.values()].reduce((a, b) => a + b, 0)
      const listedArrivals = arrived()
      for (const command of ["put", "patch", "delete"]) {
        const r = await run(impl, inst, server, [command, "/api/v1/access-requests/5", "--json", "{}"])
        assert.equal(r.json?.error, "unknown_command", `${command}: ${r.out}${r.err}`)
        assert.equal(r.code, 1)
      }
      assert.equal(arrived(), listedArrivals, "nothing reached the API")
    })

    it("refuses an address without https, and a path outside the API", async () => {
      const inst = fresh()
      const [cmd, base] = command(impl, inst.dir)
      const res = await new Promise((resolve) => {
        const child = spawn(cmd, [...base, "status", "--url", "http://example.com"], { env: baseEnv(impl, inst) })
        let out = ""
        child.stdout.on("data", (d) => {
          out += d
        })
        child.on("close", (code) => resolve({ code, json: JSON.parse(out.trim()) }))
      })
      assert.equal(res.json.error, "insecure_url")
      await connected(impl, inst, server)
      for (const p of [
        "/api/v1/../oauth/token",
        "/api/v1/%2e%2e/oauth/token",
        "/api/v1/%2E%2e/%2e%2E/oauth/token",
        "/api/v1/../../oauth/token",
        "/api/v1/./problems",
        "https://evil.example/api/v1/problems",
        "//evil.example/api/v1/problems",
        "/api/v1/a b",
        "/oauth/token",
        "/api/v1/",
        "/api/v1",
        // Outside the API version the token is for, and the relative paths the client of earlier releases took.
        "/api/problems",
        "/api/v2/problems",
        "problems",
        "problems?status=open",
      ]) {
        const r = await run(impl, inst, server, ["get", p])
        assert.equal(r.json?.error, "bad_path", `${p}: ${r.out}`)
      }
      assert.equal([...server.arrivalCounts.values()].reduce((a, b) => a + b, 0), 0, "nothing reached the API")
    })

    it("refuses an escape in the path that a server would decode into another call, and sends nothing", async () => {
      const inst = fresh()
      // Act routes next to the read route /api/v1/problems/{id}, which the encoded paths below match as they are. The
      // fake server decodes the path before it routes, as many real servers do. (Test-only routes.)
      server.policy.unshift(route("sendAct"), route("exportAct"))
      await listed(impl, inst, server)
      const arrived = () => [...server.arrivalCounts.values()].reduce((a, b) => a + b, 0)
      const listedArrivals = arrived()
      for (const p of [
        "/api/v1/problems/7%2Fsend",
        "/api/v1/problems/7%2fsend",
        "/api/v1/problems/7%5Csend",
        "/api/v1/problems/7%5csend",
        "/api/v1/problems/7%252Fsend",
        "/api/v1/problems/%65xport",
        "/api/v1/problems/expor%74",
        "/api/v1/problems/%45%58",
        "/api/v1/problems/7%3Asend",
        "/api/v1/problems/7%7E",
        "/api/v1/problems/7%",
        "/api/v1/problems/7%2",
        "/api/v1/problems/7%zz",
      ]) {
        const r = await run(impl, inst, server, ["get", p])
        assert.equal(r.json?.error, "bad_path", `${p}: ${r.out}${r.err}`)
      }
      assert.equal(arrived(), listedArrivals, "nothing reached the API")
      // Other escapes in the path, and any escape in the query, are sent as they are.
      const spaced = await run(impl, inst, server, ["get", "/api/v1/problems/a%20b"])
      assert.equal(spaced.json?.data?.path, "/api/v1/problems/a%20b", spaced.out + spaced.err)
      const q = await run(impl, inst, server, ["get", "/api/v1/problems?q=a%2Fb%5Cc%25d"])
      assert.equal(q.json?.data?.query, "?q=a%2Fb%5Cc%25d", q.out + q.err)
      assert.equal(server.runs("GET", "/api/v1/problems/{id}/send"), 0)
      assert.equal(server.runs("GET", "/api/v1/problems/export"), 0)
    })

    it("never runs an act that a case-insensitive router picked for a path the list holds as a read", async () => {
      const inst = fresh()
      // /api/v1/problems/EXPORT matches the read /api/v1/problems/{id} in the client; the server, like ASP.NET Core by
      // default, routes it to the act /api/v1/problems/export (a test-only route). Its answer is lost, which would make
      // the client send a read again.
      server.policy.unshift(route("exportAct"))
      server.caseInsensitiveRoutes = true
      await listed(impl, inst, server)
      server.afterRun = ["drop", "drop"]
      const r = await run(impl, inst, server, ["get", "/api/v1/problems/EXPORT"])
      server.afterRun = []
      assert.equal(server.runs("GET", "/api/v1/problems/export"), 0, "the act never ran")
      assert.equal(r.json?.error, "policy_changed", r.out + r.err)
      assert.equal(
        server.arrivals("GET", "/api/v1/problems/EXPORT"),
        2,
        "sent again once, after the list was read again",
      )
      // The path the list holds as an act goes as an act, and runs.
      const act = await run(impl, inst, server, ["get", "/api/v1/problems/export"])
      assert.equal(act.code, 0, act.out + act.err)
      assert.equal(server.runs("GET", "/api/v1/problems/export"), 1)
    })

    it("never runs an act that a router which drops ;parameters picked for a path the list holds as a read", async () => {
      const inst = fresh()
      // The act /api/v1/problems/export is a test-only route next to the read /api/v1/problems/{id}.
      server.policy.unshift(route("exportAct"))
      server.stripPathParameters = true
      await listed(impl, inst, server)
      const arrived = () => [...server.arrivalCounts.values()].reduce((a, b) => a + b, 0)
      const listedArrivals = arrived()
      // A ; in the path is refused before anything is sent.
      server.afterRun = ["drop", "drop"]
      for (const p of ["/api/v1/problems/export;x", "/api/v1/problems/export;", "/api/v1/problems/7;v=1"]) {
        const r = await run(impl, inst, server, ["get", p])
        assert.equal(r.json?.error, "bad_path", `${p}: ${r.out}${r.err}`)
      }
      assert.equal(arrived(), listedArrivals, "nothing reached the API")
      assert.equal(server.runs("GET", "/api/v1/problems/export"), 0)
      // An escaped ; passes the client as the read /api/v1/problems/{id}; the server decodes it, drops the parameter
      // and picks the act. Its check of the declared kind stops it before the route runs.
      const r = await run(impl, inst, server, ["get", "/api/v1/problems/export%3Bx"])
      server.afterRun = []
      assert.equal(server.runs("GET", "/api/v1/problems/export"), 0, "the act never ran")
      assert.equal(r.json?.error, "policy_changed", r.out + r.err)
      assert.equal(server.arrivals("GET", "/api/v1/problems/export%3Bx"), 2)
      // The query keeps a ;.
      const q = await run(impl, inst, server, ["get", "/api/v1/problems?q=a;b"])
      assert.equal(q.json?.data?.query, "?q=a;b", q.out + q.err)
    })

    it("declares the kind it found with every call but access and the listing", async () => {
      const inst = fresh()
      // A read sent as POST (a test-only route): n8n-ops has none, but the kind never comes from the method.
      server.policy.push(route("postRead"))
      await listed(impl, inst, server)
      const g = await run(impl, inst, server, ["get", "/api/v1/problems/7"])
      assert.equal(g.code, 0, g.out + g.err)
      assert.equal(server.last.kind, "read")
      assert.equal(server.last.policy, server.revision())
      const search = await run(impl, inst, server, ["post", "/api/v1/problems/search", "--json", "{}"])
      assert.equal(search.code, 0, search.out + search.err)
      assert.equal(server.last.kind, "read", "a read sent as POST")
      const p = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", '{"name":"a"}'])
      assert.equal(p.code, 0, p.out + p.err)
      assert.equal(server.last.kind, "act")
      assert.equal(server.runs("POST", "/api/v1/access-requests"), 1)
      // Reading an access request hands out its key once: an act, though it is a GET.
      const key = await run(impl, inst, server, ["get", "/api/v1/access-requests/5"])
      assert.equal(key.code, 0, key.out + key.err)
      assert.equal(key.json?.data?.kind, "act")
      assert.equal(server.last.kind, "act", "a GET that is an act")
      assert.equal((await run(impl, inst, server, ["access"])).code, 0)
      assert.equal(server.last.kind, undefined, "not on access")
      assert.equal((await run(impl, inst, server, ["endpoints"])).code, 0)
      assert.equal(server.last.kind, undefined, "not on the listing")
    })

    it("matches a {name:path} template to the rest of the path, and nothing else", async () => {
      const inst = fresh()
      // n8n-ops lists no such template; the client still reads one the same way in every version (test-only route).
      server.policy.push(route("pathRead"))
      await listed(impl, inst, server)
      const deep = await run(impl, inst, server, ["get", "/api/v1/test-files/a/b/c.txt"])
      assert.equal(deep.code, 0, deep.out + deep.err)
      assert.equal(deep.json?.data?.kind, "read")
      assert.equal(server.runs("GET", "/api/v1/test-files/{name:path}"), 1)
      // An empty rest is not a match.
      const empty = await run(impl, inst, server, ["get", "/api/v1/test-files/"])
      assert.equal(empty.json?.error, "bad_path", empty.out + empty.err)
      assert.equal(server.arrivals("GET", "/api/v1/test-files/"), 0)
    })

    it("takes an IPv6 address in brackets, written as a browser writes it", async () => {
      const inst = fresh()
      for (const [given, origin] of [
        ["https://[2001:db8::1]", "https://[2001:db8::1]"],
        ["https://[2001:0DB8:0:0::1]:8443/", "https://[2001:db8::1]:8443"],
        ["https://[2001:db8::1]:443", "https://[2001:db8::1]"],
        ["https://[1:0:0:2:0:0:0:3]", "https://[1:0:0:2::3]"],
        ["https://[1:0:0:2:0:0:3:4]", "https://[1::2:0:0:3:4]"],
        ["https://[0:0:0:0:0:0:0:0]", "https://[::]"],
        ["https://[::1:2:3:4:5:6:7]", "https://[0:1:2:3:4:5:6:7]"],
        ["https://[1:2:3:4:5:6:7::]", "https://[1:2:3:4:5:6:7:0]"],
        ["https://[::ffff:1.2.3.4]", "https://[::ffff:102:304]"],
        ["https://[1:2:3:4:5:6:1.2.3.4]", "https://[1:2:3:4:5:6:102:304]"],
        ["http://[0:0:0:0:0:0:0:1]:8080", "http://[::1]:8080"],
      ]) {
        const r = await run(impl, inst, null, ["status", "--url", given])
        assert.equal(r.json?.url, origin, `${given}: ${r.out}${r.err}`)
      }
      for (const bad of [
        "http://[2001:db8::1]",
        "https://[2001:db8::1::2]",
        "https://[12345::1]",
        "https://[g::1]",
        "https://[:1::2]",
        "https://[1:2:3:4:5:6:7]",
        "https://[1:2:3:4:5:6:7:8:9]",
        "https://[1::2:3:4:5:6:7:8]",
        "https://[::ffff:01.2.3.4]",
        "https://[::ffff:1.2.3]",
        "https://[::ffff:1.2.3.256]",
        "https://[1:2:3:4:5:6:7:1.2.3.4]",
        "https://[::1%25eth0]",
        "https://[]",
      ]) {
        const r = await run(impl, inst, null, ["status", "--url", bad])
        assert.equal(r.json?.error, "insecure_url", `${bad}: ${r.out}${r.err}`)
      }
    })

    it("sends nothing when the list of allowed calls cannot be read", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.listingStatus = 500
      const r = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", '{"name":"a"}'])
      assert.equal(r.json?.error, "endpoints_unavailable", r.out + r.err)
      assert.equal(r.code, 1)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests"), 0, "the call was not sent")
      // Access and the listing do not need the list.
      const a = await run(impl, inst, server, ["access"])
      assert.equal(a.code, 0, a.out + a.err)
      server.listingStatus = 0
      for (const garbage of [
        "<html>Sign in</html>",
        "[]",
        '{"endpoints":"all","revision":"abc"}',
        '{"endpoints":[]}',
        '{"endpoints":[],"revision":"not valid!"}',
        '{"calls":[{"method":"GET","path":"/api/v1/problems","kind":"read"}],"revision":"abc"}',
        // A whole listing wrapped in a top array is not a listing (PowerShell 7 unwraps it if read loosely).
        '[{"endpoints":[{"method":"GET","path":"/api/v1/problems","kind":"read"}],"revision":"abc"}]',
        // Keys in another letter case are other keys.
        '{"Endpoints":[{"method":"GET","path":"/api/v1/problems","kind":"read"}],"Revision":"abc"}',
      ]) {
        server.listingBody = garbage
        const g = await run(impl, inst, server, ["get", "/api/v1/problems"])
        assert.equal(g.json?.error, "endpoints_unavailable", `${garbage}: ${g.out}${g.err}`)
      }
      assert.equal(server.arrivals("GET", "/api/v1/problems"), 0, "the call was not sent")
      // An empty list is a list: the call is not in it.
      server.listingBody = '{"endpoints":[],"revision":"abc"}'
      const empty = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(empty.json?.error, "bad_path", empty.out + empty.err)
      server.listingBody = null
      const ok = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(ok.code, 0, ok.out + ok.err)
      assert.equal(server.runs("GET", "/api/v1/problems"), 1)
    })

    it("refuses a call the list does not hold, after reading the list again, without sending it", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      const r = await run(impl, inst, server, ["get", "/api/v1/nothing"])
      assert.equal(r.json?.error, "bad_path", r.out + r.err)
      assert.equal(server.arrivals("GET", "/api/v1/nothing"), 0)
      // A listed path with a method the list does not hold for it.
      const d = await run(impl, inst, server, ["post", "/api/v1/problems"])
      assert.equal(d.json?.error, "bad_path", d.out + d.err)
      assert.equal(server.arrivals("POST", "/api/v1/problems"), 0)
      // A call added after the list was kept (to the fake server's table, by this test): the list is read again, and
      // the call goes.
      server.policy.push({ method: "GET", path: "/api/v1/reports/{id}", kind: "read", area: "read", description: "" })
      const added = await run(impl, inst, server, ["get", "/api/v1/reports/9"])
      assert.equal(added.code, 0, added.out + added.err)
      assert.equal(server.runs("GET", "/api/v1/reports/{id}"), 1)
      assert.equal(server.arrivals("GET", "/api/v1/reports/9"), 1, "sent with the new revision at once")
    })

    it("sends the stored revision with every call but access and the listing", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      const e = await run(impl, inst, server, ["endpoints"])
      assert.equal(e.code, 0, e.out + e.err)
      assert.equal(e.json.data.revision, server.revision())
      assert.equal(server.last.policy, undefined, "not on the listing")
      const kinds = fs.readdirSync(inst.creds).filter((f) => f.endsWith(".kinds"))
      assert.equal(kinds.length, 1)
      const head = fs.readFileSync(path.join(inst.creds, kinds[0]), "utf8").split("\n")[0].split(" ")
      assert.equal(head[0], KINDS_MAGIC)
      assert.equal(head[1], "2")
      assert.equal(head[4], server.revision())
      const listing = server.counts.listing
      const g = await run(impl, inst, server, ["get", "/api/v1/problems/3"])
      assert.equal(g.code, 0, g.out + g.err)
      assert.equal(server.last.policy, server.revision())
      assert.equal(server.counts.listing, listing, "the kept list was used")
      assert.equal((await run(impl, inst, server, ["access"])).code, 0)
      assert.equal(server.last.policy, undefined, "not on access")
      const area = await run(impl, inst, server, ["endpoints", "access"])
      // The three access-request routes, and access and the listing, which every area may call.
      assert.equal(area.json?.data?.count, 5, area.out + area.err)
      assert.ok(area.json.data.endpoints.every((e) => e.area === "access" || e.area === null))
      assert.equal(server.last.policy, undefined, "not on the listing of one area")
      // A listing of one area is not kept as the list.
      assert.equal(fs.readFileSync(path.join(inst.creds, kinds[0]), "utf8").split("\n")[0].split(" ")[4], head[4])
      assert.equal((await run(impl, inst, server, ["endpoints", "Bad-Area"])).json?.error, "bad_path")
    })

    it("sends the skill's version, or r<revision> from a copy that was not served", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      assert.equal((await run(impl, inst, server, ["access"])).code, 0)
      assert.equal(server.last.skill, `r${SKILL_REVISION}`)
      const served = install({ creds: inst.creds, version: "2026.11.12-a1b2c3" })
      const a = await run(impl, served, server, ["access"])
      assert.equal(a.code, 0, a.out + a.err)
      assert.equal(server.last.skill, "2026.11.12-a1b2c3")
    })

    it("passes back a 401 or 429 that is not a refusal before the route, sending the call once", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      const refreshes = server.counts.refresh
      server.afterRun.push({ status: 401, body: { error: "upstream_denied", message: "The mail service refused." } })
      const u = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
      assert.equal(u.json?.error, "upstream_denied", u.out + u.err)
      assert.equal(u.json.status, 401)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/7/release"), 1)
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 1)
      assert.equal(server.counts.refresh, refreshes, "no refresh without the token challenge")
      server.afterRun.push({ status: 429, body: { error: "rate_limited", message: "The mail service is busy." } })
      const l = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
      assert.equal(l.json?.error, "rate_limited", l.out + l.err)
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 2)
      server.afterRun.push({ status: 429, body: "" })
      const bare = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
      assert.equal(bare.json?.error, "http_429", bare.out + bare.err)
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 3)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/7/release"), 3, "each sent once")
      // A marker nested in a route's own answer is not one of the refusals before the route.
      server.afterRun.push({
        status: 429,
        body: { error: "rate_limited", message: "Later.", detail: { error: "busy" } },
      })
      const nestedBusy = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
      assert.equal(nestedBusy.json?.error, "rate_limited", nestedBusy.out + nestedBusy.err)
      server.afterRun.push({
        status: 409,
        body: { error: "conflict", message: "Changed meanwhile.", detail: { error: "policy_changed" } },
      })
      const nestedPolicy = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
      assert.equal(nestedPolicy.json?.error, "conflict", nestedPolicy.out + nestedPolicy.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/7/release"), 5, "each sent once")
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 5)
      // A read is not sent again for them either.
      server.afterRun.push({ status: 401, body: { error: "upstream_denied", message: "No." } })
      await run(impl, inst, server, ["get", "/api/v1/problems/7"])
      assert.equal(server.arrivals("GET", "/api/v1/problems/7"), 1)
    })

    it("reads a refusal or a list only from a complete, strict JSON answer", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      // After an act ran: an answer that is not strict JSON holds no refusal marker, so the act is not sent again.
      let runs = 0
      for (const [status, body] of [
        [429, '{"error":"busy"'],
        [429, '{"error":"busy",'],
        [429, "{'error':'busy'}"],
        [429, '{error:"busy"}'],
        [429, '{"error":"busy",}'],
        [429, '/*x*/{"error":"busy"}'],
        [429, '{"error":"busy"} x'],
        [429, '{"error":"busy","error":null}'],
        [429, `${BOM}{"error":"busy"}`],
        [409, '{"error":"policy_changed"'],
        [409, "{'error':'policy_changed'}"],
      ]) {
        server.afterRun.push({ status, body })
        const r = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
        runs++
        assert.equal(r.json?.error, `http_${status}`, `${body}: ${r.out}${r.err}`)
        assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), runs, `${body}: ran once`)
        assert.equal(server.arrivals("POST", "/api/v1/access-requests/7/release"), runs, `${body}: sent once`)
      }
      // A duplicated key counts as JSON.parse reads it: the last value wins.
      server.beforeRun.push({ status: 429, body: '{"error":"busy","error":null}' })
      const notBusy = await run(impl, inst, server, ["post", "/api/v1/access-requests/8/release"])
      assert.equal(notBusy.json?.error, "http_429", notBusy.out + notBusy.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/8/release"), 1, "not sent again")
      server.beforeRun.push({ status: 429, body: '{"error":null,"error":"busy"}' })
      const busy = await run(impl, inst, server, ["post", "/api/v1/access-requests/9/release"])
      assert.equal(busy.code, 0, busy.out + busy.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/9/release"), 2, "sent again once")
      // A listing that is not a complete, strict JSON list is no list: nothing is sent. (Without the kept list, so
      // that the call needs a listing; a listing that is no list is not kept.)
      for (const f of fs.readdirSync(inst.creds)) if (f.endsWith(".kinds")) fs.rmSync(path.join(inst.creds, f))
      const entry = '{"method":"GET","path":"/api/v1/problems","kind":"read"}'
      for (const body of [
        `{"endpoints":[${entry}],"revision":"abc"`,
        `{"endpoints":[${entry}`,
        `{"endpoints":[${entry}],"revision":"abc"}}`,
        `{'endpoints':[{'method':'GET','path':'/api/v1/problems','kind':'read'}],'revision':'abc'}`,
        `{"endpoints":[${entry},],"revision":"abc"}`,
        `{"endpoints":[${entry}],"revision":"abc","endpoints":"all"}`,
        `{"endpoints":[${entry}],"revision":"abc","revision":null}`,
      ]) {
        server.listingBody = body
        const r = await run(impl, inst, server, ["get", "/api/v1/problems"])
        assert.equal(r.json?.error, "endpoints_unavailable", `${body}: ${r.out}${r.err}`)
      }
      assert.equal(server.arrivals("GET", "/api/v1/problems"), 0, "the call was not sent")
      // The last of two kinds wins too (the server's table says act as well, so its check of the kind agrees).
      server.setKind("GET", "/api/v1/problems", "act")
      server.listingBody = `{"endpoints":[{"method":"GET","path":"/api/v1/problems","kind":"read","kind":"act"}],"revision":"${server.revision()}"}`
      server.afterRun.push("drop")
      const act = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(act.json?.error, "outcome_unknown", act.out + act.err)
      assert.equal(server.arrivals("GET", "/api/v1/problems"), 1, "an act is not sent again")
    })

    it("reads busy and policy_changed only as a string under the exact key error of a top object", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      // After an act ran: another key case, a value that is not a string, or a top array is no refusal marker.
      let runs = 0
      for (const [status, body] of [
        [429, '{"Error":"busy"}'],
        [429, '{"ERROR":"busy"}'],
        [429, '{"error":["busy"]}'],
        [429, '{"error":{"busy":true}}'],
        [429, '[{"error":"busy"}]'],
        [429, '{"error":"busy","error":["busy"]}'],
        [409, '{"ERROR":"policy_changed"}'],
        [409, '{"Error":"policy_changed"}'],
        [409, '{"error":["policy_changed"]}'],
        [409, '[{"error":"policy_changed"}]'],
      ]) {
        server.afterRun.push({ status, body })
        const r = await run(impl, inst, server, ["post", "/api/v1/access-requests/7/release"])
        runs++
        assert.equal(r.json?.error, `http_${status}`, `${body}: ${r.out}${r.err}`)
        assert.equal(r.code, 1, `${body}: ${r.out}${r.err}`)
        assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), runs, `${body}: ran once`)
        assert.equal(server.arrivals("POST", "/api/v1/access-requests/7/release"), runs, `${body}: sent once`)
      }
      // Before the route: the marker counts as JSON.parse reads it, escapes and all, beside keys of any shape.
      let sent = 0
      for (const body of ['{"error":"busy","":"x"}', '{"error":"busy","Error":"x"}', '{"\\u0065rror":"bus\\u0079"}']) {
        server.beforeRun.push({ status: 429, body })
        const r = await run(impl, inst, server, ["post", "/api/v1/access-requests/9/release"])
        runs++
        sent += 2
        assert.equal(r.code, 0, `${body}: ${r.out}${r.err}`)
        assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), runs, `${body}: ran once`)
        assert.equal(server.arrivals("POST", "/api/v1/access-requests/9/release"), sent, `${body}: sent again once`)
      }
    })

    it("reads an application failure from any valid JSON answer, and prints the answer as data", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      for (const body of [
        '{"success":false,"":"note"}',
        '{"status":"error","data":{"a":1,"A":2}}',
        '{"success":false,"size":1e400}',
      ]) {
        server.afterRun.push({ status: 200, body })
        const r = await run(impl, inst, server, ["get", "/api/v1/problems/7"])
        assert.equal(r.json?.error, "failed", `${body}: ${r.out}${r.err}`)
        assert.equal(r.code, 1, `${body}: ${r.out}${r.err}`)
        assert.equal(r.json.status, 200, body)
        assert.deepEqual(r.json.data, JSON.parse(body), body)
      }
      // Only a top object's own success false or status "error" says so.
      for (const body of [
        '{"data":{"success":false}}',
        '{"success":"false"}',
        '{"Success":false}',
        '{"Status":"error"}',
        '[{"success":false}]',
        '{"status":"error","status":"ok"}',
      ]) {
        server.afterRun.push({ status: 200, body })
        const r = await run(impl, inst, server, ["get", "/api/v1/problems/7"])
        assert.equal(r.code, 0, `${body}: ${r.out}${r.err}`)
        assert.deepEqual(r.json?.data, JSON.parse(body), body)
      }
      // Any JSON value keeps its type in data: a null, a boolean, a number or a string is not turned into text.
      for (const body of ["null", "false", "12", '"x"', "[]"]) {
        server.afterRun.push({ status: 200, body })
        const r = await run(impl, inst, server, ["get", "/api/v1/problems/7"])
        assert.equal(r.code, 0, `${body}: ${r.out}${r.err}`)
        assert.ok(r.json && "data" in r.json, `${body}: ${r.out}${r.err}`)
        assert.deepEqual(r.json.data, JSON.parse(body), body)
      }
    })

    // A read and an act that both match one path: the act GET /api/v1/access-requests/{id} of n8n-ops's table, and the
    // static read /api/v1/access-requests/export, a test-only route.
    const overlapping = () => {
      assert.equal(server.policy.find((e) => e.path === "/api/v1/access-requests/{id}")?.kind, "act")
      server.policy.unshift(route("staticRead"))
    }

    it("sends a path that a read and an act both match as a read after the act was refused, when the router picks the read", async () => {
      const inst = fresh()
      overlapping()
      server.routePreference = "static"
      await listed(impl, inst, server)
      const r = await run(impl, inst, server, ["get", "/api/v1/access-requests/export"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json?.data?.kind, "read")
      assert.equal(server.runs("GET", "/api/v1/access-requests/export"), 1, "the read ran once")
      assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 0, "the act never ran")
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/export"), 2, "the refused act and the read")
      // A further policy_changed ends the command, and nothing runs.
      server.beforeRun.push("policy_changed", "policy_changed")
      const twice = await run(impl, inst, server, ["get", "/api/v1/access-requests/export"])
      assert.equal(twice.json?.error, "policy_changed", twice.out + twice.err)
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/export"), 4)
      assert.equal(server.runs("GET", "/api/v1/access-requests/export"), 1)
      // From a list read for the call (none kept) too.
      for (const f of fs.readdirSync(inst.creds)) if (f.endsWith(".kinds")) fs.rmSync(path.join(inst.creds, f))
      const fetched = await run(impl, inst, server, ["get", "/api/v1/access-requests/export"])
      assert.equal(fetched.code, 0, fetched.out + fetched.err)
      assert.equal(server.runs("GET", "/api/v1/access-requests/export"), 2)
      assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 0, "the act never ran")
    })

    it("sends a path that a read and an act both match as an act, once, when the router picks the act", async () => {
      const inst = fresh()
      overlapping()
      server.routePreference = "dynamic"
      await listed(impl, inst, server)
      const r = await run(impl, inst, server, ["get", "/api/v1/access-requests/export"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json?.data?.kind, "act")
      assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 1, "the act ran once")
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/export"), 1, "sent once")
      // Its answer is lost: the outcome is unknown, and it is not sent again.
      server.afterRun.push("drop")
      const lost = await run(impl, inst, server, ["get", "/api/v1/access-requests/export"])
      assert.equal(lost.json?.error, "outcome_unknown", lost.out + lost.err)
      assert.equal(
        server.runs("GET", "/api/v1/access-requests/{id}"),
        2,
        "the act ran once more, for the second command only",
      )
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/export"), 2, "sent once")
      assert.equal(server.runs("GET", "/api/v1/access-requests/export"), 0, "the read never ran")
    })

    it("refreshes and sends again once after the token refusal", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      const refreshes = server.counts.refresh
      server.beforeRun.push("invalid_token")
      const r = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", '{"name":"a"}'])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests"), 2)
      assert.equal(server.runs("POST", "/api/v1/access-requests"), 1)
      assert.equal(server.counts.refresh, refreshes + 1)
      server.beforeRun.push("invalid_token", "invalid_token")
      const twice = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", '{"name":"a"}'])
      assert.equal(twice.code, 1, twice.out + twice.err)
      assert.equal(twice.json?.error, "http_401")
      assert.equal(server.arrivals("POST", "/api/v1/access-requests"), 4, "sent again only once")
      assert.equal(server.runs("POST", "/api/v1/access-requests"), 1)
      assert.equal(server.counts.reuse, 0)
    })

    it("waits and sends again once after the busy refusal", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.beforeRun.push("busy")
      const release = ["post", "/api/v1/access-requests/2/release", "--json", '{"summary":"Done."}']
      const r = await run(impl, inst, server, release)
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/2/release"), 2)
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 1)
      server.beforeRun.push("busy", "busy")
      const twice = await run(impl, inst, server, release)
      assert.equal(twice.json?.error, "busy", twice.out + twice.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests/2/release"), 4, "sent again only once")
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 1)
    })

    it("reads the list again after policy_changed and sends the call once more", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      // The policy changes after the list was kept.
      server.setKind("GET", "/api/v1/backups", "act")
      const listing = server.counts.listing
      const r = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.arrivals("GET", "/api/v1/problems"), 2)
      assert.equal(server.runs("GET", "/api/v1/problems"), 1)
      assert.equal(server.counts.listing, listing + 1)
      assert.equal(server.last.policy, server.revision())
      // A second policy_changed in a row ends the command; nothing more is sent.
      server.beforeRun.push("policy_changed", "policy_changed")
      const twice = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", "{}"])
      assert.equal(twice.json?.error, "policy_changed", twice.out + twice.err)
      assert.equal(server.arrivals("POST", "/api/v1/access-requests"), 2)
      assert.equal(server.runs("POST", "/api/v1/access-requests"), 0)
      // A call the new list no longer holds is not sent again.
      server.policy = server.policy.filter((e) => !(e.method === "GET" && e.path === "/api/v1/problems/{id}"))
      const gone = await run(impl, inst, server, ["get", "/api/v1/problems/4"])
      assert.equal(gone.json?.error, "bad_path", gone.out + gone.err)
      assert.equal(server.arrivals("GET", "/api/v1/problems/4"), 1)
    })

    it("sends a call under its new kind after policy_changed: a read become an act is not sent twice", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      // The list says read; the server changes it to act before the call arrives, then loses the call's answer.
      server.reclassifyAfterListing = { method: "GET", path: "/api/v1/problems/{id}", kind: "act" }
      server.afterRun.push("drop")
      const r = await run(impl, inst, server, ["get", "/api/v1/problems/8"])
      assert.equal(r.json?.error, "outcome_unknown", r.out + r.err)
      assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 1, "ran exactly once")
      assert.equal(server.arrivals("GET", "/api/v1/problems/8"), 2, "the refused send and the one that ran")
    })

    it("never sends an act twice: a lost or broken answer, or a server failure, is outcome_unknown", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.afterRun.push("drop")
      const lost = await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", '{"name":"a"}'])
      assert.equal(lost.json?.error, "outcome_unknown", lost.out + lost.err)
      assert.equal(server.runs("POST", "/api/v1/access-requests"), 1)
      server.afterRun.push("truncate")
      const broken = await run(impl, inst, server, ["post", "/api/v1/access-requests/3/release", "--json", "{}"])
      assert.equal(broken.json?.error, "outcome_unknown", broken.out + broken.err)
      assert.equal(server.runs("POST", "/api/v1/access-requests/{id}/release"), 1)
      // A GET that hands out a one-time key is an act too: its lost answer is not fetched again.
      server.afterRun.push("drop")
      const key = await run(impl, inst, server, ["get", "/api/v1/access-requests/3"])
      assert.equal(key.json?.error, "outcome_unknown", key.out + key.err)
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/3"), 1)
      server.afterRun.push({ status: 500, body: { error: "server_error" } })
      const failed = await run(impl, inst, server, ["get", "/api/v1/access-requests/3"])
      assert.equal(failed.json?.error, "outcome_unknown", failed.out + failed.err)
      assert.equal(failed.json.status, 500)
      assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 2)
      assert.equal(server.arrivals("GET", "/api/v1/access-requests/3"), 2)
    })

    it("sends a read once more when its answer was lost, whatever its method", async () => {
      const inst = fresh()
      // A read sent as POST (a test-only route).
      server.policy.push(route("postRead"))
      await listed(impl, inst, server)
      server.afterRun.push("drop")
      const r = await run(impl, inst, server, ["get", "/api/v1/problems/3"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 2)
      // A search sent as POST is a read in the list.
      server.afterRun.push("truncate")
      const s = await run(impl, inst, server, ["post", "/api/v1/problems/search", "--json", '{"q":"x"}'])
      assert.equal(s.code, 0, s.out + s.err)
      assert.equal(server.runs("POST", "/api/v1/problems/search"), 2)
      server.afterRun.push("drop", "drop")
      const twice = await run(impl, inst, server, ["get", "/api/v1/problems/3"])
      assert.equal(twice.json?.error, "unreachable", twice.out + twice.err)
      assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 4)
    })

    it("ends when the server ended the connection, and forgets it", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.endAllGrants()
      server.expireAccessTokens()
      const r = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(r.json.error, "connection_ended", r.out + r.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "not_connected")
    })

    it("retries a refresh whose answer was lost once, which ends the connection and the token nobody got", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      server.dropNextRefresh = true
      const lost = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(lost.json.error, "unreachable", lost.out + lost.err)
      const orphan = server.orphan
      const refreshes = server.counts.refresh
      // Right after, the lost refresh might still be on its way: nothing is sent.
      const soon = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(soon.json.error, "busy", soon.out + soon.err)
      assert.equal(server.counts.refresh, refreshes)
      const next = await run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_REFRESH_GRACE`]: "0" })
      assert.equal(next.json.error, "connection_ended", next.out + next.err)
      assert.equal(server.grants.get(server.refresh.get(orphan).grant).alive, false, "the orphaned token's grant ended")
    })

    it("treats an answer that broke off like a lost one", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      server.truncateNextRefresh = true
      const broken = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(broken.json.error, "unreachable", broken.out + broken.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "connected", "the connection is kept")
      const orphan = server.orphan
      const next = await run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_REFRESH_GRACE`]: "0" })
      assert.equal(next.json.error, "connection_ended", next.out + next.err)
      assert.equal(server.grants.get(server.refresh.get(orphan).grant).alive, false)
    })

    it("keeps the token when the refresh never left the computer", async () => {
      const inst = fresh()
      // The stored access token runs out within a minute, so the next command refreshes before calling.
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      await server.stop()
      const down = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(down.json.error, "unreachable", down.out + down.err)
      await server.start()
      const up = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(up.code, 0, up.out + up.err)
      assert.equal(server.counts.refresh, 1, "only the refresh that reached the server")
      assert.equal(server.counts.reuse, 0)
    })

    it("keeps an old connection it could not end yet, even when the new one ends", async () => {
      const inst = fresh()
      const alive = () => [...server.grants.entries()].filter(([, g]) => g.alive).map(([id]) => id)
      const others = new Set(alive())
      await connected(impl, inst, server)
      const [old] = alive().filter((g) => !others.has(g))
      server.revokeStatus = 500
      await run(impl, inst, server, ["connect", "--replace"])
      server.approve()
      const w = await run(impl, inst, server, ["connect", "--wait"])
      assert.equal(w.json.status, "connected", w.out + w.err)
      assert.equal(server.grants.get(old).alive, true, "the server did not confirm, so it is still to be ended")
      // The new connection ends; the old one must still be ended.
      for (const id of alive()) if (id !== old && !others.has(id)) server.grants.get(id).alive = false
      server.expireAccessTokens()
      const ended = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(ended.json.error, "connection_ended", ended.out + ended.err)
      server.revokeStatus = 200
      const again = await run(impl, inst, server, ["connect"])
      assert.equal(again.json.status, "pending", again.out + again.err)
      assert.equal(server.grants.get(old).alive, false, "ended once the server answered")
    })

    it("works in a folder whose path has spaces, and leaves no temp files", async () => {
      const inst = fresh()
      inst.creds = path.join(inst.base, "my creds")
      // A file named like the path's first word, which a split path would hit.
      fs.writeFileSync(path.join(inst.base, "my"), "keep")
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      assert.equal((await run(impl, inst, server, ["get", "/api/v1/problems"])).code, 0)
      assert.equal((await run(impl, inst, server, ["post", "/api/v1/access-requests", "--json", "{}"])).code, 0)
      assert.equal(fs.readFileSync(path.join(inst.base, "my"), "utf8"), "keep")
      const left = fs.readdirSync(inst.creds).filter((f) => !/^[0-9a-f]{32}\.(json|kinds)$/.test(f) && f !== "address")
      assert.deepEqual(left, [])
    })

    it("shares one connection between the agent installs of one computer user", async () => {
      const inst = fresh()
      const other = install({ creds: inst.creds })
      await connected(impl, inst, server)
      const devices = server.counts.device
      const s = await run(impl, other, server, ["status"])
      assert.equal(s.json.status, "connected", s.out + s.err)
      assert.equal((await run(impl, other, server, ["connect"])).json.status, "already_connected")
      assert.equal((await run(impl, other, server, ["get", "/api/v1/problems"])).code, 0)
      assert.equal(server.counts.device, devices, "no second connection")
      // Another user (another credentials folder) has a connection of its own.
      assert.equal((await run(impl, fresh(), server, ["status"])).json.status, "not_connected")
    })

    it("never writes in the skill's folder, which may be read only", async () => {
      const inst = fresh()
      const skillDir = path.dirname(inst.dir)
      const before = snapshot(skillDir)
      if (!win) fs.chmodSync(skillDir, 0o555)
      try {
        await connected(impl, inst, server)
        assert.equal((await run(impl, inst, server, ["get", "/api/v1/problems"])).code, 0)
        assert.equal((await run(impl, inst, server, ["disconnect"])).json.status, "disconnected")
      } finally {
        if (!win) fs.chmodSync(skillDir, 0o755)
      }
      assert.deepEqual(snapshot(skillDir), before)
    })

    it("keeps the address once connected, for the commands after", async () => {
      const inst = fresh()
      const kept = path.join(inst.creds, "address")
      const none = await run(impl, inst, null, ["status"])
      assert.equal(none.json?.error, "no_url", none.out + none.err)
      assert.match(none.json.message, /--url "<address>"/)
      // Not while the code waits, nor when the person says no.
      await run(impl, inst, server, ["connect"])
      assert.equal(fs.existsSync(kept), false)
      server.deny()
      assert.equal((await run(impl, inst, server, ["connect", "--wait"])).json.error, "denied")
      assert.equal(fs.existsSync(kept), false)
      await connected(impl, inst, server)
      assert.equal(fs.readFileSync(kept, "utf8"), `${server.issuer}\n`)
      const s = await run(impl, inst, null, ["status"])
      assert.equal(s.json.status, "connected", s.out + s.err)
      assert.equal(s.json.url, server.issuer)
      assert.equal((await run(impl, inst, null, ["get", "/api/v1/problems"])).code, 0)
      // An address given, or the one a copy served by the server carries, comes before the kept one.
      const other = "https://other.example"
      assert.equal((await run(impl, inst, null, ["status", "--url", other])).json.url, other)
      assert.equal((await run(impl, inst, null, ["status"], { [`${ENV}URL`]: other })).json.url, other)
      const served = install({ creds: inst.creds, url: other })
      assert.equal((await run(impl, served, null, ["status"])).json.url, other)
      // A damaged one is refused, not guessed at.
      fs.writeFileSync(kept, "app.example\n")
      const bad = await run(impl, inst, null, ["status"])
      assert.equal(bad.json?.error, "no_url", bad.out + bad.err)
      assert.match(bad.json.message, /kept/)
      assert.match(bad.json.message, /--url "<address>"/)
      // Line breaks at its end are fine, a second line is not, and a folder in its place is refused.
      fs.writeFileSync(kept, `${server.issuer}\r\n`)
      const crlf = await run(impl, inst, null, ["status"])
      assert.equal(crlf.json?.url, server.issuer, crlf.out + crlf.err)
      // (Joined, the two lines would make another valid address.)
      fs.writeFileSync(kept, "https://app.example\ngarbage\n")
      const two = await run(impl, inst, null, ["status"])
      assert.equal(two.json?.error, "no_url", two.out + two.err)
      fs.rmSync(kept)
      fs.mkdirSync(kept)
      const folder = await run(impl, inst, null, ["status"])
      assert.equal(folder.json?.error, "insecure_credentials", folder.out + folder.err)
    })

    it("takes only an address that a shell reads as it is, given or kept", async () => {
      const inst = fresh()
      fs.mkdirSync(inst.creds, { recursive: true, mode: 0o700 })
      const keep = (address) => fs.writeFileSync(path.join(inst.creds, "address"), `${address}\n`, { mode: 0o600 })
      for (const [given, origin] of [
        ["https://app.example.com/", "https://app.example.com"],
        ["https://APP.Example.com", "https://app.example.com"],
        ["https://app.example.com:443", "https://app.example.com"],
        ["https://app.example.com:8443", "https://app.example.com:8443"],
        ["https://app.example.com:65535", "https://app.example.com:65535"],
        ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
        ["http://localhost:8080", "http://localhost:8080"],
        ["http://[::1]:8080", "http://[::1]:8080"],
      ]) {
        const r = await run(impl, inst, null, ["status", "--url", given])
        assert.equal(r.json?.url, origin, `${given}: ${r.out}${r.err}`)
        keep(given)
        const k = await run(impl, inst, null, ["status"])
        assert.equal(k.json?.url, origin, `kept ${given}: ${k.out}${k.err}`)
      }
      // Anything a shell could take as more than an address, and ports that are not 1 to 65535, are refused.
      for (const bad of [
        "https://$(id).example.com",
        "https://a;b.example.com",
        "https://a_b.example.com",
        "https://x%60y.example.com",
        "https://app.example.com:12bad",
        "https://app.example.com:70000",
        "https://app.example.com:65536",
        "https://app.example.com:0",
        "http://[::1]:12bad",
        "http://[::1]:0",
      ]) {
        const r = await run(impl, inst, null, ["status", "--url", bad])
        assert.equal(r.json?.error, "insecure_url", `${bad}: ${r.out}${r.err}`)
        keep(bad)
        const k = await run(impl, inst, null, ["status"])
        assert.equal(k.json?.error, "no_url", `kept ${bad}: ${k.out}${k.err}`)
        assert.match(k.json.message, /is not valid/)
      }
    })

    it("prints hints that run in a shell as they are, even with an IPv6 address", async (t) => {
      let v6
      try {
        v6 = await startFakeServer(0, "::1")
      } catch (e) {
        t.skip(`this computer has no IPv6 loopback (${e.code ?? e.message})`)
        return
      }
      try {
        const { shells, missing } = hintShells()
        t.diagnostic(
          `shells: ${shells.map((s) => s.name).join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
        )
        const inst = fresh()
        const p = await run(impl, inst, v6, ["connect"])
        assert.equal(p.json?.next, connectNext(v6.issuer), p.out + p.err)
        assert.ok(shells.length, "no shell to run the hints in")
        for (const shell of shells) {
          const w = await runHint(shell, impl, inst, p.json.next, "run: ")
          assert.equal(w.json?.status, "still_waiting", `${shell.name}: ${w.out}${w.err}`)
          assert.equal(w.json.next, waitNext(v6.issuer))
          const again = await runHint(shell, impl, inst, w.json.next, "Run again: ")
          assert.equal(again.json?.status, "still_waiting", `${shell.name}: ${again.out}${again.err}`)
        }
        // Once approved, the address works for the API too.
        v6.approve()
        const w = await run(impl, inst, v6, ["connect", "--wait"])
        assert.equal(w.json?.status, "connected", w.out + w.err)
        const g = await run(impl, inst, v6, ["get", "/api/v1/problems"])
        assert.equal(g.json?.data?.path, "/api/v1/problems", g.out + g.err)
        const r = await run(impl, inst, v6, ["post", "/api/v1/access-requests/1/release"])
        assert.equal(r.json?.data?.method, "POST", r.out + r.err)
      } finally {
        await v6.close()
      }
    })

    it("finishes a connection at the address it began with, even when another one is kept meanwhile", async () => {
      const second = await startFakeServer()
      try {
        const inst = fresh()
        await connected(impl, inst, server)
        // A new code for the kept address, then another agent of this user connects to a second server.
        const c = await run(impl, inst, null, ["connect", "--replace"])
        assert.equal(c.json?.status, "pending", c.out + c.err)
        assert.equal(c.json.next, connectNext(server.issuer))
        await connected(impl, install({ creds: inst.creds }), second)
        assert.equal(fs.readFileSync(path.join(inst.creds, "address"), "utf8"), `${second.issuer}\n`)
        // The hint's command finishes the first one.
        server.approve()
        const w = await run(impl, inst, null, ["connect", "--wait", "--url", server.issuer])
        assert.equal(w.json?.status, "connected", w.out + w.err)
        assert.equal(server.counts.reuse, 0)
        assert.equal((await run(impl, inst, server, ["get", "/api/v1/problems"])).code, 0)
      } finally {
        await second.close()
      }
    })

    it("disconnects, and keeps what the server did not confirm to try again", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.revokeStatus = 500
      const failed = await run(impl, inst, server, ["disconnect"])
      assert.equal(failed.json.error, "disconnect_failed", failed.out + failed.err)
      assert.equal(server.aliveGrants() > 0, true)
      server.revokeStatus = 200
      const ok = await run(impl, inst, server, ["disconnect"])
      assert.equal(ok.json.status, "disconnected", ok.out + ok.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "not_connected")
      assert.deepEqual(
        fs.readdirSync(inst.creds).filter((f) => /\.(json|kinds)$/.test(f)),
        [],
        "the connection and its list are gone",
      )
    })

    it("replaces a connection and ends the old one only once the new one is stored", async () => {
      const inst = fresh()
      const alive = () => [...server.grants.entries()].filter(([, g]) => g.alive).map(([id]) => id)
      const others = new Set(alive())
      await listed(impl, inst, server)
      const oldGrants = alive().filter((g) => !others.has(g))
      assert.equal(oldGrants.length, 1)
      const c = await run(impl, inst, server, ["connect", "--replace"])
      assert.equal(c.json.status, "pending")
      assert.ok(
        oldGrants.every((g) => server.grants.get(g).alive),
        "the old one works while the new one waits",
      )
      server.approve()
      const w = await run(impl, inst, server, ["connect", "--wait"])
      assert.equal(w.json.status, "connected", w.out + w.err)
      assert.ok(
        oldGrants.every((g) => !server.grants.get(g).alive),
        "the old one ended",
      )
      // The old connection's list is not used for the new one.
      const listing = server.counts.listing
      assert.equal((await run(impl, inst, server, ["get", "/api/v1/problems"])).code, 0)
      assert.equal(server.counts.listing, listing + 1)
    })

    it("never takes the lock from a live holder: others answer busy and send nothing", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.expireAccessTokens()
      const hold = path.join(inst.base, "hold-live")
      const holder = run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_HOLD_LOCKED`]: hold })
      await reached(hold)
      const before = server.counts.refresh
      const other = await run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}LOCK_WAIT_MS`]: "1500" })
      assert.equal(other.json.error, "busy", other.out + other.err)
      assert.equal(server.counts.refresh, before)
      fs.writeFileSync(`${hold}.go`, "")
      assert.equal((await holder).code, 0)
      assert.equal(server.counts.reuse, 0)
    })

    it("takes over the lock of a holder that died", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.expireAccessTokens()
      const hold = path.join(inst.base, "hold-dead")
      const holder = run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_HOLD_LOCKED`]: hold })
      await reached(hold)
      holder.child.kill("SIGKILL")
      await holder
      const next = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(next.code, 0, next.out + next.err)
      assert.equal(server.counts.reuse, 0)
    })

    it("lets only one of two processes take a dead holder's lock", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      server.expireAccessTokens()
      // A dead lock, as a killed holder leaves it.
      const hold = path.join(inst.base, "hold-dead2")
      const holder = run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_HOLD_LOCKED`]: hold })
      await reached(hold)
      holder.child.kill("SIGKILL")
      await holder
      // B sees the dead lock and stops just before moving it; C breaks it, takes a fresh lock, and holds it.
      const b = path.join(inst.base, "b")
      const cHold = path.join(inst.base, "c")
      const pb = run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_HOLD_BREAK_OBSERVED`]: b })
      await reached(b)
      const pc = run(impl, inst, server, ["get", "/api/v1/problems"], { [`${ENV}TEST_HOLD_LOCKED`]: cHold })
      await reached(cHold)
      // B now moves C's fresh lock, sees it is not the dead one, and puts it back.
      fs.writeFileSync(`${b}.go`, "")
      await sleep(1500)
      fs.writeFileSync(`${cHold}.go`, "")
      const [rb, rc] = await Promise.all([pb, pc])
      assert.equal(rc.code, 0, rc.out + rc.err)
      assert.equal(rb.code, 0, rb.out + rb.err)
      assert.equal(server.counts.reuse, 0, "the refresh token was never used twice")
    })

    it("keeps new tokens when its lock was moved away and put back while it refreshed", async () => {
      const inst = fresh()
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      const hold = path.join(inst.base, "hold-write")
      const busy = path.join(inst.base, "hold-busy")
      const p = run(impl, inst, server, ["get", "/api/v1/problems"], {
        [`${ENV}TEST_HOLD_BEFORE_WRITE`]: hold,
        [`${ENV}TEST_HOLD_LOCK_BUSY`]: busy,
        [`${ENV}LOCK_WAIT_MS`]: "8000",
      })
      let failed
      try {
        await reached(hold)
        const lock = path.join(inst.creds, fs.readdirSync(inst.creds).find((f) => f.endsWith(".lock")) ?? "")
        // As a mistaken breaker would: it moves the lock away, and a live third process takes the place...
        fs.renameSync(lock, `${lock}.moved`)
        const host = win ? process.env.COMPUTERNAME : os.hostname()
        const third = randomBytes(8).toString("hex")
        fs.writeFileSync(
          lock,
          JSON.stringify({ pid: process.pid, host, token: third, startedAt: Math.floor(Date.now() / 1000) }),
        )
        fs.writeFileSync(`${hold}.go`, "")
        // The process found the third's lock and waits for it (a fixed wait passed on a slow runner before it
        // looked, so the case could pass without reaching the path it exists for)...
        await reached(busy)
        // ...then the first lock is put back in the third's place, with no moment without a lock.
        await replaceWith(`${lock}.moved`, lock)
      } catch (e) {
        failed = e
      }
      // Never leave the process held, whatever failed above, and let it end before its folder is cleaned up.
      try {
        fs.writeFileSync(`${hold}.go`, "")
        fs.writeFileSync(`${busy}.go`, "")
      } catch (e) {
        // Without the release it would wait in the hook: end it instead.
        p.child.kill("SIGKILL")
        failed ??= e
      }
      const r = await p
      if (failed) throw failed
      assert.equal(r.code, 0, r.out + r.err)
      const refreshes = server.counts.refresh
      assert.equal((await run(impl, inst, server, ["get", "/api/v1/problems"])).code, 0)
      assert.equal(server.counts.refresh, refreshes, "the new tokens were kept")
      assert.equal(server.counts.reuse, 0)
    })

    it("uses the connection, the lock and the address that the client of earlier releases left", async () => {
      const inst = fresh()
      // The credentials folder as the command sets it up (only this user may open it), with a pending code in it.
      const c = await run(impl, inst, server, ["connect"])
      assert.equal(c.json?.status, "pending", c.out + c.err)
      // A connection made as the earlier client made it (it also asked for offline_access), and its files exactly as
      // it wrote them: the record's fields in this order and one line break after it, the address with one line
      // break, and the lock as one JSON object without one. Those installs kept no list of calls.
      const tokens = await handTokens(server, OLD_SCOPE)
      const key = createHash("sha256").update(server.issuer).digest("hex").slice(0, 32)
      const file = path.join(inst.creds, `${key}.json`)
      const host = win ? process.env.COMPUTERNAME : os.hostname()
      const label = `Agents on ${host}`
      const generation = randomBytes(8).toString("hex")
      const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in
      fs.writeFileSync(
        file,
        `{"v":1,"issuer":"${server.issuer}","label":"${label}","generation":"${generation}","refreshToken":"${tokens.refresh_token}","accessToken":"${tokens.access_token}","accessExpiresAt":${expiresAt},"scope":"${OLD_SCOPE}","refreshStartedAt":0,"refreshRetried":0,"deviceCode":"","userCode":"","link":"","deviceExpiresAt":0,"interval":0,"nextPollAt":0,"toRevoke":""}\n`,
        { mode: 0o600 },
      )
      fs.writeFileSync(path.join(inst.creds, "address"), `${server.issuer}\n`, { mode: 0o600 })
      const s = await run(impl, inst, null, ["status"])
      assert.equal(s.json?.status, "connected", s.out + s.err)
      assert.equal(s.json.url, server.issuer, "the kept address")
      assert.equal(s.json.scope, OLD_SCOPE)
      // A call with the stored access token: the list is read once, since there is none kept, and nothing refreshes.
      const refreshes = server.counts.refresh
      const listing = server.counts.listing
      const g = await run(impl, inst, null, ["get", "/api/v1/problems"])
      assert.equal(g.code, 0, g.out + g.err)
      assert.equal(server.counts.refresh, refreshes)
      assert.equal(server.counts.listing, listing + 1)
      // A lock the earlier client holds, alive on this computer: never taken; nothing is refreshed.
      server.expireAccessTokens()
      const lock = path.join(inst.creds, `${key}.lock`)
      const oldLock = (pid) =>
        `{"pid":${pid},"host":"${host}","token":"${randomBytes(16).toString("hex")}","startedAt":${Math.floor(Date.now() / 1000)}}`
      fs.writeFileSync(lock, oldLock(process.pid), { mode: 0o600 })
      const held = await run(impl, inst, null, ["get", "/api/v1/problems"], { [`${ENV}LOCK_WAIT_MS`]: "1500" })
      assert.equal(held.json?.error, "busy", held.out + held.err)
      assert.equal(server.counts.refresh, refreshes)
      // The same lock of a holder that died is taken over, and the connection refreshes once.
      const dead = spawn(process.execPath, ["-e", ""])
      await new Promise((r) => dead.on("close", r))
      fs.writeFileSync(lock, oldLock(dead.pid), { mode: 0o600 })
      const taken = await run(impl, inst, null, ["get", "/api/v1/problems"])
      assert.equal(taken.code, 0, taken.out + taken.err)
      assert.equal(server.counts.refresh, refreshes + 1)
      assert.equal(server.counts.reuse, 0)
      // The record it writes back keeps the same fields in the same order, for an earlier client still installed.
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), OLD_FIELDS)
      assert.equal(fs.existsSync(lock), false, "the lock is released")
    })

    const gitBin = "C:\\Program Files\\Git\\usr\\bin"
    if (win && fs.existsSync(path.join(gitBin, "whoami.exe"))) {
      it("works when another whoami comes first on the PATH, as in Git Bash", async () => {
        const inst = fresh()
        const r = await run(impl, inst, server, ["connect"], { PATH: `${gitBin};${process.env.PATH}` })
        assert.equal(r.json?.status, "pending", r.out + r.err)
      })
    }

    if (win) {
      it("refuses a credentials folder that grants others access", async () => {
        const inst = fresh()
        fs.mkdirSync(inst.creds, { recursive: true })
        // Everyone may read, inherited by every file in it.
        execFileSync("icacls", [inst.creds, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"], { stdio: "ignore" })
        const r = await run(impl, inst, server, ["connect"])
        assert.equal(r.json.error, "insecure_credentials", r.out + r.err)
        assert.match(r.json.message, /S-1-1-0|WD/)
      })
    }

    it("stops using a connection once others can open its folder, even with a live access token", async () => {
      const inst = fresh()
      await listed(impl, inst, server)
      const refreshes = server.counts.refresh
      // As a restore or a change of the folder's permissions would leave it.
      if (win) execFileSync("icacls", [inst.creds, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"], { stdio: "ignore" })
      else fs.chmodSync(inst.creds, 0o755)
      const r = await run(impl, inst, server, ["get", "/api/v1/problems"])
      assert.equal(r.json?.error, "insecure_credentials", r.out + r.err)
      assert.equal(server.arrivals("GET", "/api/v1/problems"), 0, "nothing was sent")
      assert.equal(server.counts.refresh, refreshes)
      if (!win) assert.equal(fs.statSync(inst.creds).mode & 0o777, 0o755, "not changed silently")
    })

    if (!win) {
      it("refuses a credentials folder others can open", async () => {
        const inst = fresh()
        fs.mkdirSync(inst.creds, { mode: 0o755 })
        fs.chmodSync(inst.creds, 0o755)
        const r = await run(impl, inst, server, ["connect"])
        assert.equal(r.json.error, "insecure_credentials", r.out + r.err)
        assert.equal(fs.statSync(inst.creds).mode & 0o777, 0o755, "not changed silently")
      })
    }
  })
}

// The server's half of the kind contract, pinned on the fake server with requests made by hand: the policy check
// refuses a call before its route runs unless it carries the current revision and the kind of the route the router
// picked.
describe(`${NAME} fake server policy check`, () => {
  let server
  let token
  before(async () => {
    server = await startFakeServer()
    token = (await handTokens(server)).access_token
  })
  after(() => server.close())
  const call = async (method, p, headers) => {
    const r = await fetch(`${server.issuer}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(method === "GET" ? {} : { body: "{}" }),
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  const refused = (r, what) => {
    assert.equal(r.status, 409, what)
    assert.equal(r.json?.error, "policy_changed", what)
  }

  it("refuses a missing, unknown or wrong kind, or a missing revision, before the route runs", async () => {
    server.reset()
    const rev = server.revision()
    refused(await call("GET", "/api/v1/problems/7", { [POLICY_HEADER]: rev }), "no kind")
    for (const kind of ["", "READ", "Act", "write", "read,act"])
      refused(await call("GET", "/api/v1/problems/7", { [POLICY_HEADER]: rev, [KIND_HEADER]: kind }), `kind ${kind}`)
    refused(await call("GET", "/api/v1/problems/7", { [POLICY_HEADER]: rev, [KIND_HEADER]: "act" }), "act for a read")
    refused(
      await call("POST", "/api/v1/access-requests", { [POLICY_HEADER]: rev, [KIND_HEADER]: "read" }),
      "read for an act",
    )
    // A GET that is an act by its effect is refused as a read too.
    refused(
      await call("GET", "/api/v1/access-requests/7", { [POLICY_HEADER]: rev, [KIND_HEADER]: "read" }),
      "read for a GET act",
    )
    assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 0)
    refused(await call("GET", "/api/v1/problems/7", { [KIND_HEADER]: "read" }), "no revision")
    assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 0)
    assert.equal(server.runs("POST", "/api/v1/access-requests"), 0)
    assert.equal((await call("GET", "/api/v1/problems/7", { [POLICY_HEADER]: rev, [KIND_HEADER]: "read" })).status, 200)
    assert.equal(
      (await call("POST", "/api/v1/access-requests", { [POLICY_HEADER]: rev, [KIND_HEADER]: "act" })).status,
      200,
    )
    assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 1)
    assert.equal(server.runs("POST", "/api/v1/access-requests"), 1)
  })

  it("checks the kind of the route its router picked, not of the path as it was sent", async () => {
    server.reset()
    // A test-only act next to the read /api/v1/problems/{id}.
    server.policy.unshift(route("exportAct"))
    const rev = server.revision()
    const read = { [POLICY_HEADER]: rev, [KIND_HEADER]: "read" }
    const act = { [POLICY_HEADER]: rev, [KIND_HEADER]: "act" }
    server.caseInsensitiveRoutes = true
    refused(await call("GET", "/api/v1/problems/EXPORT", read), "a case change")
    assert.equal(server.runs("GET", "/api/v1/problems/export"), 0)
    assert.equal((await call("GET", "/api/v1/problems/EXPORT", act)).status, 200)
    assert.equal(server.runs("GET", "/api/v1/problems/export"), 1)
    server.caseInsensitiveRoutes = false
    server.stripPathParameters = true
    for (const p of ["/api/v1/problems/export;x", "/api/v1/problems/export%3Bx", "/api/v1/problems/export;"])
      refused(await call("GET", p, read), p)
    assert.equal(server.runs("GET", "/api/v1/problems/export"), 1)
    assert.equal((await call("GET", "/api/v1/problems/7;v=1", read)).status, 200)
    assert.equal(server.runs("GET", "/api/v1/problems/{id}"), 1)
  })

  it("picks the first, the static or the dynamic one of two routes that match a path, as set", async () => {
    server.reset()
    // The act GET /api/v1/access-requests/{id} of n8n-ops's table, and a test-only static read after it.
    server.policy.push(route("staticRead"))
    const rev = server.revision()
    const read = { [POLICY_HEADER]: rev, [KIND_HEADER]: "read" }
    const act = { [POLICY_HEADER]: rev, [KIND_HEADER]: "act" }
    // The table holds /api/v1/access-requests/{id} first.
    refused(await call("GET", "/api/v1/access-requests/export", read), "first: the act")
    assert.equal((await call("GET", "/api/v1/access-requests/export", act)).json?.kind, "act")
    server.routePreference = "static"
    refused(await call("GET", "/api/v1/access-requests/export", act), "static: the read")
    assert.equal((await call("GET", "/api/v1/access-requests/export", read)).json?.kind, "read")
    server.routePreference = "dynamic"
    refused(await call("GET", "/api/v1/access-requests/export", read), "dynamic: the act")
    assert.equal((await call("GET", "/api/v1/access-requests/export", act)).json?.kind, "act")
    assert.equal(server.runs("GET", "/api/v1/access-requests/export"), 1)
    assert.equal(server.runs("GET", "/api/v1/access-requests/{id}"), 2)
  })
})

// Two versions on one computer share one connection, one list and one lock.
const [first, second] = impls
if (first && second) {
  describe(`${NAME} (${first} and ${second} together)`, () => {
    let server
    before(async () => {
      server = await startFakeServer()
    })
    after(() => server.close())

    it("use the same connection and refresh it once between them", async () => {
      const inst = install()
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(first, inst, server)
      const devices = server.counts.device
      const s = await run(second, inst, server, ["status"])
      assert.equal(s.json.status, "connected", s.out + s.err)
      const before = server.counts.refresh
      const all = await Promise.all(
        Array.from({ length: 8 }, (_, i) => run(i % 2 ? second : first, inst, server, ["get", "/api/v1/problems"])),
      )
      for (const r of all) assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.counts.refresh, before + 1)
      assert.equal(server.counts.reuse, 0)
      assert.equal(server.counts.device, devices, "no second connection")
      // The list one version kept is the one the other uses.
      const listing = server.counts.listing
      assert.equal((await run(second, inst, server, ["post", "/api/v1/access-requests", "--json", "{}"])).code, 0)
      assert.equal((await run(first, inst, server, ["get", "/api/v1/access-requests/1"])).code, 0)
      assert.equal(server.counts.listing, listing)
    })
  })
}

// The entry points pick a version (Node when there is one) and pass the arguments on as they are.
describe(`${NAME} entry points`, () => {
  let server
  before(async () => {
    server = await startFakeServer()
  })
  after(() => server.close())
  const entry = win ? "entry-ps" : "entry-sh"
  for (const [name, env] of [
    ["with Node", { [`${ENV}NO_NODE`]: "" }],
    ["without Node", { [`${ENV}NO_NODE`]: "1" }],
  ]) {
    it(`${entry} ${name} keeps a query with & as it is`, async () => {
      const inst = install()
      await connected("node", inst, server)
      const r = await run(entry, inst, server, ["get", "/api/v1/problems?status=open&owner=x"], env)
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json.data.query, "?status=open&owner=x")
    })
  }
})
