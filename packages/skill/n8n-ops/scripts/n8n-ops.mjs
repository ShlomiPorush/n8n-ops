#!/usr/bin/env node
/*
 * n8n-ops for agents: connect with a code a person approves (OAuth device flow, RFC 8628), then read n8n-ops and
 * ask for temporary n8n instance access through its REST API.
 *
 * One of three versions with one contract: n8n-ops.mjs (Node 20+), n8n-ops.ps1 (Windows PowerShell 5.1+) and
 * n8n-ops.sh (POSIX sh and curl). Same commands, same JSON output and error codes, same files and the same lock,
 * so they can run side by side on one computer. Tokens never appear in the output.
 *
 * The refresh token rotates on every use, and the server ends the connection when one is used twice. So every
 * change to the connection's file and every request that spends a one-time secret runs under one lock, the
 * access token is reused until a minute before it runs out, and a refresh whose answer was lost is retried once.
 */
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Filled in with the n8n-ops address when the file is downloaded from n8n-ops.
const DEFAULT_URL = "__N8N_OPS_URL__"
const CLIENT_ID = "n8n-ops-cli"
const SCOPE = "ops:read ops:access offline_access"
const WAIT_SECONDS = Number(process.env.N8N_OPS_WAIT_SECONDS) || 90
const LOCK_WAIT_MS = Number(process.env.N8N_OPS_LOCK_WAIT_MS) || 20_000
const TIMEOUT_MS = 15_000
// RFC 8628: 5 seconds between polls unless the server says otherwise (tests shorten it).
const POLL_SECONDS = Number(process.env.N8N_OPS_TEST_POLL_SECONDS) || 5
// A refresh is retried only once it cannot be in flight any more: twice the request timeout (tests shorten it).
const REFRESH_GRACE = Number(process.env.N8N_OPS_TEST_REFRESH_GRACE ?? 30)
const SECRET = /^[A-Za-z0-9._~+/=-]{1,4096}$/
// Every value in a connection file: no quote, backslash or control character, so the shell version reads it too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const PLAIN = /^[^"\\\u0000-\u001f\u007f]*$/
const PATH_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+$/
const FIELDS = [
  ["v", "n"],
  ["issuer", "s"],
  ["label", "s"],
  ["generation", "s"],
  ["refreshToken", "s"],
  ["accessToken", "s"],
  ["accessExpiresAt", "n"],
  ["scope", "s"],
  ["refreshStartedAt", "n"],
  ["refreshRetried", "n"],
  ["deviceCode", "s"],
  ["userCode", "s"],
  ["link", "s"],
  ["deviceExpiresAt", "n"],
  ["interval", "n"],
  ["nextPollAt", "n"],
  ["toRevoke", "s"],
]
const win = process.platform === "win32"

class Fail extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const now = () => Math.floor(Date.now() / 1000)
const hex = (n) => randomBytes(n).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const host = () => (win ? process.env.COMPUTERNAME || os.hostname() : os.hostname())
const sameHost = (h) => String(h).toLowerCase() === host().toLowerCase()
// Windows tools by their full path: in Git Bash, for one, whoami is a different program.
const system32 = (exe) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", exe)

