import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { describe, expect, it } from "vitest"
import { discover, type ListedContainer } from "./discovery.ts"
import { type Docker, DockerError } from "./docker.ts"
import { backupJob } from "./jobs.ts"
import { pickReplica, replicasClean, targetOf } from "./target.ts"

// Following an instance's main by its Compose project and service: which container is used during a rollout, that
// labels alone never make a container one of the service's, and when a rule for its replicas reaches only them.
const ENTRY = "tini -- /docker-entrypoint.sh"
const t = { project: "n8n1", service: "app" }
const c = (
  name: string,
  more: Partial<ListedContainer> = {},
  labels: Record<string, string> = {},
): ListedContainer => ({
  Names: [`/${name}`],
  Image: "n8nio/n8n:2.44.3",
  Command: ENTRY,
  State: "running",
  Status: "Up 5 minutes (healthy)",
  Created: 1000,
  Labels: {
    "com.docker.compose.project": "n8n1",
    "com.docker.compose.service": "app",
    "com.docker.compose.oneoff": "False",
    ...labels,
  },
  ...more,
})

describe("pickReplica", () => {
  it("uses the one running replica", () => {
    expect(pickReplica([c("n8n1-app-1")], t)).toMatchObject({ ok: true, name: "n8n1-app-1" })
  })

  it("keeps the healthy one during a rollout until the new one is healthy, then takes the newest", () => {
    const old = c("n8n1-app-1", { Created: 1000 })
    const starting = c("n8n1-app-2", { Created: 2000, Status: "Up 3 seconds (health: starting)" })
    expect(pickReplica([old, starting], t)).toMatchObject({ name: "n8n1-app-1" })
    const healthy = c("n8n1-app-2", { Created: 2000 })
    expect(pickReplica([old, healthy], t)).toMatchObject({ name: "n8n1-app-2" })
    // An unhealthy new one does not take over from a healthy old one either.
    expect(pickReplica([old, c("n8n1-app-2", { Created: 2000, Status: "Up 1 minute (unhealthy)" })], t)).toMatchObject({
      name: "n8n1-app-1",
    })
  })

  it("takes a stopped one when none runs, so the main reads as down", () => {
    const stopped = c("n8n1-app-3", { State: "exited", Status: "Exited (0) 1 minute ago" })
    expect(pickReplica([stopped], t)).toMatchObject({ ok: true, name: "n8n1-app-3", state: "exited" })
  })

  it("never takes a one-off run or a container that only carries the labels", () => {
    const run = c("n8n1-app-run-1a2b", {}, { "com.docker.compose.oneoff": "True" })
    const spoof = c("evil", { Created: 9999 })
    expect(pickReplica([run, spoof, c("n8n1-app-1")], t)).toMatchObject({ name: "n8n1-app-1" })
    expect(pickReplica([spoof], t)).toEqual({
      ok: false,
      reason: 'no container of service "app" in project "n8n1" is named as Compose names it',
    })
    expect(pickReplica([], t)).toEqual({
      ok: false,
      reason: 'no container of service "app" in project "n8n1" was found on this host',
    })
  })

  it("takes only a project and a service that Compose would accept", () => {
    expect(targetOf({ project: "n8n1", service: "app" })).toEqual(t)
    expect(targetOf({ project: "N8N", service: "app" })).toBeUndefined()
    expect(targetOf({ project: "n8n1", service: "a|b" })).toBeUndefined()
    expect(targetOf({ project: "n8n1" })).toBeUndefined()
  })
})

describe("replicasClean", () => {
  const docker = (list: ListedContainer[] | Error) =>
    ({
      listContainers: async () => {
        if (list instanceof Error) throw list
        return list
      },
    }) as unknown as Docker
  const call = () => ({ signal: AbortSignal.timeout(1000), maxBytes: 1024 * 1024 })

  it("is clean when every container named like a replica is one", async () => {
    expect(
      await replicasClean(
        docker([c("n8n1-app-1"), c("postgres", {}, { "com.docker.compose.service": "db" })]),
        t,
        call,
      ),
    ).toBe(true)
  })

  it("is not clean when another project gives the same names, or a container only has the name", async () => {
    // Project n8n1 with service app-main, and project n8n1-app with service main: both n8n1-app-main-1.
    const target = { project: "n8n1", service: "app-main" }
    const other = c(
      "n8n1-app-main-2",
      {},
      { "com.docker.compose.project": "n8n1-app", "com.docker.compose.service": "main" },
    )
    const own = c("n8n1-app-main-1", {}, { "com.docker.compose.service": "app-main" })
    expect(await replicasClean(docker([own, other]), target, call)).toBe(false)
    expect(
      await replicasClean(
        docker([c("n8n1-app-1"), c("n8n1-app-2", {}, { "com.docker.compose.project": "x" })]),
        t,
        call,
      ),
    ).toBe(false)
  })

  it("says nothing when the list cannot be read", async () => {
    expect(await replicasClean(docker(new Error("refused")), t, call)).toBeUndefined()
  })
})

