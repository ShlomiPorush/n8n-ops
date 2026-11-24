import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import type { Readable } from "node:stream"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"
import type { ObjectLock } from "../../db/schema.ts"
import { type Expected, type PutResult, roundTrip, type Store, StoreError, verifyByReading } from "./store.ts"

export type S3Location = { endpoint: string; region: string; bucket: string; prefix: string; forcePathStyle: boolean }
export type S3Credentials = { accessKeyId: string; secretAccessKey: string }

export const S3_MAX_PUT = 5 * 1024 ** 3

async function md5OfFile(file: string, signal: AbortSignal) {
  const hash = createHash("md5")
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer)
  return hash.digest("base64")
}

const missing = (error: unknown) =>
  error instanceof S3ServiceException && (error.$metadata.httpStatusCode === 404 || error.name === "NoSuchKey")

export function s3Store(location: S3Location, credentials: S3Credentials, objectLock: ObjectLock | null): Store {
  const client = new S3Client({
    region: location.region || "us-east-1",
    ...(location.endpoint ? { endpoint: location.endpoint } : {}),
    forcePathStyle: location.forcePathStyle,
    credentials,
    // Many S3-compatible services refuse requests with the SDK's default checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  const Bucket = location.bucket

  async function putBody(
    key: string,
    body: Readable | Uint8Array,
    expected: Expected,
    signal: AbortSignal,
    lock?: { until: Date; md5: string },
  ): Promise<PutResult> {
    const res = await client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: body,
        ContentLength: expected.size,
        ContentType: "application/octet-stream",
        ChecksumSHA256: expected.sha256,
        ...(lock && objectLock
          ? { ObjectLockMode: objectLock.mode, ObjectLockRetainUntilDate: lock.until, ContentMD5: lock.md5 }
          : {}),
      }),
      { abortSignal: signal },
    )
    return res.VersionId ? { versionId: res.VersionId } : {}
  }

  async function ensureLocked(key: string, versionId: string | undefined, until: Date, signal: AbortSignal) {
    if (!objectLock) return
    const target = { Bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }
    const holds = async () => {
      try {
        const res = await client.send(new GetObjectRetentionCommand(target), { abortSignal: signal })
        const date = res.Retention?.RetainUntilDate
        return res.Retention?.Mode === objectLock.mode && Boolean(date && date.getTime() >= until.getTime() - 1000)
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode !== 403) return false
        throw error
      }
    }
    if (await holds()) return
    await client.send(
      new PutObjectRetentionCommand({ ...target, Retention: { Mode: objectLock.mode, RetainUntilDate: until } }),
      { abortSignal: signal },
    )
    if (!(await holds())) throw new StoreError("the service did not lock the archive with Object Lock")
  }

  const store: Store = {
    async put(key, file, expected, signal, retainUntil) {
      if (expected.size > S3_MAX_PUT) throw new StoreError("archives over 5 GiB cannot be written to S3 in one piece")
      // Many S3-compatible services refuse an Object Lock upload without Content-MD5.
      const lock = retainUntil && objectLock ? { until: retainUntil, md5: await md5OfFile(file, signal) } : undefined
      const put = await putBody(key, createReadStream(file, { signal }), expected, signal, lock)
      if (lock)
        await ensureLocked(key, put.versionId, lock.until, signal).catch((error: Error) => {
          throw Object.assign(error, { written: { versionId: put.versionId ?? null } })
        })
      return put
    },

    async verify(key, expected, signal, versionId) {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket,
          Key: key,
          ChecksumMode: "ENABLED",
          ...(versionId ? { VersionId: versionId } : {}),
        }),
        { abortSignal: signal },
      )
      if (head.ContentLength !== expected.size)
        throw new StoreError(`the stored copy has ${head.ContentLength} bytes, expected ${expected.size}`)
      if (head.ChecksumSHA256 && !head.ChecksumSHA256.includes("-")) {
        if (head.ChecksumSHA256 !== expected.sha256) throw new StoreError("the stored copy's checksum does not match")
        return
      }
      await verifyByReading(store, key, expected, signal, versionId)
    },

    async read(key, signal, versionId) {
      const res = await client.send(
        new GetObjectCommand({ Bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
        { abortSignal: signal },
      )
      if (!res.Body) throw new StoreError(`${key} is empty`)
      return res.Body as Readable
    },

    async remove(key, signal, versionId) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
          {
            abortSignal: signal,
          },
        )
      } catch (error) {
        if (!missing(error)) throw error
      }
    },

    async test(key, signal) {
      if (objectLock) {
        let enabled = false
        try {
          const res = await client.send(new GetObjectLockConfigurationCommand({ Bucket }), { abortSignal: signal })
          enabled = res.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled"
        } catch (error) {
          if (!(error instanceof S3ServiceException)) throw error
        }
        if (!enabled)
          throw new StoreError(
            "Object Lock is not enabled on this bucket. It is usually turned on when the bucket is created; create one with Object Lock, or turn the lock off here.",
          )
      }
      await roundTrip(store, key, signal)
      if (!objectLock) return []
      const days = objectLock.days === 1 ? "1 day" : `${objectLock.days} days`
      return [`Object Lock is enabled; new archives are locked for ${days}.`]
    },

    async close() {
      client.destroy()
    },
  }
  return store
}
