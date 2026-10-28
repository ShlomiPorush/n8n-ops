import { describe, expect, it } from "vitest"
import { READERS } from "./inside.ts"
import { figuresOf } from "./queue-workers.ts"

// The readers of the check in a queue worker, run as the same text against stand-in files: what each figure is,
// and that it is left out whenever the files do not say it for sure.
type Read = (path: string) => string
const { versionOf, uptimeOf, memoryOf } = new Function(`${READERS}; return { versionOf, uptimeOf, memoryOf }`)() as {
  versionOf: (read: Read) => string | undefined
  uptimeOf: (read: Read) => number | undefined
  memoryOf: (read: Read) => { used: number; limit: number | null } | undefined
}
const files =
  (map: Record<string, string>): Read =>
  (path) => {
    const text = map[path]
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  }

describe("versionOf", () => {
  it("reads n8n's version from its package, and nothing that is not a version", () => {
    const pkg = "/usr/local/lib/node_modules/n8n/package.json"
    expect(versionOf(files({ [pkg]: '{"version":"2.44.3"}' }))).toBe("2.44.3")
    expect(versionOf(files({ [pkg]: '{"version":"<script>"}' }))).toBeUndefined()
    expect(versionOf(files({}))).toBeUndefined()
    expect(versionOf(files({ [pkg]: '{"version":"2.44.1234567"}' }))).toBeUndefined()
    expect(versionOf(files({ [pkg]: '{"version":"2.44.3-beta.1"}' }))).toBe("2.44.3-beta.1")
    expect(versionOf(files({ [pkg]: `{"version":"${"9".repeat(30)}.0.0"}` }))).toBeUndefined()
    expect(versionOf(files({ [pkg]: `{"version":"2.44.3-${"a".repeat(40)}"}` }))).toBeUndefined()
  })
})

describe("uptimeOf", () => {
  // Field 22 (the start time) is the 20th after the command; 4250 ticks is 42.5 s after boot.
  const stat = (comm: string) =>
    `1 (${comm}) S 0 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 4250 1000 100 18446744073709551615`
  it("counts from PID 1's start, also when its command has spaces and parentheses", () => {
    expect(
      uptimeOf(
        files({
          "/proc/1/cgroup": "0::/",
          "/proc/self/cgroup": "0::/",
          "/proc/1/stat": stat("tini"),
          "/proc/uptime": "3642.50 100.00",
        }),
      ),
    ).toBe(3600)
    expect(
      uptimeOf(
        files({
          "/proc/1/cgroup": "0::/",
          "/proc/self/cgroup": "0::/",
          "/proc/1/stat": stat("node"),
          "/proc/uptime": "142.5 1",
        }),
      ),
    ).toBe(100)
  })
  it("says nothing when PID 1 is not the container's init or n8n, or the files are not there", () => {
    expect(
      uptimeOf(
        files({
          "/proc/1/cgroup": "0::/",
          "/proc/self/cgroup": "0::/",
          "/proc/1/stat": stat("systemd"),
          "/proc/uptime": "3642.5 1",
        }),
      ),
    ).toBeUndefined()
    expect(
      uptimeOf(
        files({
          "/proc/1/cgroup": "0::/",
          "/proc/self/cgroup": "0::/",
          "/proc/1/stat": stat("my (odd) init"),
          "/proc/uptime": "3642.5 1",
        }),
      ),
    ).toBeUndefined()
    expect(uptimeOf(files({ "/proc/uptime": "3642.5 1" }))).toBeUndefined()
    // A PID namespace shared with another container: PID 1 is that one's, so its time is not this container's.
    expect(
      uptimeOf(
        files({
          "/proc/1/cgroup": "0::/docker/main",
          "/proc/self/cgroup": "0::/docker/worker",
          "/proc/1/stat": stat("tini"),
          "/proc/uptime": "3642.5 1",
        }),
      ),
    ).toBeUndefined()
  })
})

