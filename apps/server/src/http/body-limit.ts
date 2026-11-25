import type { Context } from "hono"

export const sizeText = (bytes: number) => (bytes >= 1024 ** 2 ? `${bytes / 1024 ** 2} MiB` : `${bytes / 1024} KiB`)

export const tooLarge = (bytes: number) => (c: Context) =>
  c.json({ error: "too_large", message: `The request body is larger than ${sizeText(bytes)}.` }, 413)
