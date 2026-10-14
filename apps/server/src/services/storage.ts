import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { Ctx } from "../context.ts"

export type Storage = {
  bucket: string
  prefix: string
  client: S3Client
}

/** S3-compatible storage from Settings > Backup storage, or null when it is not configured. */
export async function storageFor(ctx: Ctx): Promise<Storage | null> {
  const s = await ctx.settings.get("storage")
  if (!s.bucket || !s.accessKeyId || !s.secretAccessKeyEnc) return null
  const client = new S3Client({
    region: s.region || "us-east-1",
    ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: ctx.secrets.decrypt(s.secretAccessKeyEnc) },
    // Many S3-compatible services do not implement the newer default checksum behaviour.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  return { bucket: s.bucket, prefix: s.prefix.replace(/^\/+|\/+$/g, ""), client }
}

export async function requireStorage(ctx: Ctx): Promise<Storage> {
  const storage = await storageFor(ctx)
  if (!storage) throw new Error("Backup storage is not configured. Set it in Settings > Backup storage.")
  return storage
}

export function objectKey(storage: Storage, ...parts: string[]): string {
  return [storage.prefix, ...parts].filter(Boolean).join("/")
}

export async function putObject(storage: Storage, key: string, body: Uint8Array, sha256Base64: string) {
  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: "application/octet-stream",
      ChecksumSHA256: sha256Base64,
    }),
  )
}

/** A URL the worker can PUT the archive to, valid for 15 minutes. Size and checksum are part of the signature. */
export async function presignUpload(storage: Storage, key: string, size: number, sha256Base64: string) {
  const command = new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    ContentLength: size,
    ContentType: "application/octet-stream",
    ChecksumSHA256: sha256Base64,
  })
  const url = await getSignedUrl(storage.client, command, {
    expiresIn: 900,
    signableHeaders: new Set(["content-length", "x-amz-checksum-sha256", "content-type"]),
  })
  return {
    url,
    headers: {
      "content-length": String(size),
      "content-type": "application/octet-stream",
      "x-amz-checksum-sha256": sha256Base64,
    },
  }
}

/** Confirms the object exists with the expected size, and the checksum when the service reports one. */
export async function verifyObject(storage: Storage, key: string, size: number, sha256Base64: string) {
  const head = await storage.client.send(
    new HeadObjectCommand({ Bucket: storage.bucket, Key: key, ChecksumMode: "ENABLED" }),
  )
  if (head.ContentLength !== size) throw new Error(`uploaded size ${head.ContentLength} does not match ${size}`)
  if (head.ChecksumSHA256 && head.ChecksumSHA256 !== sha256Base64) throw new Error("uploaded checksum does not match")
}

export async function getObject(storage: Storage, key: string): Promise<Uint8Array> {
  const res = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }))
  if (!res.Body) throw new Error(`object ${key} is empty`)
  return await res.Body.transformToByteArray()
}

export async function deleteObject(storage: Storage, key: string) {
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }))
}
