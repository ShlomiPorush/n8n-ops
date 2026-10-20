import { useEffect, useRef, useState } from "react"
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
  const stored = () => ({
    enabled: agentAccess.enabled,
    scopes: new Set(agentAccess.scopes.filter((s) => keyScopes.includes(s))),
  })
  // `base` is the stored access the form started from; unsaved changes are counted against it.
  const [base, setBase] = useState(stored)
  const [enabled, setEnabled] = useState(base.enabled)
  const [scopes, setScopes] = useState(base.scopes)
  const count =
    Number(enabled !== base.enabled) +
    [...scopes].filter((s) => !base.scopes.has(s)).length +
    [...base.scopes].filter((s) => !scopes.has(s)).length
  const reset = () => {
    const next = stored()
    setBase(next)
    setEnabled(next.enabled)
    setScopes(next.scopes)
  }
  const save = useApiMutation<{ agentAccess: Props["agentAccess"] }>("PATCH", `/instances/${id}`, {
    invalidate: ["/instances", `/instances/${id}`],
  })
  // The stored access as it was when a save finished, until the refetch after it brings the saved value.
  const savedOver = useRef<{ agentAccess: Props["agentAccess"]; keyScopes: string[] } | null>(null)
  // Whenever the card has no unsaved changes, it shows the stored access: after a refetch or a change made
  // elsewhere, and after edits that were changed back by hand. Unsaved changes stay, and Discard brings the
  // stored value. While a save runs the card is locked, so nothing is edited under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the stored access or the count changes
  useEffect(() => {
    if (save.isPending) return
    if (savedOver.current?.agentAccess === agentAccess && savedOver.current.keyScopes === keyScopes) return
    savedOver.current = null
    if (count > 0) return
    const next = stored()
    const same =
      next.enabled === base.enabled &&
      next.scopes.size === base.scopes.size &&
      [...next.scopes].every((s) => base.scopes.has(s))
    if (!same) reset()
  }, [agentAccess, keyScopes, count, save.isPending])
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
  useSaveSource(`agent-access-${id}`, {
    label: "agent access",
    saved: "Agent access saved",
    count,
    save: async () => {
      await save.mutateAsync({ agentAccess: { enabled, scopes: [...scopes] } })
      savedOver.current = { agentAccess, keyScopes }
      setBase({ enabled, scopes: new Set(scopes) })
    },
    discard: reset,
  })

  return (
    <Panel className="overflow-visible">
      <PanelHead
        title="Agent Access"
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
        <fieldset disabled={save.isPending} className="grid min-w-0 gap-4 border-t border-line p-pad-x">
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
        </fieldset>
      )}
    </Panel>
  )
}