const HELP = `n8n-ops: use n8n-ops after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to ${WAIT_SECONDS} s for the approval; run again while it answers still_waiting.
  get <path>            GET /api/v1<path>, for example: get 'problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this agent is connected (no secrets).
  disconnect            End this agent's connection.

  --url <address>       The n8n-ops address (or N8N_OPS_URL).`

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift() ?? "help"
  const opts = { positional: [] }
  while (args.length) {
    const a = args.shift()
    if (a === "--url") opts.url = args.shift()
    else if (a === "--replace") opts.replace = true
    else if (a === "--wait") opts.wait = true
    else if (a === "--json") opts.json = args.shift()
    else if (a === "--json-file") opts.jsonFile = args.shift()
    else opts.positional.push(a)
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`)
    return
  }
  if (Number(process.versions.node.split(".")[0]) < 20)
    throw new Fail("node_too_old", "Node 20 or later is needed. Use n8n-ops.ps1 or n8n-ops.sh instead.")
  const ctx = context(opts.url)
  if (command === "status") return status(ctx)
  if (command === "connect") return opts.wait ? waitForApproval(ctx) : connect(ctx, Boolean(opts.replace))
  if (command === "get") return api(ctx, "GET", opts.positional[0])
  if (command === "post") return api(ctx, "POST", opts.positional[0], body(opts))
  if (command === "disconnect") return disconnect(ctx)
  throw new Fail("unknown_command", `Unknown command "${command}". Run: n8n-ops help`)
}

function body(opts) {
  if (opts.jsonFile !== undefined) {
    try {
      return fs.readFileSync(opts.jsonFile, "utf8")
    } catch {
      throw new Fail("bad_body", `Cannot read ${opts.jsonFile}.`)
    }
  }
  return opts.json ?? "{}"
}

/** The n8n-ops address, this agent's identity (the folder it is installed in) and where its connection is kept. */
function context(urlOption) {
  const raw = urlOption || process.env.N8N_OPS_URL || (DEFAULT_URL.startsWith("__") ? "" : DEFAULT_URL)
  if (!raw) throw new Fail("no_url", "No n8n-ops address. Pass --url https://<your n8n-ops> or set N8N_OPS_URL.")
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Fail("insecure_url", `"${raw}" is not an address.`)
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Fail("insecure_url", "The n8n-ops address must start with https:// (http only for this computer).")
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Fail("insecure_url", "Use the n8n-ops address alone, for example https://ops.example.com.")
  const issuer = url.origin
  const install = installDir()
  const dir = credentialsDir()
  const key = createHash("sha256")
    .update(`${issuer}\n${installId(install)}`)
    .digest("hex")
    .slice(0, 32)
  return {
    issuer,
    install,
    dir,
    file: path.join(dir, `${key}.json`),
    lock: path.join(dir, `${key}.lock`),
    label: label(install),
  }
}

/** The skill's folder: one connection per place the skill is installed (one agent). */
function installDir() {
  return path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
}

/**
 * This install's id, kept in the skill's folder (`.install-id`), so every version agrees on it however each one
 * spells the folder's path (short 8.3 names, links, letter case). Published in one step: written aside, then
 * linked into place, which fails if another process got there first.
 */
function installId(install) {
  const file = path.join(install, ".install-id")
  const read = () => {
    try {
      const id = fs.readFileSync(file, "utf8").trim()
      return /^[0-9a-f]{32}$/.test(id) ? id : null
    } catch {
      return null
    }
  }
  const existing = read()
  if (existing) return existing
  const tmp = `${file}.${hex(6)}`
  try {
    fs.writeFileSync(tmp, `${hex(16)}\n`, { flag: "wx" })
    fs.linkSync(tmp, file)
  } catch {
    // Another process published one first, or the folder cannot be written.
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  const id = read()
  if (!id) throw new Fail("cannot_save", `Cannot write in ${install}. The agent's id is kept there; allow writing it.`)
  return id
}

/** What the agent is called on the approval page and in Settings: which agent, on which computer. */
function label(install) {
  if (process.env.N8N_OPS_AGENT_NAME) return process.env.N8N_OPS_AGENT_NAME.slice(0, 60)
  let agent = "Agent"
  for (const part of install.split(/[\\/]/)) {
    const p = part.toLowerCase()
    if (p.startsWith(".claude")) {
      agent = p === ".claude" ? "Claude Code" : `Claude Code (${p})`
      break
    }
    if (p.startsWith(".codex")) {
      agent = p === ".codex" ? "Codex" : `Codex (${p})`
      break
    }
    if (p.startsWith(".cursor")) {
      agent = "Cursor"
      break
    }
  }
  return `${agent} on ${host()}`.slice(0, 60)
}

