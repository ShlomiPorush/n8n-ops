export function passkeyBlock(at: string | null | undefined): string | null {
  if (!at) return "Passkeys need a public URL. Set one under Settings > General."
  const host = new URL(at).hostname
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("["))
    return "Passkeys need a public URL with a domain name, not an IP address. Change it under Settings > General."
  if (window.location.origin !== at) return `Passkeys work at ${at}. Open n8n-ops there to use them.`
  if (!window.isSecureContext || typeof window.PublicKeyCredential === "undefined")
    return "This browser cannot use passkeys on this page. Passkeys need HTTPS."
  return null
}

export const passkeyCancelled = (code: string | undefined) =>
  code === "AUTH_CANCELLED" || code === "ERROR_CEREMONY_ABORTED" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"
