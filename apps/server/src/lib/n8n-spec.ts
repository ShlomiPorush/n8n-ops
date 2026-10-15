import { parse } from "yaml"

/**
 * The scope each n8n public API operation needs, read from the instance's own OpenAPI document
 * (/api/v1/openapi.yml, where every operation carries x-required-scope). Calls through the access proxy
 * are checked against it, so the rules always match the instance's n8n version.
 */
export type SpecOperation = {
  method: string
  /** Path template relative to /api/v1, for example /workflows/{workflowId}. */
  template: string
  pattern: RegExp
  params: string[]
  /**
   * Every scope listed. n8n checks some composite lists inside the handler, depending on the request; the
   * proxy forwards with the instance's own key, so it requires all of them to stay on the safe side.
   */
  scopes: string[]
}

const METHODS = ["get", "post", "put", "patch", "delete"]

export function parseSpec(text: string): SpecOperation[] {
  const doc = parse(text) as { paths?: Record<string, Record<string, { "x-required-scope"?: unknown }>> }
  const ops: SpecOperation[] = []
  for (const [template, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op) continue
      const raw = typeof op["x-required-scope"] === "string" ? op["x-required-scope"] : ""
      const scopes =
        raw === "none"
          ? []
          : raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
      const params: string[] = []
      const source = template
        .split("/")
        .map((part) => {
          const m = part.match(/^\{(.+)\}$/)
          if (!m?.[1]) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          params.push(m[1])
          return "([^/]+)"
        })
        .join("/")
      ops.push({ method: method.toUpperCase(), template, pattern: new RegExp(`^${source}$`), params, scopes })
    }
  }
  // Literal segments win over parameters: /executions/stop before /executions/{executionId}.
  return ops.sort((a, b) => a.params.length - b.params.length || b.template.length - a.template.length)
}

/** Whether the document marks scopes at all (n8n 2.14 and later). Older versions cannot be proxied safely. */
export function specHasScopes(ops: SpecOperation[]): boolean {
  return ops.some((op) => op.scopes.length > 0)
}

export function matchOperation(
  ops: SpecOperation[],
  method: string,
  path: string,
): { op: SpecOperation; params: Record<string, string> } | null {
  const clean = path.replace(/\/+$/, "") || "/"
  for (const op of ops) {
    if (op.method !== method.toUpperCase()) continue
    const m = clean.match(op.pattern)
    if (!m) continue
    const params: Record<string, string> = {}
    op.params.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "")
    })
    return { op, params }
  }
  return null
}