function credentialsDir() {
  const override = process.env.N8N_OPS_CREDENTIALS
  if (win) {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    const dir = path.resolve(override || path.join(appData, "n8n-ops"))
    const home = path.resolve(process.env.USERPROFILE || os.homedir()).toLowerCase()
    const lower = dir.toLowerCase()
    if (lower !== home && !lower.startsWith(`${home}\\`))
      throw new Fail("insecure_credentials", `Keep the n8n-ops folder inside your user profile (${home}), not ${dir}.`)
    return dir
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.resolve(override || path.join(base, "n8n-ops"))
}

let secured = false
/** Creates the folder if needed and checks that only this user can read it; never loosens or fixes it silently. */
function secureDir(dir) {
  if (secured) return
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    throw new Fail("cannot_save", `Cannot create ${dir}. Allow this agent to write there.`)
  }
  const st = fs.lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Fail("insecure_credentials", `${dir} must be a plain folder, not a link.`)
  if (win) {
    // Mode bits are no ACL on Windows: the folder is limited to this user, SYSTEM and Administrators.
    try {
      const sid = /"(S-1-[0-9-]+)"\s*$/.exec(
        execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).toString().trim(),
      )
      if (!sid) throw new Error("no SID")
      execFileSync(
        system32("icacls.exe"),
        [
          dir,
          "/inheritance:r",
          "/grant:r",
          `*${sid[1]}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
          "/Q",
        ],
        { stdio: "ignore" },
      )
      // The owner may always change an ACL, so the folder and its files must be this user's. (Only now: taking
      // ownership needs the full control just granted. No /C, which would hide a failure behind exit code 0.)
      icacls([dir, "/setowner", `*${sid[1]}`, "/T", "/Q"])
      // Granting does not remove other entries: read the folder's and its files' ACLs back and allow no one else.
      const saved = path.join(dir, `.acl-${hex(4)}`)
      try {
        icacls([dir, "/save", saved, "/T", "/Q"])
        const other = othersAllowed(fs.readFileSync(saved).toString("utf16le"), sid[1])
        if (other) throw new Fail("insecure_credentials", `Others can open ${dir} (${other}). Remove their access.`)
      } finally {
        fs.rmSync(saved, { force: true })
      }
    } catch (e) {
      if (e instanceof Fail) throw e
      throw new Fail("insecure_credentials", `Could not limit ${dir} to your user (icacls failed).`)
    }
  } else {
    if (st.uid !== process.getuid())
      throw new Fail("insecure_credentials", `${dir} belongs to another user. Use a folder of your own.`)
    if (st.mode & 0o077) throw new Fail("insecure_credentials", `Others can open ${dir}. Run: chmod 700 '${dir}'`)
  }
  secured = true
}

/** icacls over the folder and its files; tried again while other commands add or replace files in it. */
function icacls(args) {
  for (let i = 0; ; i++) {
    try {
      execFileSync(system32("icacls.exe"), args, { stdio: "ignore" })
      return
    } catch (e) {
      if (i >= 4) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + Math.random() * 200)
    }
  }
}

/**
 * What in saved ACLs (icacls /save: one SDDL line per object) lets anyone but this user, SYSTEM and Administrators
 * in. Anything but plain allow and deny entries (conditional or callback ones) counts too: refused, not guessed.
 */
function othersAllowed(saved, userSid) {
  const allowed = new Set([userSid, "SY", "BA", "S-1-5-18", "S-1-5-32-544"])
  // SDDL writes the built-in Administrator account (RID 500) as LA, so a user who is that account shows as LA.
  if (/^S-1-5-21-[0-9-]+-500$/.test(userSid)) allowed.add("LA")
  for (const line of saved.split(/\r?\n/)) {
    const at = line.indexOf("D:")
    if (at < 0) continue
    const dacl = line.slice(at + 2).split(/S:/)[0]
    let depth = 0
    let ace = ""
    for (const ch of dacl) {
      if (ch === "(") {
        depth++
        if (depth > 1) return "a conditional entry"
        ace = ""
      } else if (ch === ")") {
        depth--
        const [type, , , , , sid] = ace.split(";")
        if (!["A", "D", "OA", "OD"].includes(type)) return `an entry of type ${type}`
        if ((type === "A" || type === "OA") && !allowed.has(sid)) return sid
      } else if (depth === 1) ace += ch
    }
  }
  return null
}

function checkFile(file) {
  const st = fs.lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) throw new Fail("insecure_credentials", `${file} must be a plain file.`)
  if (!win) {
    if (st.uid !== process.getuid()) throw new Fail("insecure_credentials", `${file} belongs to another user.`)
    if (st.mode & 0o077) throw new Fail("insecure_credentials", `Others can read ${file}. Run: chmod 600 '${file}'`)
  }
}

function readRecord(ctx) {
  let text
  try {
    checkFile(ctx.file)
    text = fs.readFileSync(ctx.file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Fail("insecure_credentials", `${ctx.file} is damaged. Delete it and connect again.`)
  }
  const rec = {}
  for (const [k, type] of FIELDS) rec[k] = type === "n" ? Number(parsed[k]) || 0 : String(parsed[k] ?? "")
  return rec
}

function emptyRecord(ctx) {
  const rec = {}
  for (const [k, type] of FIELDS) rec[k] = type === "n" ? 0 : ""
  return { ...rec, v: 1, issuer: ctx.issuer, label: ctx.label }
}

function serialize(rec) {
  const parts = FIELDS.map(([k, type]) => {
    if (type === "n") return `"${k}":${Math.max(0, Math.floor(Number(rec[k]) || 0))}`
    const value = String(rec[k] ?? "")
    if (!PLAIN.test(value)) throw new Fail("unexpected_answer", `n8n-ops sent a value that cannot be stored (${k}).`)
    return `"${k}":"${value}"`
  })
  return `{${parts.join(",")}}\n`
}

/** Writes the connection's file in one step: a private temp file, synced, renamed over the old one. */
function writeRecord(ctx, rec) {
  secureDir(ctx.dir)
  const tmp = `${ctx.file}.${hex(6)}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, "wx", 0o600)
    fs.writeSync(fd, serialize(rec))
    fs.fsyncSync(fd)
  } catch (e) {
    if (e instanceof Fail) throw e
    throw new Fail("cannot_save", `Cannot write in ${ctx.dir}. Allow this agent to write there.`)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  renameOver(tmp, ctx.file)
}

function renameOver(from, to) {
  // On Windows an open handle (an antivirus scan) can refuse the rename for a moment.
  const until = Date.now() + 5_000
  for (;;) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (!win || !["EPERM", "EBUSY", "EACCES"].includes(e.code) || Date.now() > until) {
        fs.rmSync(from, { force: true })
        throw new Fail("cannot_save", `Cannot replace ${to}.`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

function removeRecord(ctx) {
  fs.rmSync(ctx.file, { force: true })
}

/* The lock: a file created exclusively, naming its holder. Never taken from a live holder, however old. */

function readLock(file) {
  try {
    const text = fs.readFileSync(file, "utf8")
    const held = JSON.parse(text)
    return typeof held?.token === "string" ? held : { empty: true, mtime: fs.statSync(file).mtimeMs }
  } catch (e) {
    if (e.code === "ENOENT") return null
    try {
      return { empty: true, mtime: fs.statSync(file).mtimeMs }
    } catch {
      return null
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // The holder runs as this user, so a process of another user with that number means the holder is gone.
    return win && e.code === "EPERM"
  }
}

async function hook(point) {
  const at = process.env[`N8N_OPS_TEST_HOLD_${point.toUpperCase().replace(/-/g, "_")}`]
  if (!at) return
  fs.writeFileSync(`${at}.reached`, String(process.pid))
  for (let i = 0; i < 1200 && !fs.existsSync(`${at}.go`); i++) await sleep(50)
}

/** Takes the lock; `own` is a lock this process held before, which counts as taken if it is back in place. */
async function acquire(ctx, own) {
  secureDir(ctx.dir)
  const token = hex(16)
  const line = JSON.stringify({ pid: process.pid, host: host(), token, startedAt: now() })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let fd
    try {
      fd = fs.openSync(ctx.lock, "wx", 0o600)
      fs.writeSync(fd, line)
      fs.closeSync(fd)
      await hook("locked")
      return token
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd)
      // Windows refuses for a moment to create a file whose name is still being deleted (a lock just released).
      const deleting = win && (e.code === "EPERM" || e.code === "EACCES") && Date.now() < deadline
      if (deleting) {
        await sleep(50 + Math.random() * 100)
        continue
      }
      if (e.code !== "EEXIST") throw new Fail("cannot_save", `Cannot create a lock in ${ctx.dir}.`)
    }
    const held = readLock(ctx.lock)
    // Another process moved this one's lock away by mistake and has put it back.
    if (own && held && !held.empty && held.token === own) return own
    // A holder that died between creating the lock and writing its name leaves it empty; that takes a moment.
    const dead = held?.empty
      ? Date.now() - held.mtime > 60_000
      : held && sameHost(held.host) && !alive(Number(held.pid))
    if (dead) {
      await hook("break-observed")
      if (await breakLock(ctx, held)) continue
    }
    if (Date.now() > deadline) {
      const old = held && !held.empty && now() - Number(held.startedAt) > 600
      throw new Fail(
        "busy",
        old
          ? `Another n8n-ops command has held ${ctx.lock} for over 10 minutes. If none is running, delete that file.`
          : "Another n8n-ops command is using this connection. Nothing was sent; run it again.",
      )
    }
    await sleep(100 + Math.random() * 200)
  }
}

/**
 * Removes a dead holder's lock. Moving it away is atomic, so of two that try only one moves it; if what was moved
 * is not the dead lock (another process had just taken a fresh one), it goes back unless a newer one is there.
 */
async function breakLock(ctx, held) {
  const moved = `${ctx.lock}.${hex(6)}.dead`
  try {
    fs.renameSync(ctx.lock, moved)
  } catch {
    return true
  }
  await hook("break-moved")
  const got = readLock(moved)
  if (got && (held.empty ? got.empty : got.token === held.token)) {
    fs.rmSync(moved, { force: true })
    return true
  }
  try {
    fs.linkSync(moved, ctx.lock)
  } catch {
    // A newer lock is there already.
  }
  fs.rmSync(moved, { force: true })
  return false
}

const mine = (ctx, token) => readLock(ctx.lock)?.token === token

function release(ctx, token) {
  if (mine(ctx, token)) fs.rmSync(ctx.lock, { force: true })
}

async function withLock(ctx, fn, own) {
  const token = await acquire(ctx, own)
  try {
    return await fn(token)
  } finally {
    release(ctx, token)
  }
}

/** Before spending a one-time secret: the lock must still be ours, or nothing is sent. */
function assertMine(ctx, token) {
  if (!mine(ctx, token)) throw new Fail("busy", "Another n8n-ops command took over this connection. Run it again.")
}

/* Requests */

const NOT_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

async function request(ctx, method, url, { form, bearer, json } = {}) {
  const headers = { accept: "application/json" }
  let payload
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    payload = new URLSearchParams(form).toString()
  } else if (json !== undefined) {
    headers["content-type"] = "application/json"
    payload = json
  }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  let res
  try {
    // No redirects: a secret never follows one to another address.
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const code = e?.cause?.code ?? e?.code
    throw new Fail("unreachable", `Cannot reach ${ctx.issuer} (${code ?? e?.name ?? "network error"}).`, {
      sent: !NOT_SENT.has(code),
    })
  }
  let text
  try {
    text = await res.text()
  } catch {
    // The answer started and broke off: n8n-ops got the request and may have spent a one-time secret.
    throw new Fail("unreachable", `The answer from ${ctx.issuer} broke off.`, { sent: true })
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json: parsed }
}

const oauth = (ctx, p, form) => request(ctx, "POST", `${ctx.issuer}${p}`, { form: { ...form, client_id: CLIENT_ID } })

function httpFail(r, what) {
  const body = r.json !== null && typeof r.json === "object" ? r.json : null
  const detail = body?.error_description || body?.message || body?.error
  return new Fail(`http_${r.status}`, `${what} failed (${r.status}${detail ? `: ${detail}` : ""}).`, { body })
}

function tokensFrom(r) {
  const t = r.json ?? {}
  const scope = typeof t.scope === "string" ? t.scope : ""
  const ok = (v) => typeof v === "string" && SECRET.test(v)
  if (!ok(t.access_token) || !ok(t.refresh_token) || !PLAIN.test(scope))
    throw new Fail("unexpected_answer", "n8n-ops answered without usable tokens.")
  return {
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    accessExpiresAt: now() + Math.max(0, Math.floor(Number(t.expires_in) || 0)),
    scope,
  }
}

async function revokePending(ctx, rec) {
  if (!rec.toRevoke) return rec
  const left = []
  for (const token of rec.toRevoke.split(" ").filter(Boolean)) {
    const r = await oauth(ctx, "/oauth/revoke", { token, token_type_hint: "refresh_token" }).catch(() => null)
    if (r?.status !== 200) left.push(token)
  }
  const next = { ...rec, toRevoke: left.join(" ") }
  if (next.toRevoke !== rec.toRevoke) writeRecord(ctx, next)
  return next
}

/* Commands */

function status(ctx) {
  const rec = readRecord(ctx)
  print({
    status: rec?.refreshToken ? "connected" : rec?.deviceCode ? "pending" : "not_connected",
    url: ctx.issuer,
    label: rec?.label || ctx.label,
    ...(rec?.refreshToken ? { scope: rec.scope, accessExpiresIn: Math.max(0, rec.accessExpiresAt - now()) } : {}),
  })
}

async function connect(ctx, replace) {
  // Before any code exists: can it keep a connection here, and is n8n-ops there?
  secureDir(ctx.dir)
  const probe = path.join(ctx.dir, `.probe-${hex(4)}`)
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 })
    fs.rmSync(probe)
  } catch {
    throw new Fail("cannot_save", `Cannot write in ${ctx.dir}. Allow this agent to write there.`)
  }
  const meta = await request(ctx, "GET", `${ctx.issuer}/.well-known/oauth-authorization-server`)
  if (meta.status !== 200 || meta.json?.issuer !== ctx.issuer)
    throw new Fail("unreachable", `${ctx.issuer} does not answer as n8n-ops (${meta.status}). Check the address.`)

  const result = await withLock(ctx, async (lock) => {
    let rec = readRecord(ctx) ?? emptyRecord(ctx)
    rec = await revokePending(ctx, rec)
    if (rec.refreshToken && !replace) return { status: "already_connected", label: rec.label, scope: rec.scope }
    // The open code again, unless asked for a new one (--replace: the link did not work for the person).
    if (rec.deviceCode && rec.deviceExpiresAt - now() > 30 && !replace) return pending(rec)
    assertMine(ctx, lock)
    const r = await oauth(ctx, "/oauth/device", {
      scope: SCOPE,
      resource: `${ctx.issuer}/api/v1`,
      client_label: ctx.label,
    })
    if (r.status !== 200) throw httpFail(r, "Asking to connect")
    const d = r.json ?? {}
    const link = String(d.verification_uri_complete ?? "")
    if (!SECRET.test(String(d.device_code)) || !/^[A-Z0-9-]{4,20}$/.test(String(d.user_code)) || !PLAIN.test(link))
      throw new Fail("unexpected_answer", "n8n-ops answered without a code.")
    if (!link.startsWith(`${ctx.issuer}/`)) throw new Fail("unexpected_answer", "The approval link is not on n8n-ops.")
    const interval = Math.max(POLL_SECONDS, Math.floor(Number(d.interval) || POLL_SECONDS))
    rec = {
      ...rec,
      label: ctx.label,
      deviceCode: d.device_code,
      userCode: d.user_code,
      link,
      deviceExpiresAt: now() + Math.max(60, Math.floor(Number(d.expires_in) || 600)),
      interval,
      nextPollAt: now() + interval,
    }
    writeRecord(ctx, rec)
    return pending(rec)
  })
  print(result)
}

