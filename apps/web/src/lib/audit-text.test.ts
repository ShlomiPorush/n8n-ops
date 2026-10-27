import { describe, expect, it } from "vitest"
import { auditAction, auditTarget } from "./audit-text"

describe("audit entries in today's words", () => {
  it("shows the stored actions of access requests and tokens in today's words", () => {
    expect(auditAction("Instance access requested")).toBe("Access requested")
    expect(auditAction("Instance access approved")).toBe("Access request approved")
    expect(auditAction("Instance access denied")).toBe("Access request denied")
    expect(auditAction("Instance access revoked")).toBe("Access request revoked")
    expect(auditAction("Instance access released")).toBe("Access request released")
    expect(auditAction("API token created")).toBe("Token created")
    expect(auditAction("API token revoked")).toBe("Token revoked")
  })

  it("shows any other action as stored", () => {
    expect(auditAction("Login")).toBe("Login")
    expect(auditAction("Instance removed")).toBe("Instance removed")
  })

  it("rewrites what a token may do, and leaves other targets alone", () => {
    expect(auditTarget("ci (agent, may request instance access)")).toBe(
      "ci (agent, may request access to n8n instances)",
    )
    expect(auditTarget("claude (through the browser, may request instance access)")).toBe(
      "claude (through the browser, may request access to n8n instances)",
    )
    expect(auditTarget("x, may request instance access) (agent)")).toBe("x, may request instance access) (agent)")
    expect(auditTarget("ci (agent)")).toBe("ci (agent)")
    expect(auditTarget("n8n-1")).toBe("n8n-1")
  })
})
