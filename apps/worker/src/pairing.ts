import { dataDirProblem, saveIdentity } from "./data-dir.ts"

type Log = (msg: string, extra?: Record<string, unknown>) => void

export type PairingOptions = {
  dataDir: string
  identityFile: string
  /** Sends the token to the server's pair endpoint. */
  request: (token: string) => Promise<Response>
  log: Log
}

/**
 * Exchanges the one-time pairing token for the worker's identity. The loop calls attempt every few seconds, so a
 * reason not to pair is logged once until it changes, and a token the server has spent is not sent again: only a
 * new token pairs after that.
 */
export class Pairing {
  private said: string | null = null
  /** Tokens the server refused or spent, for as long as the worker runs. */
  private readonly spent = new Set<string>()

  constructor(private readonly options: PairingOptions) {}

  /** One try: the identity when it is paired and saved, otherwise null. */
  async attempt(token: string | null): Promise<string | null> {
    if (!token) return this.quiet()
    const { dataDir, identityFile, request, log } = this.options
    if (this.spent.has(token))
      return this.once("not pairing: this pairing token was already used, is wrong or expired; create a new one")
    const problem = await dataDirProblem(dataDir)
    if (problem) return this.once("not pairing yet; the pairing token is kept", { problem })
    this.said = null
    const res = await request(token)
    if (res.status === 401) {
      // Wrong, used or expired: sending it again cannot work.
      this.spent.add(token)
      log("pairing failed", { status: res.status, body: (await res.text()).slice(0, 200) })
      return null
    }
    if (!res.ok) {
      log("pairing failed", { status: res.status, body: (await res.text()).slice(0, 200) })
      return null
    }
    // The server has spent the token when it answers yes, even if the answer is then cut off or cannot be saved.
    this.spent.add(token)
    const { identity, workerId, name } = (await res.json()) as { identity: string; workerId: string; name: string }
    try {
      await saveIdentity(identityFile, { identity, workerId, name })
    } catch (error) {
      log("paired, but the identity could not be saved; revoke this worker and create a new pairing token", {
        workerId,
        name,
        error: (error as Error).message,
      })
      return null
    }
    log("paired", { workerId, name })
    return identity
  }

  private quiet() {
    this.said = null
    return null
  }

  private once(msg: string, extra: Record<string, unknown> = {}) {
    const key = JSON.stringify([msg, extra])
    if (key !== this.said) this.options.log(msg, extra)
    this.said = key
    return null
  }
}
