// Operator commands, run inside the server container:
//   node dist/cli.js reset-password
// Sets a new random password, turns two-factor off (it must be set up again at the next sign-in)
// and signs out every session. Every agent connection ends with it.
//   node dist/cli.js regroup-dry-run
// Applies the migrations, then shows how the recorded Problems would be regrouped by cause (docs/adr/0003) and
// changes nothing else: the regroup runs in a transaction that is rolled back. Meant for a copy of a database.
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { eq } from "drizzle-orm"
import { createAuth } from "./auth/auth.ts"
import { loadConfig } from "./config.ts"
import type { Ctx } from "./context.ts"
import { createDatabase } from "./db/client.ts"
import { account, session, twoFactor, user } from "./db/schema.ts"
import { createAudit } from "./lib/audit.ts"
import { loadOrCreateAppKey } from "./lib/crypto.ts"
import { beginIdentityReset, finishIdentityReset } from "./oauth/agents.ts"
import { regroupByCause } from "./services/regroup.ts"

const command = process.argv[2]
if (command !== "reset-password" && command !== "regroup-dry-run") {
  console.error("Usage: node dist/cli.js reset-password | regroup-dry-run")
  process.exit(2)
}

const config = loadConfig()
const database = createDatabase(config.databaseUrl)

if (command === "regroup-dry-run") {
  await database.migrate(config.migrationsDir)
  const report = await regroupByCause({ db: database.db, audit: createAudit(database.db) }, { dryRun: true })
  console.log(JSON.stringify(report, null, 2))
  await database.close()
  process.exit(0)
}
const { key } = await loadOrCreateAppKey(config.appKeyPath)
const auth = createAuth(database.db, key, config.publicUrl)
const db = database.db

const [u] = await db.select().from(user).limit(1)
if (!u) {
  console.error("No account exists yet. Open the web UI to create it.")
  process.exit(1)
}

// Whoever resets the account may not be the person who approved its agents: every connection ends before the reset,
// no approval is answered during it, and everything ends again after it (a run that stops halfway is finished by the
// next run, or by the server when it starts).
const agentCtx = { db, audit: createAudit(db), events: new EventEmitter() } as unknown as Ctx
const operator = { by: "operator", via: "cli" } as const
const reset = await beginIdentityReset(agentCtx, operator)

const password = randomBytes(18).toString("base64url")
const hash = await (await auth.$context).password.hash(password)
await db.update(account).set({ password: hash, updatedAt: new Date() }).where(eq(account.userId, u.id))
await db.delete(twoFactor).where(eq(twoFactor.userId, u.id))
await db.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, u.id))
await db.delete(session).where(eq(session.userId, u.id))
await createAudit(db)({
  actor: "operator",
  action: "Password reset from the server",
  target: u.username ?? u.name,
  via: "cli",
})

await finishIdentityReset(agentCtx, operator, [reset])

console.log(`Username: ${u.username ?? u.name}`)
console.log(`New password: ${password}`)
console.log(
  "Two-factor was turned off and must be set up again after signing in. Change the password on the Account page.",
)
await database.close()
