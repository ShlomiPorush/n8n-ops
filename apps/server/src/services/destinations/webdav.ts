import { createReadStream } from "node:fs"
import type { IncomingMessage } from "node:http"
import { type RequestOptions, request } from "node:https"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { checkKey, roundTrip, type Store, StoreError, verifyByReading } from "./store.ts"

export type WebdavLocation = { url: string; username: string }
export type WebdavCredentials = { password: string }

/** Only HTTPS: the password goes with every request (Basic authentication). */
export function webdavBase(value: string): URL {
  const url = new URL(value.trim())
  if (url.protocol !== "https:") throw new StoreError("the WebDAV URL must start with https://")
  if (url.username || url.password)
    throw new StoreError("put the user name and password in their own fields, not in the URL")
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  url.search = ""
  url.hash = ""
  return url
}

type Answer = { status: number; headers: IncomingMessage["headers"]; body: IncomingMessage }

export function webdavStore(
  location: WebdavLocation,
  credentials: WebdavCredentials,
  options: { agentOptions?: Pick<RequestOptions, "ca"> } = {},
): Store {
  const base = webdavBase(location.url)
  const auth = `Basic ${Buffer.from(`${location.username}:${credentials.password}`).toString("base64")}`

  /** The URL of a path under the base, every segment percent-encoded. */
  const urlOf = (path: string, folder = false) => {
    const parts = path ? checkKey(path) : []
    return new URL(parts.map(encodeURIComponent).join("/") + (folder && parts.length ? "/" : ""), base)
  }

  function send(
    method: string,
    url: URL,
    signal: AbortSignal,
    { headers = {}, body }: { headers?: Record<string, string>; body?: Readable | string } = {},
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { method, headers: { authorization: auth, ...headers }, signal, ...options.agentOptions },
        (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
      )
      req.on("error", reject)
      if (body === undefined || typeof body === "string") req.end(body)
      else void pipeline(body, req).catch(reject)
    })
  }

  async function expect(answer: Answer, ok: number[], what: string) {
    if (ok.includes(answer.status)) return answer
    const text = await readText(answer.body)
    if (answer.status === 401 || answer.status === 403)
      throw new StoreError(`the WebDAV server refused the user name or password (${answer.status})`)
    throw new StoreError(`${what} failed: HTTP ${answer.status}${text ? ` ${text.slice(0, 200)}` : ""}`)
  }

  /** Whether the URL is a collection (folder), from PROPFIND with depth 0. */
  async function isCollection(url: URL, signal: AbortSignal) {
    const answer = await send("PROPFIND", url, signal, {
      headers: { depth: "0", "content-type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
    if (answer.status === 404) {
      answer.body.resume()
      return false
    }
    const xml = await readText((await expect(answer, [207], `Reading ${url.pathname}`)).body)
    return /<(?:[\w-]+:)?collection\b/i.test(xml)
  }

  /** Creates the folders of a path one by one. 405 means it exists, which is confirmed to be a folder. */
  async function folders(path: string, signal: AbortSignal) {
    const parts = checkKey(path)
    for (let i = 1; i <= parts.length; i++) {
      const url = urlOf(parts.slice(0, i).join("/"), true)
      const made = await send("MKCOL", url, signal)
      made.body.resume()
      if (made.status === 201) continue
      if (made.status === 405 && (await isCollection(url, signal))) continue
      throw new StoreError(`could not create the folder ${url.pathname}: HTTP ${made.status}`)
    }
  }

  const store: Store = {
    key: (parts) => parts.join("/"),

    async put(key, file, expected, signal) {
      const parts = checkKey(key)
      if (parts.length > 1) await folders(parts.slice(0, -1).join("/"), signal)
      const part = `${key}.part`
      const put = await send("PUT", urlOf(part), signal, {
        headers: { "content-length": String(expected.size), "content-type": "application/octet-stream" },
        body: createReadStream(file, { signal }),
      })
      ;(await expect(put, [200, 201, 204], "Uploading the archive")).body.resume()
      const moved = await send("MOVE", urlOf(part), signal, {
        headers: { destination: urlOf(key).toString(), overwrite: "T" },
      })
      ;(await expect(moved, [201, 204], "Renaming the uploaded archive")).body.resume()
      return {}
    },

    verify: (key, expected, signal) => verifyByReading(store, key, expected, signal),

    async read(key, signal) {
      const answer = await expect(await send("GET", urlOf(key), signal), [200], `Reading ${key}`)
      return answer.body
    },

    async remove(key, signal) {
      const answer = await send("DELETE", urlOf(key), signal)
      ;(await expect(answer, [200, 204, 404], `Deleting ${key}`)).body.resume()
    },

    async test(signal) {
      if (!(await isCollection(base, signal)))
        throw new StoreError(`${base.pathname} is not a folder on the WebDAV server`)
      await roundTrip(store, signal)
      return []
    },

    async close() {},
  }
  return store
}

async function readText(body: Readable) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    if (size < 64 * 1024) chunks.push(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return Buffer.concat(chunks).toString("utf8")
}
