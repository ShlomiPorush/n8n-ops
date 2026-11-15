import type { Context } from "hono"

/** A size in the words the answers use: KiB below a MiB, MiB from there. */
export const sizeText = (bytes: number) => (bytes >= 1024 ** 2 ? `${bytes / 1024 ** 2} MiB` : `${bytes / 1024} KiB`)

/** The answer to a request body over its limit, for hono/body-limit's `onError`. */
export const tooLarge = (bytes: number) => (c: Context) =>
  c.json({ error: "too_large", message: `The request body is larger than ${sizeText(bytes)}.` }, 413)
