import { dataDirProblem, saveIdentity } from "./data-dir.ts"

type Log = (msg: string, extra?: Record<string, unknown>) => void

export type PairingOptions = {
  dataDir: string
  identityFile: string
  request: (token: string) => Promise<Response>
  log: Log
}

export class Pairing {
  private said: string | null = null
  private readonly spent = new Set<string>()

  constructor(private readonly options: PairingOptions) {}

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
      this.spent.add(token)
      log("pairing failed", { status: res.status, body: (await res.text()).slice(0, 200) })
      return null
    }
    if (!res.ok) {
      log("pairing failed", { status: res.status, body: (await res.text()).slice(0, 200) })
      return null
    }
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
