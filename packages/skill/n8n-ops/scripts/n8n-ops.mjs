#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/* ==== Product constants: the same values in all three versions and the entry point. ==== */
const PRODUCT = "n8n-ops"
const CMD = "n8n-ops"
// Environment variables are this prefix plus URL, CREDENTIALS, AGENT_NAME, NO_NODE, WAIT_SECONDS, LOCK_WAIT_MS.
const ENV_PREFIX = "N8N_OPS_"
// The credentials folder, in the user's home folder.
const CREDENTIALS_FOLDER = ".n8n-ops"
const CLIENT_ID = "n8n-ops-cli"
const SCOPE = "ops:read ops:access"
// The REST API as a resource (RFC 8707): the audience its access tokens are bound to.
const RESOURCE = "/api/v1"
// Every API call is under one of these prefixes, so the token goes only to the API.
const PREFIXES = ["/api/v1/"]
// A path template in the endpoints list: under PREFIXES, with {name} and {name:path} parts.
const TEMPLATE = /^\/api\/v1\/[A-Za-z0-9._~{}:/-]*$/
const ACCESS = "/api/v1/agent/access"
const ENDPOINTS = "/api/v1/agent/endpoints"
// The authorization server's device, token and revocation endpoints, after the address.
const DEVICE_PATH = "/oauth/device"
const TOKEN_PATH = "/oauth/token"
const REVOKE_PATH = "/oauth/revoke"
const SKILL_HEADER_NAME = "x-n8n-ops-skill"
const POLICY_HEADER_NAME = "x-n8n-ops-policy"
// The header that carries the kind (read or act) the client found for a call, with the policy revision.
const KIND_HEADER_NAME = "x-n8n-ops-kind"
const KINDS_MAGIC = "n8n-ops-kinds"
// Filled in with the address when the server serves this file.
const DEFAULT_URL = "__N8N_OPS_URL__"
// Filled in with the skill's version when the server serves this file; access then says when a newer one is out.
const SKILL_VERSION = "__N8N_OPS_SKILL_VERSION__"
// A copy that was not served (installed from Git) sends r<SKILL_REVISION> instead; raise it with the server's copy.
const SKILL_REVISION = 3
/* ==== End of product constants. ==== */

