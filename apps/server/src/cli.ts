// Operator commands, run inside the server container:
//   node dist/cli.js reset-password
// Sets a new random password, turns two-factor off (it must be set up again at the next sign-in)
// and signs out every session.
import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { createAuth } from "./auth/auth.ts"
import { loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { account, session, twoFactor, user } from "./db/schema.ts"
import { createAudit } from "./lib/audit.ts"
import { loadOrCreateAppKey } from "./lib/crypto.ts"

const command = process.argv[2]
if (command !== "reset-password") {
  console.error("Usage: node dist/cli.js reset-password")
  process.exit(2)
}

const config = loadConfig()
const database = createDatabase(config.databaseUrl)
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

console.log(`Username: ${u.username ?? u.name}`)
console.log(`New password: ${password}`)
console.log(
  "Two-factor was turned off and must be set up again after signing in. Change the password in Settings > Account.",
)
await database.close()
