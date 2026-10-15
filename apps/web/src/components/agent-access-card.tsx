import { Bot } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useApiMutation } from "@/lib/api"

type Props = {
  id: string
  name: string
  scopesSource: "discovered" | "declared"
  /** What the instance's API key holds; access can never go beyond it. */
  keyScopes: string[]
  agentAccess: { enabled: boolean; scopes: string[] }
}

const readOnly = (s: string) => /:(read|list)$/.test(s)

/** Per instance: whether agents may ask for temporary access, and the most they may ever be granted. */
export function AgentAccessCard({ id, name, scopesSource, keyScopes, agentAccess }: Props) {
  const [enabled, setEnabled] = useState(agentAccess.enabled)
  const [scopes, setScopes] = useState(new Set(agentAccess.scopes.filter((s) => keyScopes.includes(s))))
  useEffect(() => {
    setEnabled(agentAccess.enabled)
    setScopes(new Set(agentAccess.scopes.filter((s) => keyScopes.includes(s))))
  }, [agentAccess, keyScopes])
  const save = useApiMutation<{ agentAccess: Props["agentAccess"] }>("PATCH", `/instances/${id}`, {
    invalidate: ["/instances", `/instances/${id}`],
    success: "Agent access saved",
  })
  const groups = new Map<string, string[]>()
  for (const s of [...keyScopes].sort()) {
    const resource = s.split(":")[0] ?? s
    groups.set(resource, [...(groups.get(resource) ?? []), s])
  }
  const toggle = (s: string, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev)
      if (on) next.add(s)
      else next.delete(s)
      return next
    })
  const unsupported = scopesSource === "declared"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" /> Agent access
        </CardTitle>
        <CardDescription>
          Agents with a token that may request access can ask for temporary access to {name}, within what you allow
          here. You approve every request in <Link to="/access">Agent access</Link>, and it ends on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {unsupported ? (
          <p className="text-sm text-muted-foreground">
            Needs n8n 2.14 or later: n8n-ops checks every call against the scopes n8n declares for its API.
          </p>
        ) : (
          <>
            <Field orientation="horizontal">
              <Switch id={`agent-access-${id}`} checked={enabled} onCheckedChange={setEnabled} />
              <FieldContent>
                <FieldLabel htmlFor={`agent-access-${id}`}>Agents may request access</FieldLabel>
                <FieldDescription>Off: requests for {name} are refused before anyone is asked.</FieldDescription>
              </FieldContent>
            </Field>
            {enabled && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Scopes that may be granted</span>
                  <Button size="sm" variant="outline" onClick={() => setScopes(new Set(keyScopes.filter(readOnly)))}>
                    Read only
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setScopes(new Set(keyScopes))}>
                    Everything the key allows
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setScopes(new Set())}>
                    None
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {[...groups].map(([resource, list]) => (
                    <div key={resource} className="space-y-1.5 rounded-md border p-3">
                      <div className="text-xs font-medium text-muted-foreground">{resource}</div>
                      {list.map((s) => (
                        <div key={s} className="flex items-center gap-2">
                          <Checkbox
                            id={`scope-${id}-${s}`}
                            aria-label={s}
                            checked={scopes.has(s)}
                            onCheckedChange={(v) => toggle(s, v === true)}
                          />
                          <label htmlFor={`scope-${id}-${s}`} className="font-mono text-xs">
                            {s.slice(resource.length + 1)}
                          </label>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Only scopes the instance's API key holds are listed. An agent asks for the ones its task needs, and
                  you see them before approving.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
      {!unsupported && (
        <CardFooter className="border-t">
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({ agentAccess: { enabled, scopes: [...scopes] } })}
          >
            Save agent access
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
