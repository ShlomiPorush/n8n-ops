import { describe, expect, it, vi } from "vitest"
import type { Db } from "../db/client.ts"
import { TestRefused, telegramTarget } from "../services/draft-tests.ts"
import {
  changedValueIssues,
  createSettings,
  defaults,
  invalidAnswer,
  isTimeZone,
  mayStoreTimeZone,
  numberLimits,
  resolveInstanceSettings,
  sections,
  smtpPasswordNeeded,
  wordedIssues,
} from "./settings.ts"

describe("SMTP password and server", () => {
  const stored = { smtpHost: "smtp.example.com", smtpPort: 587, smtpPasswordEnc: "enc" }

  it("asks for the password again when the host or the port changes", () => {
    expect(smtpPasswordNeeded(stored, { smtpHost: "mail.other.example", smtpPort: 587 }, undefined)).toBe(true)
    expect(smtpPasswordNeeded(stored, { smtpHost: "smtp.example.com", smtpPort: 465 }, "")).toBe(true)
  })

  it("asks for it again when the user changes", () => {
    const withUser = { ...stored, smtpUser: "reports" }
    expect(smtpPasswordNeeded(withUser, { ...withUser, smtpUser: "someone-else" }, undefined)).toBe(true)
    expect(smtpPasswordNeeded(withUser, { ...withUser, smtpUser: " reports " }, undefined)).toBe(false)
  })

  it("lets an ordinary save through: same server written differently", () => {
    expect(smtpPasswordNeeded(stored, { smtpHost: " SMTP.example.com ", smtpPort: "587" }, undefined)).toBe(false)
  })

  it("takes a new server with a new password, or with the password removed", () => {
    expect(smtpPasswordNeeded(stored, { smtpHost: "mail.other.example", smtpPort: 587 }, "secret")).toBe(false)
    expect(smtpPasswordNeeded(stored, { smtpHost: "mail.other.example", smtpPort: 587 }, null)).toBe(false)
  })

  it("has nothing to protect when no password is stored", () => {
    const { smtpPasswordEnc: _, ...none } = stored
    expect(smtpPasswordNeeded(none, { smtpHost: "mail.other.example", smtpPort: 587 }, undefined)).toBe(false)
  })
})

describe("instance settings", () => {
  it("uses the global defaults without overrides", () => {
    expect(resolveInstanceSettings(defaults.defaults, {})).toEqual(defaults.defaults)
  })

  it("applies valid overrides", () => {
    const result = resolveInstanceSettings(defaults.defaults, { pollIntervalSec: 30, executionRetentionDays: 14 })
    expect(result.pollIntervalSec).toBe(30)
    expect(result.executionRetentionDays).toBe(14)
    expect(result.backupTime).toBe(defaults.defaults.backupTime)
  })

  it("ignores invalid overrides instead of breaking the instance", () => {
    const result = resolveInstanceSettings(defaults.defaults, { pollIntervalSec: 1 })
    expect(result.pollIntervalSec).toBe(defaults.defaults.pollIntervalSec)
  })
})

describe("public URL", () => {
  // The smallest stand-in for select().from().where() returning the stored row, if any.
  const dbWith = (stored?: object) =>
    ({ select: () => ({ from: () => ({ where: async () => (stored ? [{ value: stored }] : []) }) }) }) as unknown as Db

  it("comes from N8N_OPS_PUBLIC_URL while Settings leaves it empty", async () => {
    const settings = createSettings(dbWith(), { publicUrl: "https://ops.example.com" })
    expect((await settings.get("general")).publicUrl).toBe("https://ops.example.com")
  })

  it("prefers the value saved in Settings", async () => {
    const settings = createSettings(dbWith({ publicUrl: "https://saved.example.com" }), {
      publicUrl: "https://ops.example.com",
    })
    expect((await settings.get("general")).publicUrl).toBe("https://saved.example.com")
  })

  it("stays empty when neither is set", async () => {
    expect((await createSettings(dbWith()).get("general")).publicUrl).toBe("")
  })

  it("is not part of what is stored, which a save starts from (FS-6)", async () => {
    const settings = createSettings(dbWith({ design: "compact" }), { publicUrl: "https://ops.example.com" })
    expect((await settings.stored("general")).publicUrl).toBe("")
    expect((await settings.get("general")).publicUrl).toBe("https://ops.example.com")
    expect(settings.fromEnv()).toEqual({ publicUrl: "https://ops.example.com" })
    expect(createSettings(dbWith()).fromEnv()).toEqual({})
  })
})