const env = (name) => process.env[`${ENV_PREFIX}${name}`]
const SKILL_HEADER = SKILL_VERSION.startsWith("__") ? `r${SKILL_REVISION}` : SKILL_VERSION
const WAIT_SECONDS = Number(env("WAIT_SECONDS")) || 90
const STALE_CODE_SECONDS = 600
const LOCK_WAIT_MS = Number(env("LOCK_WAIT_MS")) || 20_000
const OAUTH_TIMEOUT_MS = 15_000
const API_TIMEOUT_MS = Number(env("TEST_API_TIMEOUT_MS")) || 75_000
const POLL_SECONDS = Number(env("TEST_POLL_SECONDS")) || 5
const REFRESH_GRACE = Number(env("TEST_REFRESH_GRACE") ?? 30)
const BUSY_WAIT_MS = Number(env("TEST_BUSY_WAIT_MS") ?? 2000)
const KINDS_MAX_AGE = 3600
const KINDS_FORMAT = "2"
const SECRET = /^[A-Za-z0-9._~+/=-]{1,4096}$/
const REVISION = /^[A-Za-z0-9._-]{1,128}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const PLAIN = /^[^"\\\u0000-\u001f\u007f]*$/
const SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?$/
const ADDRESS = "address"
const PATH_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+$/
const UNKNOWN_OUTCOME = "The action may have run. Read its state before trying again."
const NOT_LISTED = `This connection has no such call. Take the path from \`${CMD} endpoints\`, with its {...} parts filled in; never guess it.`
const UNAVAILABLE = `The list of allowed calls could not be read from ${PRODUCT}, so nothing was sent. Try again in a moment.`
const NO_ACCESS_SCOPE = `This agent may not request access to n8n instances. Ask the person to allow it, then run: ${CMD} connect --replace`
const POLICY_CHANGED = `${PRODUCT}'s calls changed, or this path names a different call than the list says. Nothing ran. Run \`${CMD} endpoints\` and take the path from it.`
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
const system32 = (exe) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", exe)

const HELP = `${CMD}: use ${PRODUCT} after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to ${WAIT_SECONDS} s for the approval; run again while it answers still_waiting.
  access                What this connection may read or act on, and until when.
  endpoints [area]      The calls this connection may make, with their kind (read or act).
  get <path>            GET a path, for example: get '/api/v1/problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this computer user is connected (no secrets).
  disconnect            End this computer user's connection.

  --url <address>       The ${PRODUCT} address (or ${ENV_PREFIX}URL). Kept once connected, for the commands after.`

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
    throw new Fail("node_too_old", `Node 20 or later is needed. Use ${CMD}.ps1 or ${CMD}.sh instead.`)
  const ctx = context(opts.url)
  const first = opts.positional[0]
  if (command === "status") return status(ctx)
  if (command === "connect") return opts.wait ? waitForApproval(ctx) : connect(ctx, Boolean(opts.replace))
  if (command === "access") return api(ctx, "GET", ACCESS)
  if (command === "endpoints") {
    if (first !== undefined && !/^[a-z_]{1,40}$/.test(first))
      throw new Fail("bad_path", "Give an area name, for example: read")
    return api(ctx, "GET", first === undefined ? ENDPOINTS : `${ENDPOINTS}?area=${first}`)
  }
  if (command === "get") return api(ctx, "GET", first)
  if (command === "post") return api(ctx, "POST", first, body(opts, "{}"))
  if (command === "disconnect") return disconnect(ctx)
  throw new Fail("unknown_command", `Unknown command "${command}". Run: ${CMD} help`)
}

function body(opts, fallback) {
  if (opts.jsonFile !== undefined) {
    try {
      return fs.readFileSync(opts.jsonFile, "utf8")
    } catch {
      throw new Fail("bad_body", `Cannot read ${opts.jsonFile}.`)
    }
  }
  return opts.json ?? fallback
}

function context(urlOption) {
  const dir = credentialsDir()
  let raw = urlOption || env("URL") || (DEFAULT_URL.startsWith("__") ? "" : DEFAULT_URL)
  const kept = raw ? "" : keptAddress(dir)
  raw ||= kept
  if (!raw)
    throw new Fail("no_url", `No ${PRODUCT} address. Ask the person for it, then run: ${CMD} connect --url "<address>"`)
  let issuer
  try {
    if (kept && /\s/.test(kept)) throw new Fail("insecure_url", "")
    issuer = issuerOf(raw)
  } catch (e) {
    if (!kept) throw e
    throw new Fail("no_url", `The address kept in ${path.join(dir, ADDRESS)} is not valid. Pass --url "<address>".`)
  }
  const key = createHash("sha256").update(issuer).digest("hex").slice(0, 32)
  return {
    issuer,
    dir,
    file: path.join(dir, `${key}.json`),
    lock: path.join(dir, `${key}.lock`),
    kinds: path.join(dir, `${key}.kinds`),
    label: label(),
  }
}

function issuerOf(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Fail("insecure_url", `"${raw}" is not an address.`)
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Fail("insecure_url", "The address must start with https:// (http only for this computer).")
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Fail("insecure_url", "Use the address alone, for example https://n8n-ops.example.com.")
  if (!SAFE_ORIGIN.test(url.origin))
    throw new Fail("insecure_url", "Use the address alone, for example https://n8n-ops.example.com.")
  return url.origin
}

function keptAddress(dir) {
  const file = path.join(dir, ADDRESS)
  try {
    checkFile(file)
    return fs.readFileSync(file, "utf8").replace(/[\r\n]+$/, "")
  } catch (e) {
    if (e.code === "ENOENT") return ""
    throw e
  }
}

