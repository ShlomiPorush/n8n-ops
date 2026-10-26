import { describe, expect, it } from "vitest"
import { countdown, type SessionStatus, sessionView } from "./session-clock"

const status = (idleSec: number | null, maxSec = 12 * 3600, lifetimeSec = 24 * 3600): SessionStatus => ({
  idle: idleSec === null ? null : { timeoutSec: 3600, remainingSec: idleSec },
  max: { remainingSec: maxSec },
  lifetime: { remainingSec: lifetimeSec },
})

describe("the page's view of its session clocks", () => {
  it("counts down from the answer without asking again until the idle warning is near", () => {
    const view = sessionView({ status: status(600), at: 0 }, 60_000)
    expect(view.idleLeft).toBe(540_000)
    expect(view).toMatchObject({ idle: "none", due: false, maxSoon: false })
  })

  it("asks the server before it warns, since input in another tab may have restarted the clock", () => {
    expect(sessionView({ status: status(600), at: 0 }, 541_000).idle).toBe("confirm")
    expect(sessionView({ status: status(59), at: 0 }, 0).idle).toBe("warn")
  })

  it("asks once a clock reaches zero, so the server can end the session and say why", () => {
    expect(sessionView({ status: status(30), at: 0 }, 30_000).due).toBe(true)
    expect(sessionView({ status: status(null, 10), at: 0 }, 10_000).due).toBe(true)
    expect(sessionView({ status: status(null, 3600, 5), at: 0 }, 5_000).due).toBe(true)
  })

  it("never warns about inactivity while the idle timeout is off", () => {
    expect(sessionView({ status: status(null), at: 0 }, 10 * 3600_000)).toMatchObject({ idle: "none" })
  })

  it("says when the maximum length is five minutes away", () => {
    expect(sessionView({ status: status(null, 301), at: 0 }, 0).maxSoon).toBe(false)
    expect(sessionView({ status: status(null, 300), at: 0 }, 0).maxSoon).toBe(true)
  })

  it("writes a countdown as m:ss", () => {
    expect(countdown(59_200)).toBe("1:00")
    expect(countdown(45_000)).toBe("0:45")
    expect(countdown(-5)).toBe("0:00")
  })
})