describe("checks before a value is stored", () => {
  it("reads the range of each number from the schema", () => {
    expect(numberLimits("alerts")).toMatchObject({
      retryMin: { min: 1, max: 60 },
      groupingWindowSec: { min: 0, max: 3600 },
    })
    expect(numberLimits("defaults").backlogThreshold).toEqual({ min: 1 })
    expect(numberLimits("general")).toEqual({})
  })

  it("checks only the fields a save changes", () => {
    const stored = { ...defaults.email, recipients: ["bob"] }
    expect(changedValueIssues("email", stored, { ...stored, from: "ops@example.com" })).toEqual([])
    expect(changedValueIssues("email", stored, { ...stored, recipients: ["bob", "ops@example.com"] })).toEqual([
      { path: ["recipients"], message: '"bob" is not an email address' },
    ])
  })

  it("names each refused field by its label", () => {
    expect(
      invalidAnswer("email", [
        { path: ["dailyTime"], message: "use HH:MM" },
        { path: ["smtpPort"], message: "use a whole number from 1 to 65535" },
      ]).message,
    ).toBe("Daily report time: use HH:MM SMTP port: use a whole number from 1 to 65535")
  })

  it("refuses a topic or a route in the words the UI uses, naming the route", () => {
    const refused = (value: object) => {
      const parsed = sections.telegram.safeParse({ ...defaults.telegram, ...value })
      return parsed.success ? "" : invalidAnswer("telegram", wordedIssues("telegram", parsed.error.issues)).message
    }
    expect(refused({ defaultThreadId: 0 })).toBe("Default topic: use the topic's number, such as 12")
    expect(refused({ routes: [{ tag: "billing", threadId: 7 }, { threadId: 8 }] })).toBe(
      "Topic routes: route 2: choose an instance, or type a workflow pattern or a tag",
    )
    expect(refused({ routes: [{ workflow: "(", threadId: 7 }] })).toBe(
      "Topic routes: route 1: the workflow pattern is not a valid regular expression",
    )
    expect(refused({ routes: [{ tag: "billing" }] })).toBe("Topic routes: route 1: use the topic's number, such as 12")
    expect(refused({ defaultThreadId: 12, routes: [{ instanceId: "a", threadId: 2_147_483_647 }] })).toBe("")
  })
})

describe("a Telegram test with the values on screen", () => {
  const stored = { ...defaults.telegram, botTokenEnc: "enc", chatId: "-100200", defaultThreadId: 12 }
  const target = (draft: Record<string, unknown>) => telegramTarget(stored, draft, () => "token")

  it("goes to the stored default topic, or to the one on screen, empty being General", () => {
    expect(target({}).threadId).toBe(12)
    expect(target({ defaultThreadId: " 34 " }).threadId).toBe(34)
    expect(target({ defaultThreadId: "" }).threadId).toBeNull()
  })

  it("is refused for a topic that is not a topic number, before anything is sent", () => {
    expect(() => target({ defaultThreadId: "general" })).toThrow(
      new TestRefused("Default topic: use the topic's number, such as 12"),
    )
  })
})