function pending(rec) {
  return {
    status: "pending",
    link: rec.link,
    code: rec.userCode,
    expiresIn: Math.max(0, rec.deviceExpiresAt - now()),
    next: "End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: n8n-ops connect --wait",
  }
}

function clearPending(rec) {
  return { ...rec, deviceCode: "", userCode: "", link: "", deviceExpiresAt: 0, interval: 0, nextPollAt: 0 }
}

async function waitForApproval(ctx) {
  const until = Date.now() + WAIT_SECONDS * 1000
  for (;;) {
    const step = await withLock(ctx, async (lock) => {
      let rec = readRecord(ctx)
      if (!rec?.deviceCode) {
        if (rec?.refreshToken) return { done: { status: "connected", label: rec.label, scope: rec.scope } }
        throw new Fail("not_connected", "No connection is being made. Run: n8n-ops connect")
      }
      const t = now()
      if (rec.deviceExpiresAt <= t) {
        writeRecord(ctx, clearPending(rec))
        throw new Fail("expired", "The code expired before it was approved. Run: n8n-ops connect")
      }
      if (rec.nextPollAt > t) return { wait: rec.nextPollAt - t }
      assertMine(ctx, lock)
      let r
      try {
        r = await oauth(ctx, "/oauth/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: rec.deviceCode,
        })
      } catch (e) {
        if (e.code === "unreachable") {
          rec.nextPollAt = t + rec.interval
          writeRecord(ctx, rec)
        }
        throw e
      }
      if (r.status === 200) {
        const tokens = tokensFrom(r)
        // Connecting again (--replace): the old connection is ended once the new one is stored.
        const old = rec.refreshToken && rec.refreshToken !== tokens.refreshToken ? rec.refreshToken : ""
        rec = {
          ...clearPending(rec),
          ...tokens,
          generation: hex(8),
          refreshStartedAt: 0,
          refreshRetried: 0,
          toRevoke: [rec.toRevoke, old].filter(Boolean).join(" "),
        }
        writeRecord(ctx, rec)
        rec = await revokePending(ctx, rec)
        return { done: { status: "connected", label: rec.label, scope: rec.scope } }
      }
      const error = r.json?.error
      if (error === "authorization_pending" || error === "slow_down") {
        if (error === "slow_down") rec.interval += 5
        rec.nextPollAt = t + rec.interval
        writeRecord(ctx, rec)
        return { wait: rec.interval }
      }
      if (error === "access_denied") {
        writeRecord(ctx, clearPending(rec))
        throw new Fail("denied", "The person did not approve the connection.")
      }
      if (error === "expired_token" || error === "invalid_grant") {
        writeRecord(ctx, clearPending(rec))
        throw new Fail("expired", "The code is no longer valid. Run: n8n-ops connect")
      }
      throw httpFail(r, "Waiting for the approval")
    })
    if (step.done) return print(step.done)
    if (Date.now() + step.wait * 1000 > until)
      return print({ status: "still_waiting", next: "Not approved yet. Run again: n8n-ops connect --wait" })
    await sleep(step.wait * 1000)
  }
}

