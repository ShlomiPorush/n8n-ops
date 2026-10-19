import type { Ctx } from "../context.ts"

export type Actor =
  | { kind: "user"; id: string; username: string; twoFactorEnabled: boolean }
  | { kind: "token"; id: string; name: string; tokenKind: "mcp" | "rest"; canRequestAccess: boolean }

export type Env = { Variables: { actor: Actor; ctx: Ctx } }

export function actorName(actor: Actor): string {
  return actor.kind === "user" ? actor.username : tokenActor(actor)
}

/** An agent or token in the audit log: its name, which can repeat, and the start of its id, which cannot. */
export function tokenActor(token: { id: string; name: string }): string {
  return `token:${token.name} #${token.id.slice(0, 8)}`
}