function keepAddress(ctx) {
  try {
    if (keptAddress(ctx.dir) === ctx.issuer) return
    writePrivate(ctx, path.join(ctx.dir, ADDRESS), `${ctx.issuer}\n`)
  } catch {}
}

function label() {
  if (env("AGENT_NAME")) return env("AGENT_NAME").slice(0, 60)
  return `Agents on ${host()}`.slice(0, 60)
}

function credentialsDir() {
  const override = env("CREDENTIALS")
  if (win) {
    const home = path.resolve(process.env.USERPROFILE || os.homedir())
    const dir = path.resolve(override || path.join(home, CREDENTIALS_FOLDER))
    const lowerHome = home.toLowerCase()
    const lower = dir.toLowerCase()
    if (lower !== lowerHome && !lower.startsWith(`${lowerHome}\\`))
      throw new Fail("insecure_credentials", `Keep the ${CMD} folder inside your user profile (${home}), not ${dir}.`)
    return dir
  }
  return path.resolve(override || path.join(os.homedir(), CREDENTIALS_FOLDER))
}

let secured = false
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
    try {
      const sid = userSid()
      execFileSync(
        system32("icacls.exe"),
        [
          dir,
          "/inheritance:r",
          "/grant:r",
          `*${sid}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
          "/Q",
        ],
        { stdio: "ignore" },
      )
      icacls([dir, "/setowner", `*${sid}`, "/T", "/Q"])
      assertOnlyUser(dir, sid)
    } catch (e) {
      if (e instanceof Fail) throw e
      throw new Fail("insecure_credentials", `Could not limit ${dir} to your user (icacls failed).`)
    }
  } else assertOwnMode(dir, st)
  secured = true
}

let checked = false
function checkDir(dir) {
  if (secured || checked) return
  const st = fs.lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Fail("insecure_credentials", `${dir} must be a plain folder, not a link.`)
  if (win) {
    try {
      assertOnlyUser(dir, userSid())
    } catch (e) {
      if (e instanceof Fail) throw e
      throw new Fail("insecure_credentials", `Could not check who can open ${dir} (icacls failed).`)
    }
  } else assertOwnMode(dir, st)
  checked = true
}

function userSid() {
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(
    execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).toString().trim(),
  )
  if (!sid) throw new Error("no SID")
  return sid[1]
}

function assertOnlyUser(dir, sid) {
  const saved = path.join(dir, `.acl-${hex(4)}`)
  try {
    icacls([dir, "/save", saved, "/T", "/Q"])
    const other = othersAllowed(fs.readFileSync(saved).toString("utf16le"), sid)
    if (other) throw new Fail("insecure_credentials", `Others can open ${dir} (${other}). Remove their access.`)
  } finally {
    fs.rmSync(saved, { force: true })
  }
}

function assertOwnMode(dir, st) {
  if (st.uid !== process.getuid())
    throw new Fail("insecure_credentials", `${dir} belongs to another user. Use a folder of your own.`)
  if (st.mode & 0o077) throw new Fail("insecure_credentials", `Others can open ${dir}. Run: chmod 700 '${dir}'`)
}

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

function othersAllowed(saved, userSid) {
  const allowed = new Set([userSid, "SY", "BA", "S-1-5-18", "S-1-5-32-544"])
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
    checkDir(ctx.dir)
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
    if (!PLAIN.test(value)) throw new Fail("unexpected_answer", `${PRODUCT} sent a value that cannot be stored (${k}).`)
    return `"${k}":"${value}"`
  })
  return `{${parts.join(",")}}\n`
}

function writePrivate(ctx, file, text) {
  secureDir(ctx.dir)
  const tmp = `${file}.${hex(6)}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, "wx", 0o600)
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } catch (e) {
    if (e instanceof Fail) throw e
    throw new Fail("cannot_save", `Cannot write in ${ctx.dir}. Allow this agent to write there.`)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  renameOver(tmp, file)
}

const writeRecord = (ctx, rec) => writePrivate(ctx, ctx.file, serialize(rec))

function renameOver(from, to) {
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
  fs.rmSync(ctx.kinds, { force: true })
}

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
    // EPERM as alive outside Windows would keep a dead holder's lock while another user's process has its number.
    return win && e.code === "EPERM"
  }
}

