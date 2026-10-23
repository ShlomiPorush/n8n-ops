import { twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { UNREACHABLE_TEXT } from "@/lib/api"

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient()],
})

type AuthError = { message?: string; status?: number } | null | undefined

/** Human text for Better Auth errors. An answer without a status never reached the server (FS-23). */
export function authErrorText(error: AuthError): string {
  if (!error) return "Something went wrong."
  if (!error.status) return UNREACHABLE_TEXT
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again."
  return error.message || "Something went wrong."
}

/** The sign-in form's own sentences, by status, so a failure says what to do next (FS-23). */
export function signInErrorText(error: AuthError): string {
  if (error?.status === 401) return "Invalid username or password."
  if (error?.status && error.status >= 500) return "Could not sign in. Try again in a moment."
  return authErrorText(error)
}
