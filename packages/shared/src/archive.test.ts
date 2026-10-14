import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { describe, expect, it } from "vitest"
import { openArchive, sealArchive } from "./archive.ts"
import { entryText, textEntry } from "./tar.ts"

describe("backup archives", () => {
  it("round-trip with the key pair and hide the content", async () => {
    const identity = await generateX25519Identity()
    const recipient = await identityToRecipient(identity)
    const sealed = await sealArchive([textEntry("credentials/1.json", '{"data":{"password":"hunter2"}}')], recipient)
    expect(Buffer.from(sealed.bytes).toString("latin1")).not.toContain("hunter2")
    expect(sealed.size).toBe(sealed.bytes.length)
    const entries = await openArchive(sealed.bytes, identity)
    expect(entryText(entries[0] as never)).toContain("hunter2")
  })

  it("cannot be opened with another key", async () => {
    const sealed = await sealArchive([textEntry("a", "b")], await identityToRecipient(await generateX25519Identity()))
    await expect(openArchive(sealed.bytes, await generateX25519Identity())).rejects.toThrow()
  })
})
