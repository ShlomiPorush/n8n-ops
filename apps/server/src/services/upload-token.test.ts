import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createSecrets } from "../lib/crypto.ts"
import { readUpload, signUpload, UPLOAD_TOKEN_TTL_MS } from "./upload-token.ts"

const secrets = createSecrets(randomBytes(32))
const grant = { job: "j", worker: "w", run: "r", size: 10, sha256: "abc" }

describe("upload tokens", () => {
  it("carry the grant they were signed for, until they expire", () => {
    const token = signUpload(secrets, grant, 1_000)
    expect(readUpload(secrets, token, 1_000)).toEqual({ ...grant, expires: 1_000 + UPLOAD_TOKEN_TTL_MS })
    expect(readUpload(secrets, token, 1_000 + UPLOAD_TOKEN_TTL_MS + 1)).toBeNull()
  })

  it("are refused when changed or signed with another key", () => {
    const token = signUpload(secrets, grant)
    const [body, mac] = token.slice("nops_upload_".length).split(".")
    const bigger = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()), size: 99 }),
    ).toString("base64url")
    expect(readUpload(secrets, `nops_upload_${bigger}.${mac}`)).toBeNull()
    expect(readUpload(createSecrets(randomBytes(32)), token)).toBeNull()
    expect(readUpload(secrets, "nops_upload_x")).toBeNull()
    expect(readUpload(secrets, "")).toBeNull()
  })
})
