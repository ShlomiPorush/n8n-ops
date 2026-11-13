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
import { endEveryConnection } from "./oauth/agents.ts"
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

const password = randomBytes(18).toString("base64url")
const hash = await (await auth.$context).password.hash(password)
// Whoever resets the account may not be the person who approved its agents. The reset and the end of every agent
// connection are one transaction, under the gate approvals take too: none is answered in between, and a run that
// stops changes nothing.
const agentCtx = { db, audit: createAudit(db), events: new EventEmitter() } as unknown as Ctx
await endEveryConnection(agentCtx, "identity", { by: "operator", via: "cli" }, async (tx) => {
  await tx.update(account).set({ password: hash, updatedAt: new Date() }).where(eq(account.userId, u.id))
  await tx.delete(twoFactor).where(eq(twoFactor.userId, u.id))
  await tx.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, u.id))
  await tx.delete(session).where(eq(session.userId, u.id))
  await createAudit(db)(
    { actor: "operator", action: "Password reset from the server", target: u.username ?? u.name, via: "cli" },
    tx,
  )
})

console.log(`Username: ${u.username ?? u.name}`)
console.log(`New password: ${password}`)
console.log(
  "Two-factor was turned off and must be set up again after signing in. Change the password on the Account page.",
)
await database.close()
