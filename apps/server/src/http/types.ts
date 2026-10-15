import type { Ctx } from "../context.ts"

export type Actor =
  | { kind: "user"; id: string; username: string; twoFactorEnabled: boolean }
  | { kind: "token"; id: string; name: string; tokenKind: "mcp" | "rest"; canRequestAccess: boolean }

export type Env = { Variables: { actor: Actor; ctx: Ctx } }

export function actorName(actor: Actor): string {
  return actor.kind === "user" ? actor.username : `token:${actor.name}`
}