async function hook(point) {
  const at = env(`TEST_HOLD_${point.toUpperCase().replace(/-/g, "_")}`)
  if (!at) return
  fs.writeFileSync(`${at}.reached`, String(process.pid))
  for (let i = 0; i < 1200 && !fs.existsSync(`${at}.go`); i++) await sleep(50)
}

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
      const deleting = win && (e.code === "EPERM" || e.code === "EACCES") && Date.now() < deadline
      if (deleting) {
        await sleep(50 + Math.random() * 100)
        continue
      }
      if (e.code !== "EEXIST") throw new Fail("cannot_save", `Cannot create a lock in ${ctx.dir}.`)
    }
    const held = readLock(ctx.lock)
    if (own && held && !held.empty && held.token === own) return own
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
          ? `Another ${CMD} command has held ${ctx.lock} for over 10 minutes. If none is running, delete that file.`
          : `Another ${CMD} command is using this connection. Nothing was sent; run it again.`,
      )
    }
    await hook("lock-busy")
    await sleep(100 + Math.random() * 200)
  }
}

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
  } catch {}
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

function assertMine(ctx, token) {
  if (!mine(ctx, token)) throw new Fail("busy", `Another ${CMD} command took over this connection. Run it again.`)
}

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

async function request(ctx, method, url, { form, bearer, json, policy, kind, timeout = OAUTH_TIMEOUT_MS } = {}) {
  const headers = { accept: "application/json" }
  let payload
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    payload = new URLSearchParams(form).toString()
  } else if (json !== undefined) {
    headers["content-type"] = "application/json"
    payload = json
  }
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`
    headers[SKILL_HEADER_NAME] = SKILL_HEADER
  }
  if (policy) {
    headers[POLICY_HEADER_NAME] = policy
    headers[KIND_HEADER_NAME] = kind
  }
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    const code = e?.cause?.code ?? e?.code
    throw new Fail("unreachable", `Cannot reach ${ctx.issuer} (${code ?? e?.name ?? "network error"}).`, {
      sent: !NOT_SENT.has(code),
    })
  }
  let text
  try {
    text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer())
  } catch {
    throw new Fail("unreachable", `The answer from ${ctx.issuer} broke off.`, { sent: true })
  }
  let parsed = null
  let isJson = false
  try {
    parsed = JSON.parse(text)
    isJson = true
  } catch {}
  return { status: res.status, text, json: parsed, isJson, challenge: res.headers.get("www-authenticate") ?? "" }
}

const oauth = (ctx, p, form) => request(ctx, "POST", `${ctx.issuer}${p}`, { form: { ...form, client_id: CLIENT_ID } })

function httpFail(r, what) {
  const body = r.json !== null && typeof r.json === "object" ? r.json : null
  const detail =
    body?.error_description || body?.message || (typeof body?.detail === "string" ? body.detail : "") || body?.error
  return new Fail(`http_${r.status}`, `${what} failed (${r.status}${detail ? `: ${detail}` : ""}).`, { body })
}

function tokensFrom(r) {
  const t = r.json ?? {}
  const scope = typeof t.scope === "string" ? t.scope : ""
  const ok = (v) => typeof v === "string" && SECRET.test(v)
  if (!ok(t.access_token) || !ok(t.refresh_token) || !PLAIN.test(scope))
    throw new Fail("unexpected_answer", `${PRODUCT} answered without usable tokens.`)
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
    const r = await oauth(ctx, REVOKE_PATH, { token, token_type_hint: "refresh_token" }).catch(() => null)
    if (r?.status !== 200) left.push(token)
  }
  const next = { ...rec, toRevoke: left.join(" ") }
  if (next.toRevoke !== rec.toRevoke) writeRecord(ctx, next)
  return next
}

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
    throw new Fail(
      "unreachable",
      `${ctx.issuer} does not answer as ${PRODUCT} with agents allowed (${meta.status}). Check the address, and ask an administrator to allow agents in ${PRODUCT}'s settings.`,
    )

  const result = await withLock(ctx, async (lock) => {
    let rec = readRecord(ctx) ?? emptyRecord(ctx)
    rec = await revokePending(ctx, rec)
    if (rec.refreshToken && !replace) return { status: "already_connected", label: rec.label, scope: rec.scope }
    if (rec.deviceCode && rec.deviceExpiresAt - now() > 30 && !replace) return pending(ctx, rec)
    assertMine(ctx, lock)
    const r = await oauth(ctx, DEVICE_PATH, {
      scope: SCOPE,
      resource: `${ctx.issuer}${RESOURCE}`,
      client_label: ctx.label,
    })
    if (r.status !== 200) throw httpFail(r, "Asking to connect")
    const d = r.json ?? {}
    const link = String(d.verification_uri_complete ?? "")
    if (!SECRET.test(String(d.device_code)) || !/^[A-Z0-9-]{4,20}$/.test(String(d.user_code)) || !PLAIN.test(link))
      throw new Fail("unexpected_answer", `${PRODUCT} answered without a code.`)
    if (!link.startsWith(`${ctx.issuer}/`))
      throw new Fail("unexpected_answer", `The approval link is not on ${PRODUCT}.`)
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
    return pending(ctx, rec)
  })
  if (result.status === "already_connected") keepAddress(ctx)
  print(result)
}

