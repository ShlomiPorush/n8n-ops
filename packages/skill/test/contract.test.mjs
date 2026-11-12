// The command's contract, run against every version this computer can run (N8N_OPS_IMPLS picks them): the same
// answers, and the same care with the refresh token, which the server cuts off the moment it is used twice.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { startFakeServer } from "./fake-server.mjs"

const win = process.platform === "win32"
const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "n8n-ops", "scripts")
// ps is Windows PowerShell 5.1, pwsh PowerShell 7: the same n8n-ops.ps1 runs on both.
const impls = (process.env.N8N_OPS_IMPLS ?? (win ? "node,ps,pwsh" : "node,sh")).split(",").filter(Boolean)
const root = fs.mkdtempSync(path.join(process.env.N8N_OPS_TEST_TMP ?? os.tmpdir(), "n8n-ops-skill-"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const connectNext = (issuer) =>
  `End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: n8n-ops connect --wait --url "${issuer}"`
const waitNext = (issuer) => `Not approved yet. Run again: n8n-ops connect --wait --url "${issuer}"`

/**
 * A fresh install of the skill and a credentials folder of its own (a computer user of its own). Pass `creds` for
 * another install of the same user. `url` fills in the address as n8n-ops does when it serves the skill.
 */
function install({ creds, url } = {}) {
  const base = fs.mkdtempSync(path.join(root, "agent-"))
  const dir = path.join(base, ".claude-test", "skills", "n8n-ops", "scripts")
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(scripts)) {
    let text = fs.readFileSync(path.join(scripts, f), "utf8")
    if (url) text = text.replaceAll("__N8N_OPS_URL__", url)
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
  if (impl === "node") return [process.execPath, [path.join(dir, "n8n-ops.mjs")]]
  if (impl === "sh") return ["sh", [path.join(dir, "n8n-ops.sh")]]
  if (impl === "pwsh")
    return [
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "n8n-ops.ps1")],
    ]
  // The entry points agents run, which pick a version themselves.
  if (impl === "entry-sh") return ["sh", [path.join(dir, "n8n-ops")]]
  if (impl === "entry-ps")
    return [
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "n8n-ops.ps1")],
    ]
  if (impl === "ps")
    return [
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "n8n-ops.ps1")],
    ]
  throw new Error(`unknown impl ${impl}`)
}

/** Runs one command; resolves with its exit code, its parsed answer and its raw output. No server: no --url. */
function run(impl, inst, server, args, env = {}) {
  const [cmd, base] = command(impl, inst.dir)
  return start(impl, inst, cmd, [...base, ...args, ...(server ? ["--url", server.issuer] : [])], env)
}

/** Starts a process (the command, or a shell that runs it) with the environment of `impl` and `inst`. */
function start(impl, inst, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      N8N_OPS_URL: "",
      N8N_OPS_CREDENTIALS: inst.creds,
      N8N_OPS_NO_NODE: impl === "node" ? "" : "1",
      N8N_OPS_TEST_POLL_SECONDS: "1",
      N8N_OPS_WAIT_SECONDS: "8",
      ...(win ? { USERPROFILE: root } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
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
 * The shells an agent may run a printed hint in, here: each defines `n8n-ops` as the command under test and runs the
 * hint's command as it is. bash with failglob and zsh refuse an unquoted file pattern, such as the brackets of an IPv6
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
    args: (line, prefix) => [...opts, "-c", `pre=("$@"); n8n-ops() { "\${pre[@]}" "$@"; }; ${line}`, name, ...prefix],
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
        `$pre = $env:N8N_OPS_HINT_PREFIX -split "\`n"; function n8n-ops { & $pre[0] $pre[1..($pre.Length - 1)] @args }; ${line}`,
      ],
      env: (prefix) => ({ N8N_OPS_HINT_PREFIX: prefix.join("\n") }),
    })
  return { shells, missing }
}

