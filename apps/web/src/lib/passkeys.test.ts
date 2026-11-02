import { afterEach, describe, expect, it, vi } from "vitest"
import { passkeyBlock } from "./passkeys"

// Stands for the browser's WebAuthn interface; only its presence matters.
const webAuthn = class {}

/** A page open at `origin`, in a browser that offers passkeys when the page is secure. */
function openAt(origin: string, secure = true) {
  vi.stubGlobal("window", { location: { origin }, isSecureContext: secure, PublicKeyCredential: webAuthn })
}

afterEach(() => vi.unstubAllGlobals())

describe("passkeyBlock", () => {
  it("allows passkeys on a secure page at the public URL", () => {
    openAt("https://ops.example.com")
    expect(passkeyBlock("https://ops.example.com")).toBeNull()
  })

  it("says a public URL is needed when none is in effect", () => {
    openAt("https://ops.example.com")
    expect(passkeyBlock(null)).toMatch(/need a public URL/)
  })

  it.each(["https://10.0.0.5", "https://10.0.0.5:8443", "https://[2001:db8::1]"])(
    "refuses a public URL with an IP address (%s), which browsers do not take for a passkey",
    (at) => {
      openAt(at)
      expect(passkeyBlock(at)).toMatch(/domain name, not an IP address/)
    },
  )

  it("sends the person to the public URL from another address", () => {
    openAt("http://10.0.0.5:8080")
    expect(passkeyBlock("https://ops.example.com")).toBe(
      "Passkeys work at https://ops.example.com. Open n8n-ops there to use them.",
    )
  })

  it("says passkeys need HTTPS on a page that is not secure", () => {
    openAt("http://ops.example.com", false)
    expect(passkeyBlock("http://ops.example.com")).toMatch(/need HTTPS/)
  })
})