function pending(ctx, rec) {
  return {
    status: "pending",
    link: rec.link,
    code: rec.userCode,
    expiresIn: Math.max(0, rec.deviceExpiresAt - now()),
    next: `End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: ${CMD} connect --wait --url "${ctx.issuer}"`,
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
        throw new Fail("not_connected", `No connection is being made. Run: ${CMD} connect`)
      }
      const t = now()
      if (rec.deviceExpiresAt + STALE_CODE_SECONDS <= t) {
        writeRecord(ctx, clearPending(rec))
        throw new Fail("expired", `The code expired before it was approved. Run: ${CMD} connect`)
      }
      if (rec.nextPollAt > t) return { wait: rec.nextPollAt - t }
      assertMine(ctx, lock)
      let r
      try {
        r = await oauth(ctx, TOKEN_PATH, {
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
        fs.rmSync(ctx.kinds, { force: true })
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
        throw new Fail("expired", `The code is no longer valid. Run: ${CMD} connect`)
      }
      throw httpFail(r, "Waiting for the approval")
    })
    if (step.done) {
      keepAddress(ctx)
      return print(step.done)
    }
    if (Date.now() + step.wait * 1000 > until)
      return print({
        status: "still_waiting",
        next: `Not approved yet. Run again: ${CMD} connect --wait --url "${ctx.issuer}"`,
      })
    await sleep(step.wait * 1000)
  }
}

const usable = (rec) => rec.accessToken && rec.accessExpiresAt - now() > 60 && !rec.refreshStartedAt