const usable = (rec) => rec.accessToken && rec.accessExpiresAt - now() > 60 && !rec.refreshStartedAt

/** A live access token: the stored one while it lasts, else one refresh under the lock. */
async function accessToken(ctx, stale) {
  const first = readRecord(ctx)
  if (!first?.refreshToken) throw new Fail("not_connected", "Not connected. Run: n8n-ops connect")
  if (!stale && usable(first)) return first.accessToken
  return withLock(ctx, async (lock) => {
    let rec = readRecord(ctx)
    if (!rec?.refreshToken) throw new Fail("not_connected", "Not connected. Run: n8n-ops connect")
    rec = await revokePending(ctx, rec)
    // Another command refreshed while this one waited for the lock.
    if (usable(rec) && rec.accessToken !== stale) return rec.accessToken
    const before = { refreshStartedAt: rec.refreshStartedAt, refreshRetried: rec.refreshRetried }
    // A refresh that started moments ago may still be on its way (its holder lost the lock): never send it twice.
    if (rec.refreshStartedAt && now() - rec.refreshStartedAt < REFRESH_GRACE)
      throw new Fail("busy", "Another n8n-ops command is refreshing this connection. Nothing was sent; run it again.")
    if (rec.refreshStartedAt) {
      // The last refresh got no answer; it may or may not have reached n8n-ops. Trying once more either continues
      // the connection or ends it there, which also ends the new token nobody received.
      if (rec.refreshRetried)
        throw new Fail(
          "connection_ended",
          "Two refreshes got no answer, so this connection cannot be trusted. Run: n8n-ops connect --replace",
        )
      rec.refreshRetried = 1
    }
    rec.refreshStartedAt = now()
    writeRecord(ctx, rec)
    assertMine(ctx, lock)
    await hook("before-refresh")
    let r
    try {
      r = await oauth(ctx, "/oauth/token", { grant_type: "refresh_token", refresh_token: rec.refreshToken })
    } catch (e) {
      // Nothing left the computer: the token is as good as before.
      if (e.code === "unreachable" && e.extra.sent === false) writeRecord(ctx, { ...rec, ...before })
      throw e
    }
    if (r.status === 200) {
      const next = { ...rec, ...tokensFrom(r), refreshStartedAt: 0, refreshRetried: 0 }
      await hook("before-write")
      if (!mine(ctx, lock)) {
        // The lock was taken while this one waited for n8n-ops: keep the new tokens anyway, under a fresh lock.
        await withLock(ctx, async () => writeRecord(ctx, next), lock)
      } else writeRecord(ctx, next)
      return next.accessToken
    }
    if (r.json?.error === "invalid_grant") {
      // An old connection still to be ended (after --replace) keeps its place until n8n-ops confirms it.
      if (rec.toRevoke) writeRecord(ctx, { ...emptyRecord(ctx), label: rec.label, toRevoke: rec.toRevoke })
      else removeRecord(ctx)
      throw new Fail(
        "connection_ended",
        "This connection has ended (disconnected in n8n-ops, unused for 90 days, or its token was used twice). Run: n8n-ops connect",
      )
    }
    // n8n-ops answered with an error before spending the token (a 4xx); a 5xx may have come after.
    if (r.status < 500) writeRecord(ctx, { ...rec, ...before })
    throw httpFail(r, "Refreshing the connection")
  })
}

