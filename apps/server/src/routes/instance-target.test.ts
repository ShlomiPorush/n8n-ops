import { describe, expect, it } from "vitest"
import { targetProblem } from "../services/instance-update.ts"

// Where an instance's main is, after a change is merged with what is stored: a name, or a whole Compose pair.
describe("targetProblem", () => {
  it("takes a container name, a whole Compose pair, or nothing", () => {
    expect(targetProblem({ containerName: "n8n" })).toBeNull()
    expect(targetProblem({ composeProject: "n8n1", composeService: "app" })).toBeNull()
    expect(targetProblem({})).toBeNull()
  })

  it("refuses half a pair, both kinds at once, and names too long together", () => {
    expect(targetProblem({ composeProject: "n8n1" })).toBe("Give both the Compose project and the service, or neither.")
    expect(targetProblem({ composeService: "app", composeProject: null })).toBe(
      "Give both the Compose project and the service, or neither.",
    )
    expect(targetProblem({ containerName: "n8n", composeProject: "n8n1", composeService: "app" })).toBe(
      "Give a container name or a Compose service, not both.",
    )
    expect(targetProblem({ composeProject: "p".repeat(60), composeService: "s".repeat(61) })).toBe(
      "The Compose project and service names are too long together (at most 120 characters).",
    )
  })
})
