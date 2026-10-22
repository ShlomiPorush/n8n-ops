import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CreateBucketCommand, GetObjectRetentionCommand, S3Client } from "@aws-sdk/client-s3"
import { afterAll, describe, expect, it } from "vitest"
import { s3Store } from "./s3.ts"
import { fetchHostKey, sftpStore } from "./sftp.ts"
import { type Store, verifyByReading } from "./store.ts"
import { webdavStore } from "./webdav.ts"

// Each store against a real server of its kind in the verification stack: S3Mock, OpenSSH and rclone's WebDAV
// server over HTTPS. scripts/verify.sh starts them and passes where they are.
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required (scripts/verify.sh sets it)`)
  return value
}

const work = mkdtempSync(join(tmpdir(), "n8n-ops-stores-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** A file of random bytes and what a copy of it must match. */
function archive(size: number) {
  const bytes = randomBytes(size)
  const file = join(work, `${randomBytes(4).toString("hex")}.age`)
  writeFileSync(file, bytes)
  return { file, expected: { size, sha256: createHash("sha256").update(bytes).digest("base64") } }
}

const signal = () => AbortSignal.timeout(60_000)

/** The test servers start with the stack; this waits until one answers. */
async function whenUp<T>(fn: () => Promise<T>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (Date.now() > until) throw error
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
}

/** What every store must do, whatever its kind. */
function contract(name: string, open: () => Store) {
  describe(`${name}: the store contract`, () => {
    it("writes an archive into new folders, verifies it, reads it back whole and removes it", async () => {
      const store = open()
      try {
        const { file, expected } = archive(3 * 1024 * 1024 + 17)
        const key = store.key(["inst", "2026", "10", `inst-${Date.now()}.tar.gz.age`])
        const put = await store.put(key, file, expected, signal())
        await store.verify(key, expected, signal(), put.versionId)
        await verifyByReading(store, key, expected, signal(), put.versionId)
        await store.remove(key, signal(), put.versionId)
        await expect(verifyByReading(store, key, expected, signal(), put.versionId)).rejects.toThrow()
        // Removing what is already gone is not an error.
        await store.remove(key, signal(), put.versionId)
      } finally {
        await store.close()
      }
    })

    it("writes a second archive into a folder that exists", async () => {
      const store = open()
      try {
        const a = archive(1000)
        const b = archive(2000)
        const folder = ["inst", "same", String(Date.now())]
        const ka = store.key([...folder, "a.age"])
        const kb = store.key([...folder, "b.age"])
        const pa = await store.put(ka, a.file, a.expected, signal())
        const pb = await store.put(kb, b.file, b.expected, signal())
        await store.verify(kb, b.expected, signal(), pb.versionId)
        await store.remove(ka, signal(), pa.versionId)
        await store.remove(kb, signal(), pb.versionId)
      } finally {
        await store.close()
      }
    })

    it("notices a copy whose content differs at the same size", async () => {
      const store = open()
      try {
        const real = archive(4096)
        const other = archive(4096)
        const key = store.key(["inst", `corrupt-${Date.now()}.age`])
        // The other bytes are stored under the key, and checked against the archive's checksum.
        const put = await store.put(key, other.file, other.expected, signal())
        await expect(store.verify(key, real.expected, signal(), put.versionId)).rejects.toThrow(/checksum/)
        await store.remove(key, signal(), put.versionId)
      } finally {
        await store.close()
      }
    })

    it("passes its own test", async () => {
      const store = open()
      try {
        await store.test(signal())
      } finally {
        await store.close()
      }
    })
  })
}

// ---------------------------------------------------------------------------

const s3Location = (bucket: string) => ({
  endpoint: env("S3_ENDPOINT"),
  region: "us-east-1",
  bucket,
  prefix: "it",
  forcePathStyle: true,
})
const s3Credentials = { accessKeyId: "test", secretAccessKey: "test-secret" }

contract("S3", () => s3Store(s3Location("n8n-ops-backups"), s3Credentials, null))

describe("S3 Object Lock", () => {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: env("S3_ENDPOINT"),
    forcePathStyle: true,
    credentials: s3Credentials,
  })
  afterAll(() => client.destroy())

  it("is refused by the test on a bucket without Object Lock", async () => {
    const store = s3Store(s3Location("n8n-ops-backups"), s3Credentials, { mode: "COMPLIANCE", days: 30 })
    await expect(store.test(signal())).rejects.toThrow(/Object Lock is not enabled/)
    await store.close()
  })

  it("locks each copy until its retain-until date on a bucket with Object Lock", async () => {
    const bucket = `locked-${Date.now()}`
    await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }))
    const store = s3Store(s3Location(bucket), s3Credentials, { mode: "COMPLIANCE", days: 30 })
    try {
      await store.test(signal())
      const { file, expected } = archive(2048)
      const until = new Date(Date.now() + 30 * 86_400_000)
      const key = store.key(["inst", "locked.age"])
      const put = await store.put(key, file, expected, signal(), until)
      await store.verify(key, expected, signal(), put.versionId)
      const retention = await client.send(
        new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: put.versionId }),
      )
      expect(retention.Retention?.Mode).toBe("COMPLIANCE")
      expect(retention.Retention?.RetainUntilDate?.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    } finally {
      await store.close()
    }
  })
})

// ---------------------------------------------------------------------------

const sftpLocation = {
  host: env("SFTP_HOST"),
  port: Number(env("SFTP_PORT")),
  username: env("SFTP_USER"),
  path: env("SFTP_PATH"),
}
const hostKey = await whenUp(() => fetchHostKey(sftpLocation.host, sftpLocation.port, AbortSignal.timeout(10_000)))
// The SFTP user exists a moment after the SSH port opens.
await whenUp(async () => {
  const store = sftpStore(sftpLocation, { password: env("SFTP_PASSWORD"), hostKey })
  try {
    await store.test(signal())
  } finally {
    await store.close()
  }
})

describe("SFTP host key", () => {
  it("is read in OpenSSH's SHA256 form before any credential is sent", () => {
    expect(hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it("must match the pinned key, or nothing is sent", async () => {
    const store = sftpStore(sftpLocation, {
      password: env("SFTP_PASSWORD"),
      hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })
    await expect(store.test(signal())).rejects.toThrow(/host key is SHA256:/)
    await store.close()
  })

  it("refuses a wrong password", async () => {
    const store = sftpStore(sftpLocation, { password: "wrong", hostKey })
    await expect(store.test(signal())).rejects.toThrow()
    await store.close()
  })
})

contract("SFTP", () => sftpStore(sftpLocation, { password: env("SFTP_PASSWORD"), hostKey }))

// ---------------------------------------------------------------------------

const ca = readFileSync(env("WEBDAV_CA"))
const webdav = (password = env("WEBDAV_PASSWORD")) =>
  webdavStore({ url: env("WEBDAV_URL"), username: env("WEBDAV_USER") }, { password }, { agentOptions: { ca } })

await whenUp(async () => {
  const store = webdav()
  await store.test(signal())
})

describe("WebDAV", () => {
  it("only takes HTTPS", () => {
    expect(() => webdavStore({ url: "http://webdav:8080/", username: "u" }, { password: "p" })).toThrow(/https/)
  })

  it("says when the password is wrong", async () => {
    const store = webdav("wrong")
    await expect(store.test(signal())).rejects.toThrow(/refused the user name or password/)
  })
})

contract("WebDAV", () => webdav())