/** Runs the command a hint names (what follows `before` in it) in a shell, as an agent would. */
function runHint(shell, impl, inst, text, before) {
  const line = text.split(before)[1]
  assert.ok(line?.startsWith("n8n-ops "), text)
  const [cmd, base] = command(impl, inst.dir)
  const prefix = [win && shell.name === "bash" ? cmd.replaceAll("\\", "/") : cmd, ...base]
  return start(impl, inst, shell.bin, shell.args(line, prefix), {
    // Git's bash would otherwise rewrite arguments that look like paths.
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*",
    N8N_OPS_WAIT_SECONDS: "2",
    ...shell.env?.(prefix),
  })
}

/**
 * Replaces a file by renaming another onto it, in one step, so the name is never free. A Windows runner once failed
 * such a rename with EPERM; a likely cause is another process that still had the file open (the PowerShell version
 * reads with delete sharing, and a virus scanner may open a new file), so on Windows it tries again for about a second
 * on EPERM, or on EBUSY, which a sharing violation gives.
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

function noSecrets(server, ...results) {
  for (const r of results)
    for (const s of server.secrets()) assert.ok(!r.out.includes(s), "a token appeared in the output")
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

for (const impl of impls) {
  describe(`n8n-ops (${impl})`, () => {
    let server
    before(async () => {
      server = await startFakeServer()
    })
    after(() => server.close())
    const fresh = () => {
      Object.assign(server, {
        accessTtl: 900,
        refreshAccessTtl: null,
        dropNextRefresh: false,
        revokeStatus: 200,
        refreshDelayMs: 0,
      })
      for (const k of Object.keys(server.counts)) server.counts[k] = 0
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
      assert.match(server.lastLabel, /^Agents on .+/)
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
      assert.equal(w.json.scope, "ops:read ops:access offline_access")
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
      const w = await run(impl, inst, server, ["connect", "--wait"], { N8N_OPS_WAIT_SECONDS: "3" })
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
      const r = await run(impl, inst, server, ["get", "problems?status=open"])
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json.data.path, "/api/v1/problems")
      assert.equal(r.json.data.query, "?status=open")
      assert.equal(server.counts.refresh, before, "no refresh while the token lasts")
      server.expireAccessTokens()
      const again = await run(impl, inst, server, ["get", "/instances"])
      assert.equal(again.code, 0, again.out + again.err)
      assert.equal(server.counts.refresh, before + 1, "one refresh after a 401")
      assert.equal(server.counts.reuse, 0)
      noSecrets(server, r, again)
    })

    it("refreshes once when ten commands find the token about to run out at the same time", async () => {
      const inst = fresh()
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      const before = server.counts.refresh
      const all = await Promise.all(Array.from({ length: 10 }, () => run(impl, inst, server, ["get", "instances"])))
      for (const r of all) assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.counts.refresh, before + 1)
      assert.equal(server.counts.reuse, 0)
    })

    it("posts a JSON body, and says when the agent may not ask for instance access", async () => {
      const inst = fresh()
      await connected(impl, inst, server, { access: false })
      const body = path.join(inst.base, "body.json")
      fs.writeFileSync(
        body,
        JSON.stringify({ instance: "prod", reason: "Fix the failing webhook", scopes: ["workflow:read"], minutes: 5 }),
      )
      const r = await run(impl, inst, server, ["post", "access-requests", "--json-file", body])
      assert.equal(r.json.error, "insufficient_scope", r.out + r.err)
      const ok = await run(impl, inst, server, ["post", "access-requests/x/release"])
      assert.equal(ok.code, 0, ok.out + ok.err)
      assert.equal(ok.json.data.method, "POST")
    })

    it("refuses an address without https, and a path outside the API", async () => {
      const inst = fresh()
      const [cmd, base] = command(impl, inst.dir)
      const res = await new Promise((resolve) => {
        const child = spawn(cmd, [...base, "status", "--url", "http://example.com"], {
          env: {
            ...process.env,
            N8N_OPS_CREDENTIALS: inst.creds,
            N8N_OPS_NO_NODE: impl === "node" ? "" : "1",
            ...(win ? { USERPROFILE: root } : {}),
          },
        })
        let out = ""
        child.stdout.on("data", (d) => {
          out += d
        })
        child.on("close", (code) => resolve({ code, json: JSON.parse(out.trim()) }))
      })
      assert.equal(res.json.error, "insecure_url")
      await connected(impl, inst, server)
      for (const p of [
        "../oauth/token",
        "%2e%2e/%2E%2e/oauth/token",
        "https://evil.example/x",
        "//evil.example/x",
        "a b",
      ]) {
        const r = await run(impl, inst, server, ["get", p])
        assert.equal(r.json?.error, "bad_path", `${p}: ${r.out}`)
      }
    })

    it("ends when n8n-ops ended the connection, and forgets it", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.endAllGrants()
      server.expireAccessTokens()
      const r = await run(impl, inst, server, ["get", "instances"])
      assert.equal(r.json.error, "connection_ended", r.out + r.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "not_connected")
    })

    it("retries a refresh whose answer was lost once, which ends the connection and the token nobody got", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      server.dropNextRefresh = true
      const lost = await run(impl, inst, server, ["get", "instances"])
      assert.equal(lost.json.error, "unreachable", lost.out + lost.err)
      const orphan = server.orphan
      const refreshes = server.counts.refresh
      // Right after, the lost refresh might still be on its way: nothing is sent.
      const soon = await run(impl, inst, server, ["get", "instances"])
      assert.equal(soon.json.error, "busy", soon.out + soon.err)
      assert.equal(server.counts.refresh, refreshes)
      const next = await run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_REFRESH_GRACE: "0" })
      assert.equal(next.json.error, "connection_ended", next.out + next.err)
      assert.equal(server.grants.get(server.refresh.get(orphan).grant).alive, false, "the orphaned token's grant ended")
    })

    it("treats an answer that broke off like a lost one", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      server.truncateNextRefresh = true
      const broken = await run(impl, inst, server, ["get", "instances"])
      assert.equal(broken.json.error, "unreachable", broken.out + broken.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "connected", "the connection is kept")
      const orphan = server.orphan
      const next = await run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_REFRESH_GRACE: "0" })
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
      const down = await run(impl, inst, server, ["get", "instances"])
      assert.equal(down.json.error, "unreachable", down.out + down.err)
      await server.start()
      const up = await run(impl, inst, server, ["get", "instances"])
      assert.equal(up.code, 0, up.out + up.err)
      assert.equal(server.counts.refresh, 1, "only the refresh that reached n8n-ops")
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
      assert.equal(server.grants.get(old).alive, true, "n8n-ops did not confirm, so it is still to be ended")
      // The new connection ends; the old one must still be ended.
      for (const id of alive()) if (id !== old && !others.has(id)) server.grants.get(id).alive = false
      server.expireAccessTokens()
      const ended = await run(impl, inst, server, ["get", "instances"])
      assert.equal(ended.json.error, "connection_ended", ended.out + ended.err)
      server.revokeStatus = 200
      const again = await run(impl, inst, server, ["connect"])
      assert.equal(again.json.status, "pending", again.out + again.err)
      assert.equal(server.grants.get(old).alive, false, "ended once n8n-ops answered")
    })

    it("works in a folder whose path has spaces, and leaves no temp files", async () => {
      const inst = fresh()
      inst.creds = path.join(inst.base, "my creds")
      // A file named like the path's first word, which a split path would hit.
      fs.writeFileSync(path.join(inst.base, "my"), "keep")
      server.accessTtl = 30
      server.refreshAccessTtl = 900
      await connected(impl, inst, server)
      assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
      assert.equal(fs.readFileSync(path.join(inst.base, "my"), "utf8"), "keep")
      const left = fs.readdirSync(inst.creds).filter((f) => !/^[0-9a-f]{32}\.json$/.test(f) && f !== "address")
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
      assert.equal((await run(impl, other, server, ["get", "instances"])).code, 0)
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
        assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
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
      assert.equal((await run(impl, inst, null, ["get", "instances"])).code, 0)
      // An address given, or the one a copy served by n8n-ops carries, comes before the kept one.
      const other = "https://other.example"
      assert.equal((await run(impl, inst, null, ["status", "--url", other])).json.url, other)
      assert.equal((await run(impl, inst, null, ["status"], { N8N_OPS_URL: other })).json.url, other)
      const served = install({ creds: inst.creds, url: other })
      assert.equal((await run(impl, served, null, ["status"])).json.url, other)
      // A damaged one is refused, not guessed at.
      fs.writeFileSync(kept, "ops.example\n")
      const bad = await run(impl, inst, null, ["status"])
      assert.equal(bad.json?.error, "no_url", bad.out + bad.err)
      assert.match(bad.json.message, /kept/)
      // Line breaks at its end are fine, a second line is not, and a folder in its place is refused.
      fs.writeFileSync(kept, `${server.issuer}\r\n`)
      const crlf = await run(impl, inst, null, ["status"])
      assert.equal(crlf.json?.url, server.issuer, crlf.out + crlf.err)
      // (Joined, the two lines would make another valid address.)
      fs.writeFileSync(kept, "https://ops.example\ngarbage\n")
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
      // The same origins as before.
      for (const [given, origin] of [
        ["https://ops.example.com/", "https://ops.example.com"],
        ["https://OPS.Example.com", "https://ops.example.com"],
        ["https://ops.example.com:443", "https://ops.example.com"],
        ["https://ops.example.com:8443", "https://ops.example.com:8443"],
        ["https://ops.example.com:65535", "https://ops.example.com:65535"],
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
        "https://ops.example.com:12bad",
        "https://ops.example.com:70000",
        "https://ops.example.com:65536",
        "https://ops.example.com:0",
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
        const g = await run(impl, inst, v6, ["get", "instances"])
        assert.equal(g.json?.data?.path, "/api/v1/instances", g.out + g.err)
        const r = await run(impl, inst, v6, ["post", "access-requests/x/release"])
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
        // A new code for the kept address, then another agent of this user connects to a second n8n-ops.
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
        assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
      } finally {
        await second.close()
      }
    })

    it("disconnects, and keeps what n8n-ops did not confirm to try again", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.revokeStatus = 500
      const failed = await run(impl, inst, server, ["disconnect"])
      assert.equal(failed.json.error, "disconnect_failed", failed.out + failed.err)
      assert.equal(server.aliveGrants() > 0, true)
      server.revokeStatus = 200
      const ok = await run(impl, inst, server, ["disconnect"])
      assert.equal(ok.json.status, "disconnected", ok.out + ok.err)
      assert.equal((await run(impl, inst, server, ["status"])).json.status, "not_connected")
    })

    it("replaces a connection and ends the old one only once the new one is stored", async () => {
      const inst = fresh()
      const alive = () => [...server.grants.entries()].filter(([, g]) => g.alive).map(([id]) => id)
      const others = new Set(alive())
      await connected(impl, inst, server)
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
      assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
    })

    it("never takes the lock from a live holder: others answer busy and send nothing", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      const hold = path.join(inst.base, "hold-live")
      const holder = run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      const before = server.counts.refresh
      const other = await run(impl, inst, server, ["get", "instances"], { N8N_OPS_LOCK_WAIT_MS: "1500" })
      assert.equal(other.json.error, "busy", other.out + other.err)
      assert.equal(server.counts.refresh, before)
      fs.writeFileSync(`${hold}.go`, "")
      assert.equal((await holder).code, 0)
      assert.equal(server.counts.reuse, 0)
    })

    it("takes over the lock of a holder that died", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      const hold = path.join(inst.base, "hold-dead")
      const holder = run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      holder.child.kill("SIGKILL")
      await holder
      const next = await run(impl, inst, server, ["get", "instances"])
      assert.equal(next.code, 0, next.out + next.err)
      assert.equal(server.counts.reuse, 0)
    })

    it("lets only one of two processes take a dead holder's lock", async () => {
      const inst = fresh()
      await connected(impl, inst, server)
      server.expireAccessTokens()
      // A dead lock, as a killed holder leaves it.
      const hold = path.join(inst.base, "hold-dead2")
      const holder = run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      holder.child.kill("SIGKILL")
      await holder
      // B sees the dead lock and stops just before moving it; C breaks it, takes a fresh lock, and holds it.
      const b = path.join(inst.base, "b")
      const cHold = path.join(inst.base, "c")
      const pb = run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_HOLD_BREAK_OBSERVED: b })
      await reached(b)
      const pc = run(impl, inst, server, ["get", "instances"], { N8N_OPS_TEST_HOLD_LOCKED: cHold })
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
      const p = run(impl, inst, server, ["get", "instances"], {
        N8N_OPS_TEST_HOLD_BEFORE_WRITE: hold,
        N8N_OPS_TEST_HOLD_LOCK_BUSY: busy,
        N8N_OPS_LOCK_WAIT_MS: "8000",
      })
      try {
        await reached(hold)
        const lock = path.join(inst.creds, fs.readdirSync(inst.creds).find((f) => f.endsWith(".lock")) ?? "")
        // As a mistaken breaker would: it moves the lock away, and a live third process takes the place...
        fs.renameSync(lock, `${lock}.moved`)
        const host = win ? process.env.COMPUTERNAME : os.hostname()
        fs.writeFileSync(
          lock,
          JSON.stringify({ pid: process.pid, host, token: "third", startedAt: Math.floor(Date.now() / 1000) }),
        )
        fs.writeFileSync(`${hold}.go`, "")
        // The process found the third's lock and waits for it...
        await reached(busy)
        // ...then the first lock is put back in the third's place, with no moment without a lock.
        await replaceWith(`${lock}.moved`, lock)
      } finally {
        // Never leave the process held, whatever failed above.
        fs.writeFileSync(`${hold}.go`, "")
        fs.writeFileSync(`${busy}.go`, "")
      }
      const r = await p
      assert.equal(r.code, 0, r.out + r.err)
      const refreshes = server.counts.refresh
      assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
      assert.equal(server.counts.refresh, refreshes, "the new tokens were kept")
      assert.equal(server.counts.reuse, 0)
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

// Two versions on one computer share one connection and one lock.
const [first, second] = impls
if (first && second) {
  describe(`n8n-ops (${first} and ${second} together)`, () => {
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
        Array.from({ length: 8 }, (_, i) => run(i % 2 ? second : first, inst, server, ["get", "instances"])),
      )
      for (const r of all) assert.equal(r.code, 0, r.out + r.err)
      assert.equal(server.counts.refresh, before + 1)
      assert.equal(server.counts.reuse, 0)
      assert.equal(server.counts.device, devices, "no second connection")
    })
  })
}

// The entry points pick a version (Node when there is one) and pass the arguments on as they are.
describe("n8n-ops entry points", () => {
  let server
  before(async () => {
    server = await startFakeServer()
  })
  after(() => server.close())
  const entry = win ? "entry-ps" : "entry-sh"
  for (const [name, env] of [
    ["with Node", { N8N_OPS_NO_NODE: "" }],
    ["without Node", { N8N_OPS_NO_NODE: "1" }],
  ]) {
    it(`${entry} ${name} keeps a query with & as it is`, async () => {
      const inst = install()
      await connected("node", inst, server)
      const r = await run(entry, inst, server, ["get", "problems?status=open&instance=x"], env)
      assert.equal(r.code, 0, r.out + r.err)
      assert.equal(r.json.data.query, "?status=open&instance=x")
    })
  }
})
