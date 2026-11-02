/**
 * Why passkeys cannot be used on this page, or null when they can. `at` is the address they work at, from
 * /api/setup/status (null: no public URL is in effect). A passkey belongs to that address's host name, and
 * browsers offer passkeys only on HTTPS (or localhost).
 */
export function passkeyBlock(at: string | null | undefined): string | null {
  if (!at) return "Passkeys need a public URL. Set one under Settings > General."
  // A passkey belongs to a domain name; browsers refuse an IP address for it (an IPv6 one keeps its brackets).
  const host = new URL(at).hostname
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("["))
    return "Passkeys need a public URL with a domain name, not an IP address. Change it under Settings > General."
  if (window.location.origin !== at) return `Passkeys work at ${at}. Open n8n-ops there to use them.`
  if (!window.isSecureContext || typeof window.PublicKeyCredential === "undefined")
    return "This browser cannot use passkeys on this page. Passkeys need HTTPS."
  return null
}

/**
 * The answers for a passkey prompt that was closed, refused or timed out (the browser does not tell these apart),
 * so the text says that instead of a technical message.
 */
export const passkeyCancelled = (code: string | undefined) =>
  code === "AUTH_CANCELLED" || code === "ERROR_CEREMONY_ABORTED" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"