describe("web design", () => {
  const log = { info() {}, warn() {} }
  // A stand-in database: a stored General row, writes that can be slowed down, reads that can fail.
  function fakeDb(stored?: object, { slowFirstWrite = false, failReads = 0 } = {}) {
    let row = stored
    let writes = 0
    let reads = 0
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            reads += 1
            if (reads <= failReads) throw new Error("database down")
            return row ? [{ value: row }] : []
          },
        }),
      }),
      insert: () => ({
        values: ({ value }: { value: object }) => ({
          onConflictDoUpdate: async () => {
            writes += 1
            if (slowFirstWrite && writes === 1) await new Promise((r) => setTimeout(r, 30))
            row = value
          },
        }),
      }),
    }
    return { db: db as unknown as Db, stored: () => row }
  }

  it("is Regular while nothing is stored", async () => {
    const settings = createSettings(fakeDb().db)
    expect((await settings.get("general")).design).toBe("regular")
    expect(settings.design()).toBe("regular")
  })

  it("reads an installation saved before designs existed as Regular, keeping its other values", async () => {
    const settings = createSettings(fakeDb({ publicUrl: "https://ops.example.com", timezone: "Asia/Jerusalem" }).db)
    expect(await settings.get("general")).toEqual({
      publicUrl: "https://ops.example.com",
      timezone: "Asia/Jerusalem",
      dateFormat: "browser",
      timeFormat: "24h",
      design: "regular",
    })
  })

  it("reads an unknown stored design as Regular without resetting the rest of General", async () => {
    const settings = createSettings(
      fakeDb({ publicUrl: "https://ops.example.com", timezone: "Asia/Jerusalem", design: "wide" }).db,
    )
    const general = await settings.get("general")
    expect(general.design).toBe("regular")
    expect(general.timezone).toBe("Asia/Jerusalem")
    expect(general.publicUrl).toBe("https://ops.example.com")
  })

  it("refuses to store an unknown design", async () => {
    const settings = createSettings(fakeDb().db)
    await expect(
      settings.set("general", { ...defaults.general, publicUrl: "", timezone: "UTC", design: "wide" as "regular" }),
    ).rejects.toThrow()
    expect(settings.design()).toBe("regular")
  })

  it("takes only zone names as a new time zone, not a fixed offset", () => {
    for (const zone of ["UTC", "Asia/Jerusalem", "America/Argentina/Buenos_Aires", "Etc/GMT+3"])
      expect(isTimeZone(zone)).toBe(true)
    for (const zone of ["", "Mars/Base", "+03:00", "UTC+3", "Asia/Jerusalem; drop"])
      expect(isTimeZone(zone)).toBe(false)
    expect(mayStoreTimeZone("UTC", "Asia/Jerusalem")).toBe(true)
    expect(mayStoreTimeZone("UTC", "")).toBe(true)
    expect(mayStoreTimeZone("UTC", "+03:00")).toBe(false)
    // One saved before time zones were checked stays while it is not changed.
    expect(mayStoreTimeZone("+03:00", "+03:00")).toBe(true)
  })

  it("refuses to store a time zone no clock knows", async () => {
    const settings = createSettings(fakeDb().db)
    for (const timezone of ["Mars/Base", "Asia/Jerusalem; drop"])
      await expect(
        settings.set("general", { ...defaults.general, publicUrl: "", timezone, design: "regular" }),
      ).rejects.toThrow()
  })

  it("keeps a fixed offset stored before, and reads an unknown time zone as UTC without resetting General", async () => {
    const offset = createSettings(fakeDb({ publicUrl: "https://ops.example.com", timezone: "+03:00" }).db)
    expect((await offset.get("general")).timezone).toBe("+03:00")
    const unknown = createSettings(
      fakeDb({ publicUrl: "https://ops.example.com", timezone: "Mars/Base", design: "compact" }).db,
    )
    expect(await unknown.get("general")).toEqual({
      publicUrl: "https://ops.example.com",
      timezone: "UTC",
      dateFormat: "browser",
      timeFormat: "24h",
      design: "compact",
    })
  })

  it("reads an unknown stored date or time format as its default without resetting General (FW-9)", async () => {
    const settings = createSettings(
      fakeDb({
        publicUrl: "https://ops.example.com",
        timezone: "Asia/Jerusalem",
        dateFormat: "D MMM Y",
        timeFormat: "36h",
        design: "compact",
      }).db,
    )
    expect(await settings.get("general")).toEqual({
      publicUrl: "https://ops.example.com",
      timezone: "Asia/Jerusalem",
      dateFormat: "browser",
      timeFormat: "24h",
      design: "compact",
    })
  })

  it("stores a known date and time format and refuses an unknown one (FW-9)", async () => {
    const store = fakeDb()
    const settings = createSettings(store.db)
    await settings.set("general", { ...defaults.general, dateFormat: "YYYY-MM-DD", timeFormat: "12h" })
    expect(await settings.get("general")).toMatchObject({ dateFormat: "YYYY-MM-DD", timeFormat: "12h" })
    await expect(settings.set("general", { ...defaults.general, dateFormat: "D MMM Y" as "browser" })).rejects.toThrow()
    await expect(settings.set("general", { ...defaults.general, timeFormat: "36h" as "24h" })).rejects.toThrow()
  })

  it("follows a saved General at once", async () => {
    const settings = createSettings(fakeDb().db)
    await settings.set("general", { ...defaults.general, publicUrl: "", timezone: "UTC", design: "compact" })
    expect(settings.design()).toBe("compact")
  })

  it("ends as the last of two overlapping saves, like the database", async () => {
    const store = fakeDb(undefined, { slowFirstWrite: true })
    const settings = createSettings(store.db)
    await Promise.all([
      settings.set("general", { ...defaults.general, publicUrl: "", timezone: "UTC", design: "compact" }),
      settings.set("general", { ...defaults.general, publicUrl: "", timezone: "UTC", design: "regular" }),
    ])
    expect(settings.design()).toBe("regular")
    expect((store.stored() as { design: string }).design).toBe("regular")
  })

  it("loads the stored design at startup", async () => {
    const settings = createSettings(fakeDb({ design: "compact" }).db)
    await settings.loadDesign(log)
    expect(settings.design()).toBe("compact")
  })

  it("serves the default while the database does not answer, then picks up the stored design", async () => {
    vi.useFakeTimers()
    try {
      const settings = createSettings(fakeDb({ design: "compact" }, { failReads: 2 }).db)
      await settings.loadDesign(log, 1_000)
      expect(settings.design()).toBe("regular")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settings.design()).toBe("regular")
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settings.design()).toBe("compact")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("web design, a startup read racing a save", () => {
  it("keeps a design saved while the startup read was on its way", async () => {
    let release: (rows: unknown[]) => void = () => {}
    let row: object = { design: "regular" }
    const db = {
      select: () => ({
        from: () => ({ where: () => new Promise((resolve) => (release = resolve)) }),
      }),
      insert: () => ({
        values: ({ value }: { value: object }) => ({
          onConflictDoUpdate: async () => {
            row = value
          },
        }),
      }),
    } as unknown as Db
    const settings = createSettings(db)
    const loading = settings.loadDesign({ info() {}, warn() {} })
    await settings.set("general", { ...defaults.general, publicUrl: "", timezone: "UTC", design: "compact" })
    release([{ value: { design: "regular" } }]) // the read started before the save
    await loading
    expect(settings.design()).toBe("compact")
    expect((row as { design: string }).design).toBe("compact")
  })
})