async function accessToken(ctx, stale) {
  const first = readRecord(ctx)
  if (!first?.refreshToken) throw new Fail("not_connected", `Not connected. Run: ${CMD} connect`)
  if (!stale && usable(first)) return first.accessToken
  return withLock(ctx, async (lock) => {
    let rec = readRecord(ctx)
    if (!rec?.refreshToken) throw new Fail("not_connected", `Not connected. Run: ${CMD} connect`)
    rec = await revokePending(ctx, rec)
    if (usable(rec) && rec.accessToken !== stale) return rec.accessToken
    const before = { refreshStartedAt: rec.refreshStartedAt, refreshRetried: rec.refreshRetried }
    if (rec.refreshStartedAt && now() - rec.refreshStartedAt < REFRESH_GRACE)
      throw new Fail("busy", `Another ${CMD} command is refreshing this connection. Nothing was sent; run it again.`)
    if (rec.refreshStartedAt) {
      if (rec.refreshRetried)
        throw new Fail(
          "connection_ended",
          `Two refreshes got no answer, so this connection cannot be trusted. Run: ${CMD} connect --replace`,
        )
      rec.refreshRetried = 1
    }
    rec.refreshStartedAt = now()
    writeRecord(ctx, rec)
    assertMine(ctx, lock)
    await hook("before-refresh")
    let r
    try {
      r = await oauth(ctx, TOKEN_PATH, {
        grant_type: "refresh_token",
        refresh_token: rec.refreshToken,
        resource: `${ctx.issuer}${RESOURCE}`,
      })
    } catch (e) {
      if (e.code === "unreachable" && e.extra.sent === false) writeRecord(ctx, { ...rec, ...before })
      throw e
    }
    if (r.status === 200) {
      const next = { ...rec, ...tokensFrom(r), refreshStartedAt: 0, refreshRetried: 0 }
      await hook("before-write")
      if (!mine(ctx, lock)) {
        await withLock(ctx, async () => writeRecord(ctx, next), lock)
      } else writeRecord(ctx, next)
      return next.accessToken
    }
    if (r.json?.error === "invalid_grant") {
      if (rec.toRevoke) writeRecord(ctx, { ...emptyRecord(ctx), label: rec.label, toRevoke: rec.toRevoke })
      else removeRecord(ctx)
      throw new Fail(
        "connection_ended",
        `This connection has ended (disconnected in ${PRODUCT}, its time ran out, sign-in settings changed, or its token was used twice). Run: ${CMD} connect`,
      )
    }
    if (r.status < 500) writeRecord(ctx, { ...rec, ...before })
    throw httpFail(r, "Refreshing the connection")
  })
}

function apiTarget(ctx, p) {
  const value = String(p ?? "")
  const bad = `Give a path from \`${CMD} endpoints\`, for example: get '/api/v1/problems?status=open' (percent-encode anything else)`
  if (!PATH_CHARS.test(value) || value.includes("://") || value.startsWith("//") || /%2e/i.test(value))
    throw new Fail("bad_path", bad)
  const pathOnly = value.split("?")[0]
  if (/%(?![0-9A-Fa-f]{2})|%(2[5DEF]|3[0-9A]|4[1-9A-F]|5[0-9ACF]|6[1-9A-F]|7[0-9AE])/i.test(pathOnly))
    throw new Fail("bad_path", bad)
  if (pathOnly.includes(";")) throw new Fail("bad_path", bad)
  if (!PREFIXES.some((x) => pathOnly.startsWith(x) && pathOnly.length > x.length)) throw new Fail("bad_path", bad)
  if (pathOnly.split("/").some((s) => s === "." || s === "..")) throw new Fail("bad_path", bad)
  const url = new URL(`${ctx.issuer}${value}`)
  if (url.origin !== ctx.issuer || url.pathname !== pathOnly) throw new Fail("bad_path", bad)
  return { url: url.toString(), path: url.pathname, hasQuery: value.includes("?") }
}

const exempt = (method, p) => method === "GET" && (p === ACCESS || p === ENDPOINTS)

function parseKinds(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.endpoints)) return null
  if (typeof data.revision !== "string" || !REVISION.test(data.revision)) return null
  const entries = []
  for (const e of data.endpoints) {
    const method = String(e?.method ?? "")
    const template = String(e?.path ?? "")
    const kind = e?.kind === "read" ? "read" : "act"
    if (/^[A-Z]{3,7}$/.test(method) && TEMPLATE.test(template)) entries.push({ method, template, kind })
  }
  return { revision: data.revision, entries }
}

