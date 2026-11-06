import { randomBytes } from "node:crypto"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { describe, expect, it } from "vitest"
import { openArchive, sealArchive } from "./archive.ts"
import { entryText, textEntry } from "./tar.ts"

describe("backup archives", () => {
  it("round-trip with the key pair and hide the content", async () => {
    const identity = await generateX25519Identity()
    const recipient = await identityToRecipient(identity)
    const password = randomBytes(12).toString("hex")
    const sealed = await sealArchive(
      [textEntry("credentials/1.json", JSON.stringify({ data: { password } }))],
      recipient,
    )
    expect(Buffer.from(sealed.bytes).toString("latin1")).not.toContain(password)
    expect(sealed.size).toBe(sealed.bytes.length)
    const entries = await openArchive(sealed.bytes, identity)
    expect(entryText(entries[0] as never)).toContain(password)
  })

  it("that unpack beyond the limit fail instead of filling the memory", async () => {
    const identity = await generateX25519Identity()
    const sealed = await sealArchive([textEntry("big.json", "x".repeat(200_000))], await identityToRecipient(identity))
    // Compressed it is tiny; unpacked it is far over the limit.
    expect(sealed.size).toBeLessThan(10_000)
    await expect(openArchive(sealed.bytes, identity, 50_000)).rejects.toThrow()
    expect(await openArchive(sealed.bytes, identity, 1_000_000)).toHaveLength(1)
  })

  it("cannot be opened with another key", async () => {
    const sealed = await sealArchive([textEntry("a", "b")], await identityToRecipient(await generateX25519Identity()))
    await expect(openArchive(sealed.bytes, await generateX25519Identity())).rejects.toThrow()
  })
})
