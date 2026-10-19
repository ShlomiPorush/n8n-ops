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
const impls = (process.env.N8N_OPS_IMPLS ?? (win ? "node,ps" : "node,sh")).split(",").filter(Boolean)
const root = fs.mkdtempSync(path.join(process.env.N8N_OPS_TEST_TMP ?? os.tmpdir(), "n8n-ops-skill-"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A fresh install of the skill (its own folder, so its own connection) and its own credentials folder. */
function install(name = ".claude-test") {
  const base = fs.mkdtempSync(path.join(root, "agent-"))
  const dir = path.join(base, name, "skills", "n8n-ops", "scripts")
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(scripts)) fs.copyFileSync(path.join(scripts, f), path.join(dir, f))
  const creds = path.join(base, "creds")
  return { dir, creds, base }
}

function command(impl, dir) {
  if (impl === "node") return [process.execPath, [path.join(dir, "n8n-ops.mjs")]]
  if (impl === "sh") return ["sh", [path.join(dir, "n8n-ops.sh")]]
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

/** Runs one command; resolves with its exit code, its parsed answer and its raw output. */
function run(impl, inst, server, args, env = {}) {
  const [cmd, base] = command(impl, inst.dir)
  const child = spawn(cmd, [...base, ...args, "--url", server.issuer], {
    env: {
      ...process.env,
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

    it("connects with a code the person approves, named after the agent and the computer", async () => {
      const inst = fresh()
      const c = await run(impl, inst, server, ["connect"])
      assert.equal(c.code, 0, c.out + c.err)
      assert.equal(c.json.status, "pending")
      assert.match(c.json.link, new RegExp(`^${server.issuer}/connect/device\\?user_code=`))
      assert.match(c.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      assert.match(server.lastLabel, /^Claude Code \(\.claude-test\) on /)
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
      const left = fs.readdirSync(inst.creds).filter((f) => !/^[0-9a-f]{32}\.json$/.test(f))
      assert.deepEqual(left, [])
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
      const p = run(impl, inst, server, ["get", "instances"], {
        N8N_OPS_TEST_HOLD_BEFORE_WRITE: hold,
        N8N_OPS_LOCK_WAIT_MS: "8000",
      })
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
      await sleep(1000)
      // ...then the third lets go, and the first lock is put back.
      fs.rmSync(lock)
      fs.renameSync(`${lock}.moved`, lock)
      const r = await p
      assert.equal(r.code, 0, r.out + r.err)
      const refreshes = server.counts.refresh
      assert.equal((await run(impl, inst, server, ["get", "instances"])).code, 0)
      assert.equal(server.counts.refresh, refreshes, "the new tokens were kept")
      assert.equal(server.counts.reuse, 0)
    })

    if (!win) {
      it("refuses to run from a skill folder it cannot write its id in", async () => {
        const inst = fresh()
        const skillDir = path.dirname(inst.dir)
        fs.chmodSync(skillDir, 0o555)
        try {
          const r = await run(impl, inst, server, ["status"])
          assert.equal(r.json?.error, "cannot_save", r.out + r.err)
        } finally {
          fs.chmodSync(skillDir, 0o755)
        }
      })
    }

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
