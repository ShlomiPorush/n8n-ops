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
  /** The query parameters the operation describes, by name. */
  query: string[]
}

const METHODS = ["get", "post", "put", "patch", "delete"]

type Parameter = { $ref?: unknown; name?: unknown; in?: unknown }
type Operation = { "x-required-scope"?: unknown; parameters?: unknown }

export function parseSpec(text: string): SpecOperation[] {
  const doc = parse(text) as {
    paths?: Record<string, Record<string, Operation>>
    components?: { parameters?: Record<string, Parameter> }
  }
  const resolve = (p: Parameter): Parameter | undefined => {
    if (typeof p?.$ref !== "string") return p
    const name = /^#\/components\/parameters\/([^/]+)$/.exec(p.$ref)?.[1]
    return name ? doc.components?.parameters?.[name] : undefined
  }
  const queryOf = (...lists: unknown[]) =>
    lists
      .flatMap((list) => (Array.isArray(list) ? (list as Parameter[]) : []))
      .map(resolve)
      .filter((p) => p?.in === "query" && typeof p.name === "string")
      .map((p) => p?.name as string)
  const ops: SpecOperation[] = []
  for (const [template, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op) continue
      const query = queryOf(item.parameters, op.parameters)
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
      // n8n routes paths without regard to case, so a call is matched the same way; parameter values keep theirs.
      ops.push({
        method: method.toUpperCase(),
        template,
        pattern: new RegExp(`^${source}$`, "i"),
        params,
        scopes,
        query,
      })
    }
  }
  // Literal segments win over parameters: /executions/stop before /executions/{executionId}.
  return ops.sort((a, b) => a.params.length - b.params.length || b.template.length - a.template.length)
}

/** The fields a workflow create accepts, read from the request schema of POST /workflows. */
export type WorkflowFields = { fields: string[]; settings: string[] | null }

type Schema = { $ref?: string; properties?: Record<string, Schema>; readOnly?: boolean; allOf?: Schema[] }

/**
 * The writable top-level fields of a workflow and the keys its settings accept, from the instance's own API
 * description. Null when the document does not describe the request body, so callers send only what every
 * supported version takes.
 */
export function parseWorkflowFields(text: string): WorkflowFields | null {
  const doc = parse(text) as {
    paths?: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: Schema }> } } }>
  }
  const resolve = (schema: Schema | undefined, depth = 0): Schema | undefined => {
    if (!schema || depth > 10) return undefined
    if (schema.$ref?.startsWith("#/")) {
      let node: unknown = doc
      for (const part of schema.$ref.slice(2).split("/")) node = (node as Record<string, unknown> | undefined)?.[part]
      return resolve(node as Schema | undefined, depth + 1)
    }
    if (schema.allOf?.length) {
      const properties: Record<string, Schema> = {}
      for (const part of schema.allOf) Object.assign(properties, resolve(part, depth + 1)?.properties ?? {})
      return { ...schema, properties: { ...properties, ...(schema.properties ?? {}) } }
    }
    return schema
  }
  const body = resolve(doc.paths?.["/workflows"]?.post?.requestBody?.content?.["application/json"]?.schema)
  if (!body?.properties) return null
  const fields = Object.entries(body.properties)
    .filter(([, s]) => !s.readOnly && !resolve(s)?.readOnly)
    .map(([name]) => name)
  const settings = resolve(body.properties.settings)?.properties
  return { fields, settings: settings ? Object.keys(settings) : null }
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
    try {
      op.params.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? "")
      })
    } catch {
      // A malformed escape in a parameter: no operation takes it.
      return null
    }
    return { op, params }
  }
  return null
}

/**
 * The path parameters n8n documents as holding a slash, by the operation's path with its parameters written {} and
 * the parameter's place: a scoped community package name (@scope/package) and a GitLab repository path
 * (group/repo). Every other parameter is one path segment.
 */
const SLASH_PARAMETERS = new Set(["/community-packages/{}#0", "/promotions/providers/{}/repositories/{}/branches#1"])

/** Whether a path parameter value cannot be sent on: characters a server or a proxy may read as path syntax. */
function unsafeParameter(value: string, slashAllowed: boolean) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\\%\u0000-\u001f\u007f]/.test(value)) return true
  if (!slashAllowed) return value.includes("/") || value === "." || value === ".."
  return value.split("/").some((part) => part === "" || part === "." || part === "..")
}

/**
 * The operation a call is for, with the path n8n-ops sends to n8n: the operation's own template with each parameter
 * written out again. Null when the call is no operation, when a parameter holds a value that cannot be sent on
 * unchanged, or when the written-out path would be another operation or other values (n8n is sent exactly the
 * operation that was checked).
 */
export function operationToForward(ops: SpecOperation[], method: string, path: string) {
  const match = matchOperation(ops, method, path)
  if (!match) return null
  const value = (name: string) => match.params[name] ?? ""
  const shape = match.op.template.replace(/\{[^}]*\}/g, "{}").toLowerCase()
  if (match.op.params.some((name, i) => unsafeParameter(value(name), SLASH_PARAMETERS.has(`${shape}#${i}`))))
    return null
  const forward = match.op.template.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(value(name)))
  const again = matchOperation(ops, method, forward)
  if (again?.op !== match.op || match.op.params.some((name) => again.params[name] !== value(name))) return null
  return { ...match, path: forward }
}
