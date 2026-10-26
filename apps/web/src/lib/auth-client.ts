import { twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { UNREACHABLE_TEXT } from "@/lib/api"
import { sessionEnded } from "@/lib/session"

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient()],
  fetchOptions: {
    // A session the clocks ended goes to sign-in, as with the app's own API. Only this answer: a wrong password
    // or code is a 401 too, and stays on its form.
    onError: ({ error }) => {
      const e = error as { code?: string; reason?: string }
      if (e.code === "SESSION_ENDED") sessionEnded(e.reason)
    },
  },
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
