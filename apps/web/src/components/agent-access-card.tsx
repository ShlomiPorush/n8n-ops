import { useEffect, useState } from "react"
import { Link } from "react-router"
import { Panel, PanelHead, SwitchRow, useSaveSource } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useApiMutation } from "@/lib/api"
import { n } from "@/lib/time"

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
  const initialScopes = () => new Set(agentAccess.scopes.filter((s) => keyScopes.includes(s)))
  const [enabled, setEnabled] = useState(agentAccess.enabled)
  const [scopes, setScopes] = useState(initialScopes)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the stored access changes
  useEffect(() => {
    setEnabled(agentAccess.enabled)
    setScopes(initialScopes())
  }, [agentAccess, keyScopes])
  const save = useApiMutation<{ agentAccess: Props["agentAccess"] }>("PATCH", `/instances/${id}`, {
    invalidate: ["/instances", `/instances/${id}`],
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
  const stored = initialScopes()
  const count =
    Number(enabled !== agentAccess.enabled) +
    [...scopes].filter((s) => !stored.has(s)).length +
    [...stored].filter((s) => !scopes.has(s)).length
  useSaveSource(`agent-access-${id}`, {
    label: "agent access",
    saved: "Agent access saved",
    count,
    save: () => save.mutateAsync({ agentAccess: { enabled, scopes: [...scopes] } }),
    discard: () => {
      setEnabled(agentAccess.enabled)
      setScopes(initialScopes())
    },
  })

  return (
    <Panel className="overflow-visible">
      <PanelHead
        title="Agent access"
        description={
          <>
            Agents with a token that may request access can ask for temporary access to {name}, within what you allow
            here. You approve every request in{" "}
            <Link to="/access" className="font-semibold text-ink underline">
              Agent access
            </Link>
            , and it ends on its own.
          </>
        }
      />
      {unsupported ? (
        <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
          Needs n8n 2.14 or later: n8n-ops checks every call against the scopes n8n declares for its API.
        </p>
      ) : (
        <div className="grid gap-4 border-t border-line p-pad-x">
          <SwitchRow
            id={`agent-access-${id}`}
            title="Agents may request access"
            description={`Off: requests for ${name} are refused before anyone is asked.`}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          {enabled && (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="me-1 text-small font-semibold text-muted-foreground">
                  Scopes that may be granted · {n(scopes.size)} of {n(keyScopes.length)}
                </span>
                <Button size="sm" onClick={() => setScopes(new Set(keyScopes.filter(readOnly)))}>
                  Read only
                </Button>
                <Button size="sm" onClick={() => setScopes(new Set(keyScopes))}>
                  Everything the key allows
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setScopes(new Set())}>
                  None
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                {[...groups].map(([resource, list]) => (
                  <div key={resource} className="grid content-start gap-1.5 rounded-sm bg-bg p-3">
                    <div className="text-small font-semibold text-muted-foreground">{resource}</div>
                    {list.map((s) => (
                      <div key={s} className="flex items-center gap-2">
                        <Checkbox
                          id={`scope-${id}-${s}`}
                          aria-label={s}
                          checked={scopes.has(s)}
                          onCheckedChange={(v) => toggle(s, v === true)}
                        />
                        <label htmlFor={`scope-${id}-${s}`} className="font-mono text-small">
                          {s.slice(resource.length + 1)}
                        </label>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <p className="text-small text-muted-foreground">
                Only scopes the instance's API key holds are listed. An agent asks for the ones its task needs, and you
                see them before approving.
              </p>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