function readKinds(ctx, rec) {
  let text
  try {
    text = fs.readFileSync(ctx.kinds, "utf8")
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const head = (lines.shift() ?? "").split(" ")
  if (head[0] !== KINDS_MAGIC || head[1] !== KINDS_FORMAT || !rec.generation || head[2] !== rec.generation) return null
  if (now() - Number(head[3] || 0) > KINDS_MAX_AGE) return null
  if (!REVISION.test(head[4] ?? "")) return null
  const entries = []
  for (const line of lines) {
    const [method, template, kind] = line.split(" ")
    if (/^[A-Z]{3,7}$/.test(method ?? "") && TEMPLATE.test(template ?? "") && (kind === "read" || kind === "act"))
      entries.push({ method, template, kind })
  }
  return { revision: head[4], entries }
}

function storeKinds(ctx, generation, list) {
  const rec = readRecord(ctx)
  if (!generation || rec?.generation !== generation) return
  const lines = [`${KINDS_MAGIC} ${KINDS_FORMAT} ${generation} ${now()} ${list.revision}`]
  for (const e of list.entries) lines.push(`${e.method} ${e.template} ${e.kind}`)
  try {
    writePrivate(ctx, ctx.kinds, `${lines.join("\n")}\n`)
  } catch {}
}

async function fetchKinds(ctx) {
  const generation = readRecord(ctx)?.generation ?? ""
  let r
  try {
    r = await send(ctx, "GET", `${ctx.issuer}${ENDPOINTS}`, undefined, { kind: "read", revision: "", both: false })
  } catch (e) {
    if (e.extra?.api) throw new Fail("endpoints_unavailable", UNAVAILABLE)
    throw e
  }
  const list = r.status === 200 ? parseKinds(r.json) : null
  if (!list) throw new Fail("endpoints_unavailable", UNAVAILABLE)
  storeKinds(ctx, generation, list)
  return list
}

function templateMatches(template, p) {
  const t = template.split("/")
  const s = p.split("/")
  for (let i = 0; i < t.length; i++) {
    if (/^\{[^}]*:path\}$/.test(t[i])) return i === t.length - 1 && s.length > i && s.slice(i).join("") !== ""
    if (i >= s.length) return false
    if (/^\{[^}]*\}$/.test(t[i])) {
      if (s[i] === "") return false
    } else if (t[i] !== s[i]) return false
  }
  return t.length === s.length
}

function lookup(list, method, p) {
  const hits = list.entries.filter((e) => e.method === method && templateMatches(e.template, p))
  const act = hits.some((e) => e.kind === "act")
  const read = hits.some((e) => e.kind !== "act")
  if (act && read) return "both"
  return act ? "act" : read ? "read" : null
}

async function classify(ctx, method, p) {
  if (exempt(method, p)) return { kind: "read", revision: "", path: p, both: false }
  const rec = readRecord(ctx)
  let list = rec?.refreshToken ? readKinds(ctx, rec) : null
  let fresh = false
  for (;;) {
    if (!list) {
      list = await fetchKinds(ctx)
      fresh = true
    }
    const kind = lookup(list, method, p)
    if (kind === "both") return { kind: "act", revision: list.revision, path: p, both: true }
    if (kind) return { kind, revision: list.revision, path: p, both: false }
    if (fresh) throw new Fail("bad_path", NOT_LISTED)
    list = null
  }
}

function topText(r, key) {
  const body = r.json
  if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, key)) return undefined
  return typeof body[key] === "string" ? body[key] : undefined
}

const tokenRefused = (r) => r.status === 401 && r.challenge.includes('error="invalid_token"')
const busyRefused = (r) => r.status === 429 && topText(r, "error") === "busy"
const policyRefused = (r) => r.status === 409 && topText(r, "error") === "policy_changed"

