import { describe, expect, it } from "vitest"
import { releaseChecker } from "./instances.ts"

/** A stand-in GitHub: answers in order, counting the reads, on a clock the test moves. */
function github(...answers: (() => Response)[]) {
  const state = { reads: 0, now: 1_000_000 }
  const fetchImpl = async () => {
    const answer = answers[Math.min(state.reads, answers.length - 1)]
    state.reads += 1
    if (!answer) throw new Error("no answer")
    return answer()
  }
  return { state, check: releaseChecker(fetchImpl, () => state.now) }
}
const release = (tag: string) => () => Response.json({ tag_name: tag })
const hour = 3600_000

describe("the newest n8n release", () => {
  it("is read once per set interval, and again when the interval is shortened", async () => {
    const { state, check } = github(release("n8n@2.45.7"), release("n8n@2.46.0"))
    expect(await check(6)).toBe("2.45.7")
    state.now += 5 * hour
    expect(await check(6)).toBe("2.45.7")
    expect(state.reads).toBe(1)
    expect(await check(4)).toBe("2.46.0")
    expect(state.reads).toBe(2)
  })

  it("keeps the version known before when GitHub answers with an error, and tries again within an hour", async () => {
    const { state, check } = github(
      release("n8n@2.45.7"),
      () => Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
      () => new Response("not json", { status: 200 }),
      release("n8n@2.46.0"),
    )
    expect(await check(6)).toBe("2.45.7")
    state.now += 6 * hour
    expect(await check(6)).toBe("2.45.7")
    state.now += hour / 2
    expect(await check(6)).toBe("2.45.7")
    expect(state.reads).toBe(2)
    state.now += hour
    expect(await check(6)).toBe("2.45.7")
    state.now += hour
    expect(await check(6)).toBe("2.46.0")
    expect(state.reads).toBe(4)
  })

  it("shares one read between calls made at the same time", async () => {
    const { state, check } = github(release("2.45.7"))
    expect(await Promise.all([check(6), check(6), check(6)])).toEqual(["2.45.7", "2.45.7", "2.45.7"])
    expect(state.reads).toBe(1)
  })

  it("is unknown until a read succeeds", async () => {
    const { check } = github(() => {
      throw new Error("offline")
    })
    expect(await check(6)).toBeNull()
  })
})
