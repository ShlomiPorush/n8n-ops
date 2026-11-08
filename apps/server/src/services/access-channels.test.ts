import { describe, expect, it } from "vitest"
import { accessInput } from "../routes/agent.ts"
import { channelsFor, dueChannels } from "./access-channels.ts"

describe("where an access request goes", () => {
  const both = ["telegram", "email"] as const

  it("follows the agent's choice among the channels that are on and set up", () => {
    expect(channelsFor(["telegram"], both, both)).toEqual(["telegram"])
    expect(channelsFor(["email"], ["telegram"], both)).toEqual(["email"])
    expect(channelsFor(["email", "telegram"], ["telegram"], both)).toEqual(["telegram", "email"])
  })

  it("uses the default when the agent chose nothing, or only channels that are off", () => {
    expect(channelsFor(null, ["email"], both)).toEqual(["email"])
    expect(channelsFor(undefined, both, both)).toEqual(["telegram", "email"])
    expect(channelsFor(["telegram"], ["email"], ["email"])).toEqual(["email"])
    expect(channelsFor(["telegram", "email"], ["email"], ["email"])).toEqual(["email"])
  })

  it("never goes to a channel that is off, nor beyond the default", () => {
    expect(channelsFor(["telegram"], ["telegram"], ["email"])).toEqual([])
    expect(channelsFor(null, ["telegram"], ["email"])).toEqual([])
    expect(channelsFor(null, both, [])).toEqual([])
  })
})

describe("the channels to try now", () => {
  const now = Date.parse("2026-11-08T12:00:00Z")
  const retry = 5 * 60_000
  const none = { telegram: false, email: false }
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()

  it("leaves out a channel that already took the request", () => {
    expect(dueChannels(["telegram", "email"], { telegram: true, email: false }, {}, now, retry)).toEqual(["email"])
  })

  it("lets each failed channel wait its own retry time, and never holds back another", () => {
    expect(dueChannels(["telegram", "email"], none, { telegram: ago(1) }, now, retry)).toEqual(["email"])
    expect(dueChannels(["telegram"], none, { telegram: ago(5), email: ago(1) }, now, retry)).toEqual(["telegram"])
    expect(dueChannels(["telegram", "email"], none, { telegram: ago(4), email: ago(6) }, now, retry)).toEqual(["email"])
  })

  it("treats a failure time it cannot read as none", () => {
    expect(dueChannels(["email"], none, { email: "soon" }, now, retry)).toEqual(["email"])
    expect(dueChannels(["email"], none, null, now, retry)).toEqual(["email"])
  })
})

describe("the channel an agent asks for", () => {
  const reason = "Fix the failing webhook"
  it("is kept in both forms of a request, and left out when not given", () => {
    expect(
      accessInput({ instance: "prod", scopes: ["workflow:read"], reason, minutes: 5, notify: ["telegram"] }),
    ).toMatchObject({ notify: ["telegram"] })
    expect(
      accessInput({
        instances: [{ instance: "prod", scopes: ["workflow:read"] }],
        reason,
        minutes: 5,
        notify: ["email"],
      }),
    ).toMatchObject({ notify: ["email"] })
    expect(accessInput({ instance: "prod", scopes: ["workflow:read"], reason, minutes: 5 })).not.toHaveProperty(
      "notify",
    )
  })
})