async function send(ctx, method, url, json, call) {
  let token = await accessToken(ctx)
  let refreshed = false
  let busyRetried = false
  let netRetried = false
  let policyRetried = false
  for (;;) {
    let r
    try {
      r = await request(ctx, method, url, {
        bearer: token,
        json,
        policy: call.revision,
        kind: call.kind,
        timeout: API_TIMEOUT_MS,
      })
    } catch (e) {
      if (e.code !== "unreachable") throw e
      e.extra.api = true
      if (call.kind === "act") {
        if (e.extra.sent === false) throw e
        throw new Fail("outcome_unknown", UNKNOWN_OUTCOME)
      }
      if (netRetried) throw e
      netRetried = true
      continue
    }
    if (tokenRefused(r) && !refreshed) {
      refreshed = true
      token = await accessToken(ctx, token)
      continue
    }
    if (busyRefused(r) && !busyRetried) {
      busyRetried = true
      await sleep(BUSY_WAIT_MS)
      continue
    }
    if (call.revision && policyRefused(r)) {
      if (policyRetried) throw new Fail("policy_changed", POLICY_CHANGED, { status: r.status })
      policyRetried = true
      const list = await fetchKinds(ctx)
      const kind = lookup(list, method, call.path)
      if (!kind) throw new Fail("bad_path", NOT_LISTED)
      call.kind = kind === "both" ? (call.both ? "read" : "act") : kind
      call.revision = list.revision
      continue
    }
    if (call.kind === "act" && r.status >= 500) throw new Fail("outcome_unknown", UNKNOWN_OUTCOME, { status: r.status })
    return r
  }
}

function dataText(r) {
  if (r.isJson) return r.text.replace(/[\r\n]/g, "").trim()
  return JSON.stringify(r.text)
}

const failedAnswer = (data) =>
  data !== null &&
  typeof data === "object" &&
  !Array.isArray(data) &&
  (data.success === false || data.status === "error")

async function api(ctx, method, p, json) {
  const target = apiTarget(ctx, p)
  if (json !== undefined) {
    try {
      JSON.parse(json)
    } catch {
      throw new Fail("bad_body", "The body is not JSON.")
    }
  }
  const listing = method === "GET" && target.path === ENDPOINTS && !target.hasQuery
  const generation = listing ? (readRecord(ctx)?.generation ?? "") : ""
  const call = await classify(ctx, method, target.path)
  const r = await send(ctx, method, target.url, json, call)
  if (r.status >= 200 && r.status < 300) {
    if (listing) {
      const list = parseKinds(r.json)
      if (list) storeKinds(ctx, generation, list)
    }
    const data = dataText(r)
    if (failedAnswer(r.json)) {
      process.stdout.write(
        `{"error":"failed","message":${JSON.stringify(`${method} ${p} answered that it failed.`)},"status":${r.status},"data":${data}}\n`,
      )
      process.exitCode = 1
      return
    }
    process.stdout.write(`{"status":${r.status},"data":${data}}\n`)
    return
  }
  if (r.status === 403 && topText(r, "error") === "not_allowed")
    throw new Fail("insufficient_scope", NO_ACCESS_SCOPE, { status: r.status })
  const body = r.json !== null && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null
  if (body && typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) && typeof body.message === "string")
    throw new Fail(body.error, body.message, { status: r.status })
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
      const r = await oauth(ctx, REVOKE_PATH, { token, token_type_hint: "refresh_token" }).catch(() => null)
      if (r?.status !== 200) left.push(token)
    }
    if (left.length) {
      writeRecord(ctx, { ...rec, refreshToken: "", accessToken: "", accessExpiresAt: 0, toRevoke: left.join(" ") })
      throw new Fail(
        "disconnect_failed",
        `${PRODUCT} did not confirm the disconnect. Run it again, or end the connection in ${PRODUCT}.`,
      )
    }
    removeRecord(ctx)
    return { status: "disconnected" }
  })
  print(result)
}

main().catch((e) => {
  if (e instanceof Fail) {
    print({
      error: e.code,
      message: e.message,
      ...(e.extra.status !== undefined ? { status: e.extra.status } : {}),
      ...(e.extra.body !== undefined && e.extra.body !== null ? { body: e.extra.body } : {}),
    })
  } else {
    print({ error: "failed", message: String(e?.message ?? e) })
  }
  process.exitCode = 1
})
