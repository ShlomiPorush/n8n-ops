import { twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient()],
})

/** Human text for Better Auth errors. */
export function authErrorText(error: { message?: string; status?: number } | null | undefined): string {
  if (!error) return "Something went wrong."
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again."
  return error.message || "Something went wrong."
}