function apiUrl(ctx, p) {
  const value = String(p ?? "")
  const bad = "Give a path of the API, for example: problems?status=open (percent-encode anything else)"
  // The same characters in every version (the shell version passes the path to curl as it is).
  // Encoded dots too: a server or proxy that decodes them would take the token out of the API.
  if (!PATH_CHARS.test(value) || value.includes("://") || value.startsWith("//") || /%2e/i.test(value))
    throw new Fail("bad_path", bad)
  const url = new URL(`${ctx.issuer}/api/v1${value.startsWith("/") ? "" : "/"}${value}`)
  if (url.origin !== ctx.issuer || !url.pathname.startsWith("/api/v1/")) throw new Fail("bad_path", bad)
  return url.toString()
}

async function api(ctx, method, p, json) {
  const url = apiUrl(ctx, p)
  if (json !== undefined) {
    try {
      JSON.parse(json)
    } catch {
      throw new Fail("bad_body", "The body is not JSON.")
    }
  }
  let token = await accessToken(ctx)
  let r = await request(ctx, method, url, { bearer: token, json })
  if (r.status === 401) {
    token = await accessToken(ctx, token)
    r = await request(ctx, method, url, { bearer: token, json })
  }
  if (r.status >= 200 && r.status < 300) {
    process.stdout.write(r.text.endsWith("\n") ? r.text : `${r.text}\n`)
    return
  }
  if (r.status === 403 && r.json?.error === "not_allowed")
    throw new Fail(
      "insufficient_scope",
      "This agent was connected without instance access. Ask the person, then run: n8n-ops connect --replace",
    )
  throw httpFail(r, `${method} ${p}`)
}

async function disconnect(ctx) {
  const result = await withLock(ctx, async (lock) => {
    const rec = readRecord(ctx)
    if (!rec) return { status: "not_connected" }
    assertMine(ctx, lock)
    const tokens = [rec.refreshToken, ...rec.toRevoke.split(" ")].filter(Boolean)
    const left = []
    for (const token of tokens) {
      const r = await oauth(ctx, "/oauth/revoke", { token, token_type_hint: "refresh_token" }).catch(() => null)
      if (r?.status !== 200) left.push(token)
    }
    if (left.length) {
      writeRecord(ctx, { ...rec, refreshToken: "", accessToken: "", accessExpiresAt: 0, toRevoke: left.join(" ") })
      throw new Fail(
        "disconnect_failed",
        "n8n-ops did not confirm the disconnect. Run it again, or disconnect this agent in n8n-ops Settings.",
      )
    }
    removeRecord(ctx)
    return { status: "disconnected" }
  })
  print(result)
}

main().catch((e) => {
  if (e instanceof Fail) {
    print({ error: e.code, message: e.message, ...(e.extra.body !== undefined ? { body: e.extra.body } : {}) })
  } else {
    print({ error: "failed", message: String(e?.message ?? e) })
  }
  process.exitCode = 1
})