describe("discover with a Compose service", () => {
  const worker = (name: string) => c(name, { Command: `${ENTRY} worker` }, { "com.docker.compose.service": "worker" })

  it("counts the replicas of the service as one main during a rollout, and an old stopped one too", () => {
    const list = [
      c("n8n1-app-1"),
      c("n8n1-app-2", { Created: 2000 }),
      c("n8n1-app-0", { State: "exited" }),
      worker("n8n1-worker-1"),
    ]
    const found = discover(list, "n8n1-app-2", "app")
    expect(found.status === "ok" && found.workers.map((w) => w.name)).toEqual(["n8n1-worker-1"])
    // Without the service, the same project has three mains: not told apart.
    expect(discover(list, "n8n1-app-2").status).toBe("ambiguous")
  })

  it("still refuses a main of another service in the project", () => {
    const list = [
      c("n8n1-app-1"),
      c("n8n1-other-1", {}, { "com.docker.compose.service": "other" }),
      worker("n8n1-worker-1"),
    ]
    expect(discover(list, "n8n1-app-1", "app").status).toBe("ambiguous")
  })
})

describe("a backup of a Compose service", () => {
  it("exports and reads the archive in one command, and says so when a rollout replaced the container", async () => {
    const ran: string[] = []
    const scripts: string[] = []
    const docker = {
      listContainers: async () => [c("n8n1-app-1")],
      exec: async (container: string, cmd: string[]) => {
        ran.push(container)
        scripts.push(cmd.join(" "))
        // The container is gone by the time the command runs.
        if (scripts.length === 1) throw new DockerError("gone", "missing", 404, "exec-create")
        return { exitCode: 0, stdout: Buffer.from(""), stderr: "" }
      },
    } as unknown as Docker
    const result = await backupJob(
      docker,
      { target: t, recipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" },
      async () => {
        throw new Error("no upload expected")
      },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe("the container n8n1-app-1 was replaced during the backup; the next run uses the new one")
    expect(result.resolvedContainer).toBe("n8n1-app-1")
    expect(new Set(ran)).toEqual(new Set(["n8n1-app-1"]))
    // A redeploy can reuse the name between two commands: the export and the read are one, then only cleanup.
    expect(scripts[0]).toMatch(/n8n export:workflow[\s\S]*cat \/tmp\/n8n-ops-export\.tar$/)
    expect(scripts.slice(1).every((s) => s.includes("rm -rf"))).toBe(true)
  })
})

describe("each export of a backup by its own output", () => {
  // What the one backup command prints on stderr, the archive (empty here) on stdout.
  const backupWith = async (stderr: string) => {
    const recipient = await identityToRecipient(await generateX25519Identity())
    const docker = {
      exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(1024), stderr }),
    } as unknown as Docker
    return backupJob(docker, { container: "n8n", recipient }, async () => {
      throw new Error("upload reached")
    })
  }

  it("backs up an empty instance", async () => {
    const result = await backupWith(
      "No workflows found\n__WF_FAILED__\n__CREDENTIALS_EXPORT__\nNo credentials found\n__CRED_FAILED__\n",
    )
    expect(result.error).toBe("upload reached")
  })

  it("never lets an empty workflow export excuse a failed credential export", async () => {
    const result = await backupWith(
      "No workflows found\n__WF_FAILED__\n__CREDENTIALS_EXPORT__\nError: decryption failed\n__CRED_FAILED__\n",
    )
    expect(result.error).toMatch(/^credential export failed: [\s\S]*decryption failed/)
  })
})

describe("what a job says when the service cannot be used", () => {
  const recipient = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
  const noUpload = async () => {
    throw new Error("no upload expected")
  }

  it("keeps a refused list as a refusal, so the lines that allow it can be shown", async () => {
    const docker = {
      listContainers: async () => {
        throw new DockerError("the socket proxy does not allow listing containers", "refused", 403, "list")
      },
    } as unknown as Docker
    const result = await backupJob(docker, { target: t, recipient }, noUpload)
    expect(result).toMatchObject({
      ok: false,
      error: "the socket proxy does not allow listing containers",
      refused: { call: "list" },
    })
  })

  it("says a service whose containers were all stopped is stopped, not replaced", async () => {
    const docker = {
      listContainers: async () => [c("n8n1-app-3", { State: "exited", Status: "Exited (0) 1 hour ago" })],
      exec: async () => {
        throw new DockerError("not running", "not-running", 409, "exec-create")
      },
    } as unknown as Docker
    const result = await backupJob(docker, { target: t, recipient }, noUpload)
    expect(result.error).toBe(
      "no container of service app in project n8n1 is running (the newest, n8n1-app-3, is stopped)",
    )
  })
})
