import { Link } from "react-router"
import { Panel, PanelHead, SwitchRow, useSaveSource } from "@/components/kit"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApiMutation } from "@/lib/api"
import { useEdits } from "@/lib/edits"
import { n } from "@/lib/numbers"
import { cn } from "@/lib/utils"

type Props = {
  id: string
  name: string
  /** n8n older than 2.14.0: what the key allows cannot be read, so nothing that needs the API works. */
  unsupported: boolean
  /** What the instance's API key holds; access can never go beyond it. */
  keyScopes: string[]
  agentAccess: Access
  /** When the instance was read. */
  readAt: number
}

type Access = { enabled: boolean; scopes: string[] }

const changes = (a: Access, b: Access) =>
  Number(a.enabled !== b.enabled) +
  a.scopes.filter((s) => !b.scopes.includes(s)).length +
  b.scopes.filter((s) => !a.scopes.includes(s)).length

const readOnly = (s: string) => /:(read|list)$/.test(s)

/** Per instance: whether agents may ask for temporary access, and the most they may ever be granted. */
export function AgentAccessCard({ id, name, unsupported, keyScopes, agentAccess, readAt }: Props) {
  const read: Access = {
    enabled: agentAccess.enabled,
    scopes: agentAccess.scopes.filter((s) => keyScopes.includes(s)),
  }
  // The policy is one value: an edit of it keeps all of it when what is stored changes under it.
  const form = useEdits({ access: read }, readAt, (a, b) => changes(a as Access, b as Access) > 0)
  const access = form.values.access as Access
  const count = changes(access, form.stored.access as Access)
  const save = useApiMutation<{ agentAccess: Access }>("PATCH", `/instances/${id}`, {
    invalidate: ["/instances", `/instances/${id}`],
    quiet: true,
  })
  useSaveSource(`agent-access-${id}`, {
    label: "agent access",
    saved: "Agent access saved",
    count,
    save: async () => {
      await save.mutateAsync({ agentAccess: access })
      form.saved({ access })
    },
    discard: form.discard,
  })

  return (
    <Panel className="overflow-visible">
      <PanelHead
        title="Agent Access"
        description={
          <>
            Agents allowed to request access can ask for temporary access to {name}, within what you allow here. You
            approve every request in{" "}
            <Link to="/access" className="font-semibold text-ink underline">
              Agent Access
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
        <AgentAccessFields
          id={id}
          name={name}
          keyScopes={keyScopes}
          enabled={access.enabled}
          scopes={new Set(access.scopes)}
          onEnabled={(enabled) => form.set("access", { ...access, enabled })}
          onScopes={(scopes) => form.set("access", { ...access, scopes: [...scopes] })}
          // While a save runs the card is locked, so nothing is edited under it.
          disabled={save.isPending}
          className="border-t border-line p-pad-x"
        />
      )}
    </Panel>
  )
}

/**
 * The controls of an instance's Temporary access policy: on or off, and the scopes that may be granted, among those
 * the key holds. The card above saves them through the save bar; the instance setup saves them with its step.
 */
export function AgentAccessFields({
  id,
  name,
  keyScopes,
  enabled,
  scopes,
  onEnabled,
  onScopes,
  disabled,
  className,
}: {
  id: string
  name: string
  keyScopes: string[]
  enabled: boolean
  scopes: Set<string>
  onEnabled: (enabled: boolean) => void
  onScopes: (scopes: Set<string>) => void
  disabled?: boolean
  className?: string
}) {
  const groups = new Map<string, string[]>()
  for (const s of [...keyScopes].sort()) {
    const resource = s.split(":")[0] ?? s
    groups.set(resource, [...(groups.get(resource) ?? []), s])
  }
  const toggle = (s: string, on: boolean) => {
    const next = new Set(scopes)
    if (on) next.add(s)
    else next.delete(s)
    onScopes(next)
  }
  const presets = [
    { value: "read", label: "Read only", scopes: keyScopes.filter(readOnly) },
    { value: "all", label: "Everything the key allows", scopes: keyScopes },
    { value: "none", label: "None", scopes: [] },
  ]
  const matches = (list: string[]) => list.length === scopes.size && list.every((s) => scopes.has(s))
  // When two presets hold the same scopes, None wins, then Everything the key allows.
  const preset = ["none", "all", "read"].find((v) => matches(presets.find((p) => p.value === v)?.scopes ?? [])) ?? ""
  return (
    <fieldset disabled={disabled} className={cn("grid min-w-0 gap-4", className)}>
      <SwitchRow
        id={`agent-access-${id}`}
        title="Agents may request access"
        description={`Off: requests for ${name} are refused before anyone is asked.`}
        checked={enabled}
        onCheckedChange={onEnabled}
      />
      {enabled && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="me-1 text-small font-semibold text-muted-foreground">
              Scopes that may be granted · {n(scopes.size)} of {n(keyScopes.length)}
            </span>
            {/* Shows the preset the selection matches; a selection made by hand matches none of them. */}
            <ToggleGroup
              type="single"
              segmented
              aria-label="Preset"
              value={preset}
              onValueChange={(v) => {
                const next = presets.find((p) => p.value === v)
                if (next) onScopes(new Set(next.scopes))
              }}
            >
              {presets.map((p) => (
                <ToggleGroupItem key={p.value} value={p.value}>
                  {p.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
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
            Only scopes the instance's API key holds are listed. An agent asks for the ones its task needs, and you see
            them before approving.
          </p>
        </div>
      )}
    </fieldset>
  )
}