describe("memoryOf", () => {
  const v2mount = "30 25 0:26 / /sys/fs/cgroup ro,nosuid shared:4 - cgroup2 cgroup2 rw,nsdelegate"
  it("reads the v2 group of a private namespace", () => {
    const read = files({
      "/proc/self/cgroup": "0::/",
      "/proc/self/mountinfo": v2mount,
      "/sys/fs/cgroup/memory.current": "327155712\n",
      "/sys/fs/cgroup/memory.max": "1073741824\n",
    })
    expect(memoryOf(read)).toEqual({ used: 327155712, limit: 1073741824 })
  })
  it("reads no limit as null, never as a figure", () => {
    const read = files({
      "/proc/self/cgroup": "0::/",
      "/proc/self/mountinfo": v2mount,
      "/sys/fs/cgroup/memory.current": "1000",
      "/sys/fs/cgroup/memory.max": "max",
    })
    expect(memoryOf(read)).toEqual({ used: 1000, limit: null })
  })
  it("finds the v1 group mapped straight to the mount root, with the host namespace", () => {
    const read = files({
      "/proc/self/cgroup": "12:pids:/docker/abc\n9:memory:/docker/abc\n0::/docker/abc",
      "/proc/self/mountinfo": [
        "40 30 0:35 /docker/abc /sys/fs/cgroup/memory ro,nosuid - cgroup cgroup rw,memory",
        "41 30 0:36 /docker/abc /sys/fs/cgroup/pids ro,nosuid - cgroup cgroup rw,pids",
      ].join("\n"),
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "2000",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    })
    // The v1 sentinel of no limit.
    expect(memoryOf(read)).toEqual({ used: 2000, limit: null })
  })
  it("prefers the v1 memory controller on a hybrid host, under the group's own folder", () => {
    const read = files({
      "/proc/self/cgroup": "0::/user.slice\n4:memory:/docker/abc",
      "/proc/self/mountinfo": [
        v2mount.replace("/sys/fs/cgroup", "/sys/fs/cgroup/unified"),
        "40 30 0:35 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
      ].join("\n"),
      "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": "3000",
      "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": "536870912",
    })
    expect(memoryOf(read)).toEqual({ used: 3000, limit: 536870912 })
  })
  it("decodes the octal escapes of mountinfo, and keeps a group path with spaces as it is", () => {
    const read = files({
      "/proc/self/cgroup": "0::/my group",
      "/proc/self/mountinfo": "30 25 0:26 / /sys/fs/cgroup\\040x ro shared:4 - cgroup2 cgroup2 rw",
      "/sys/fs/cgroup x/my group/memory.current": "10",
      "/sys/fs/cgroup x/my group/memory.max": "20",
    })
    expect(memoryOf(read)).toEqual({ used: 10, limit: 20 })
  })

  it("says nothing without a matching mount or readable files", () => {
    expect(memoryOf(files({ "/proc/self/cgroup": "0::/", "/proc/self/mountinfo": "" }))).toBeUndefined()
    expect(
      memoryOf(
        files({ "/proc/self/cgroup": "0::/", "/proc/self/mountinfo": v2mount, "/sys/fs/cgroup/memory.max": "max" }),
      ),
    ).toBeUndefined()
    expect(memoryOf(files({}))).toBeUndefined()
  })
})

describe("figuresOf", () => {
  const details = { version: "2.44.3", uptimeSec: 60, concurrencyEnv: "absent" as const }
  it("takes the variable, then the flag, then n8n's default of 10, for n8n 2", () => {
    expect(figuresOf({ ...details, concurrencyEnv: 7 }, 5).concurrency).toEqual({ value: 7, from: "env" })
    expect(figuresOf(details, 5).concurrency).toEqual({ value: 5, from: "flag" })
    expect(figuresOf(details, undefined).concurrency).toEqual({ value: 10, from: "default" })
  })
  it("gives no concurrency it cannot be sure of", () => {
    expect(figuresOf({ ...details, concurrencyEnv: "unknown" }, 5).concurrency).toBeUndefined()
    expect(figuresOf(details, "invalid").concurrency).toBeUndefined()
    expect(figuresOf({ ...details, version: "1.99.0" }, 5).concurrency).toBeUndefined()
    expect(figuresOf({ ...details, version: undefined }, 5).concurrency).toBeUndefined()
  })
})
