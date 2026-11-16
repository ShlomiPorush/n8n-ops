import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Pairing } from "./pairing.ts"

/** Pairing tokens and the identity the stand-in server answers with, new for each run. */
const made = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`
const tokenA = made("nops_pair_")
const tokenB = made("nops_pair_")
const usedToken = made("nops_pair_")
const newToken = made("nops_pair_")
const identity = made("nops_worker_")

const paired = () =>
  new Response(JSON.stringify({ identity, workerId: "w1", name: "host-a" }), { status: 200 })
const refused = () =>
  new Response(JSON.stringify({ error: "invalid_token", message: "The pairing token is wrong, used or expired." }), {
    status: 401,
  })

/** A pairing against a stand-in server, with the tokens it was sent and the messages it logged. */
async function setup(answers: (() => Response)[], dir?: string) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "pair-")))
  const sent: string[] = []
  const logged: string[] = []
  const pairing = new Pairing({
    dataDir,
    identityFile: join(dataDir, "identity.json"),
    request: async (token) => {
      sent.push(token)
      const answer = answers.shift()
      if (!answer) throw new Error("no answer left")
      return answer()
    },
    log: (msg) => logged.push(msg),
  })
  return { pairing, sent, logged, dataDir }
}

describe("Pairing", () => {
  it("pairs and saves the identity", async () => {
    const { pairing, sent, logged, dataDir } = await setup([paired])
    expect(await pairing.attempt(tokenA)).toBe(identity)
    expect(sent).toEqual([tokenA])
    expect(logged).toEqual(["paired"])
    expect(JSON.parse(await readFile(join(dataDir, "identity.json"), "utf8"))).toMatchObject({ workerId: "w1" })
  })

  it("does nothing without a token", async () => {
    const { pairing, sent, logged } = await setup([])
    expect(await pairing.attempt(null)).toBeNull()
    expect(sent).toEqual([])
    expect(logged).toEqual([])
  })

  it("keeps the token while the data folder cannot be written, says so once, and pairs once it can", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "pair-")), "data")
    const { pairing, sent, logged } = await setup([paired], dir)
    for (let i = 0; i < 3; i++) expect(await pairing.attempt(tokenA)).toBeNull()
    expect(sent).toEqual([])
    expect(logged).toEqual(["not pairing yet; the pairing token is kept"])
    await mkdir(dir)
    expect(await pairing.attempt(tokenA)).toBe(identity)
    expect(sent).toEqual([tokenA])
  })

  it("does not send a refused token again, and says so once", async () => {
    const { pairing, sent, logged } = await setup([refused, paired])
    for (let i = 0; i < 3; i++) expect(await pairing.attempt(usedToken)).toBeNull()
    expect(sent).toEqual([usedToken])
    expect(logged).toEqual([
      "pairing failed",
      "not pairing: this pairing token was already used, is wrong or expired; create a new one",
    ])
    expect(await pairing.attempt(newToken)).toBe(identity)
    expect(sent).toEqual([usedToken, newToken])
  })

  it("tries again after a server error", async () => {
    const { pairing, sent } = await setup([() => new Response("down", { status: 503 }), paired])
    expect(await pairing.attempt(tokenA)).toBeNull()
    expect(await pairing.attempt(tokenA)).toBe(identity)
    expect(sent).toEqual([tokenA, tokenA])
  })

  it("remembers every refused token, not only the last one", async () => {
    const { pairing, sent } = await setup([refused, refused])
    await pairing.attempt(tokenA)
    await pairing.attempt(tokenB)
    await pairing.attempt(tokenA)
    expect(sent).toEqual([tokenA, tokenB])
  })

  it("does not send the token again when the server said yes but the answer was cut off", async () => {
    const cut = () => new Response('{"identity":"nops_wor', { status: 200 })
    const { pairing, sent } = await setup([cut])
    await expect(pairing.attempt(tokenA)).rejects.toThrow()
    expect(await pairing.attempt(tokenA)).toBeNull()
    expect(sent).toEqual([tokenA])
  })

  it("when the identity cannot be saved after pairing, says so and does not send the spent token again", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pair-"))
    const sent: string[] = []
    const logged: string[] = []
    const pairing = new Pairing({
      dataDir,
      // The folder passes the check, but the file cannot be written: the window between check and save.
      identityFile: join(dataDir, "missing", "identity.json"),
      request: async (token) => {
        sent.push(token)
        return paired()
      },
      log: (msg) => logged.push(msg),
    })
    for (let i = 0; i < 3; i++) expect(await pairing.attempt(tokenA)).toBeNull()
    expect(sent).toEqual([tokenA])
    expect(logged).toEqual([
      "paired, but the identity could not be saved; revoke this worker and create a new pairing token",
      "not pairing: this pairing token was already used, is wrong or expired; create a new one",
    ])
  })

  it("after a revocation, does not send the token it paired with again", async () => {
    const { pairing, sent, logged } = await setup([paired])
    expect(await pairing.attempt(tokenA)).toBe(identity)
    expect(await pairing.attempt(tokenA)).toBeNull()
    expect(sent).toEqual([tokenA])
    expect(logged.at(-1)).toBe(
      "not pairing: this pairing token was already used, is wrong or expired; create a new one",
    )
  })
})
