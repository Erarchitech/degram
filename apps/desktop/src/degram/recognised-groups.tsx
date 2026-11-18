// recognised-groups.tsx — the «Распознано» section of the mapping panel (DG plan 1303-36, D-140, D-141).
//
// Groups a stored profile already mapped on its own are not asked about, so a class a past confirmation taught wrongly
// stayed invisible. This lists them, lets the owner show a group in Revit and change its class for the whole group. The
// change is a DRAFT answer DG records (it joins the existing answers with their Undo and the shared confirmation); nothing
// is written to the model or to a profile until that explicit confirmation. Not an agent action, not a proof flag.

import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'

import type { DegramCopy } from './i18n'
import {
  type MappingItem,
  MappingRefusal,
  type MappingSession,
  reclassifyMappingGroup,
  type RecognisedGroup,
  type SessionResult
} from './mapping-api'
import { itemShowable, mappingFailureText } from './mapping-view'
import type { BridgeApp, OutcomeInfo } from './use-degram-gateway'
import { environmentStamp, isCurrentEnvironment } from './use-degram-state'

interface Target {
  app: BridgeApp
  onFocus: (item: MappingItem) => void
}

/** The group as the shared «Показать» handler reads a row: a Revit element group (stream) named by its group id. */
const groupItem = (group: RecognisedGroup, title: string): MappingItem => ({
  itemId: group.groupId,
  kind: 'stream',
  name: title,
  componentId: null,
  count: group.size,
  proposal: group.classes[0] ?? null,
  alternatives: [],
  state: 'auto'
})

export function RecognisedGroupsSection({
  session,
  copy,
  ru,
  target,
  adopt,
  busy,
  project
}: {
  session: MappingSession
  copy: DegramCopy
  ru: boolean
  target: Target
  adopt: (session: MappingSession) => void
  busy: boolean
  project?: string
}) {
  const text = copy.mapping.recognised
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<null | string>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const generation = useRef(0)
  const identity = `${session.sessionId}:${session.revision}`
  const seen = useRef(identity)

  // A changed session (another revision, an answer, an undo) invalidates a reply still in flight and closes the picker.
  if (seen.current !== identity) {
    seen.current = identity
    generation.current++
  }

  const group = session.recognised.find(g => g.groupId === editing) ?? null
  const needle = query.trim().toLowerCase()

  const options = useMemo(
    () => session.recognisedClasses.filter(c => !needle || c.label.toLowerCase().includes(needle)),
    [session.recognisedClasses, needle]
  )

  if (session.recognised.length === 0) {
    return null
  }

  const currentIris = group ? group.classes.map(c => c.iri).sort() : []
  const picked = [...chosen].sort()
  const unchanged = picked.length === currentIris.length && picked.every((iri, i) => iri === currentIris[i])
  const bodyId = `degram-recognised-${session.sessionId}`

  const start = (g: RecognisedGroup) => {
    generation.current++
    setEditing(g.groupId)
    setChosen(g.classes.map(c => c.iri))
    setQuery('')
    setError(null)
  }

  const stop = () => {
    generation.current++
    setEditing(null)
    setError(null)
  }

  const toggle = (iri: string) => setChosen(list => (list.includes(iri) ? list.filter(x => x !== iri) : [...list, iri]))

  const apply = async () => {
    if (!group || picked.length === 0 || unchanged || pending) {
      return
    }

    const gen = ++generation.current
    const stamp = environmentStamp()
    const current = () => generation.current === gen && isCurrentEnvironment(stamp)
    setPending(true)
    setError(null)

    try {
      const result: SessionResult = await reclassifyMappingGroup(session.sessionId, group.groupId, picked)

      if (!current()) {
        return
      }

      if (result.outcome) {
        setError(mappingFailureText(copy, result.outcome, { app: target.app, project }))
      } else {
        setEditing(null)
        adopt(result.session)
      }
    } catch (failure) {
      if (!current()) {
        return
      }

      const outcome: OutcomeInfo =
        failure instanceof MappingRefusal ? { code: failure.code, message: failure.message } : { code: 'DG_UNAVAILABLE' }

      setError(mappingFailureText(copy, outcome, { app: target.app, project }) || text.failed)
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="grid gap-1" data-testid="degram-recognised">
      <button
        aria-controls={open ? bodyId : undefined}
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-1 text-left text-[0.8125rem] leading-[1.4]"
        data-testid="degram-recognised-toggle"
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <DisclosureCaret open={open} />
        <span className="font-medium">{text.title(session.recognised.length)}</span>
      </button>
      {open && (
        <div className="grid gap-2 pl-4" id={bodyId}>
          <p className="text-[0.75rem] leading-[1.4] text-muted-foreground">{text.hint}</p>
          <ul className="grid gap-2">
            {session.recognised.map(g => {
              const title = ru ? g.titleRu : g.title
              const showable = itemShowable(target.app, groupItem(g, title))
              const sources = [...new Set(g.profiles.map(p => (p.source === 'authored' ? text.source.authored : text.source.learned)))]

              return (
                <li className="grid gap-1" data-recognised-group={g.groupId} key={g.groupId}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.4]">
                    <span className="truncate font-medium">{title}</span>
                    <span className="font-mono text-[0.75rem] text-muted-foreground">{text.elements(g.size)}</span>
                    <span>{'→ '}<span className="font-medium">{g.classes.map(c => c.label).join(', ')}</span></span>
                    <span className="text-[0.75rem] text-muted-foreground">{sources.join(', ')}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {target.app === 'revit' && (
                      <Button
                        data-testid="degram-recognised-show"
                        disabled={!showable}
                        onClick={() => target.onFocus(groupItem(g, title))}
                        size="xs"
                        variant="outline"
                      >
                        {text.show}
                      </Button>
                    )}
                    <Button
                      data-testid="degram-recognised-change"
                      disabled={busy || pending}
                      onClick={() => start(g)}
                      size="xs"
                      variant="outline"
                    >
                      {text.change}
                    </Button>
                  </div>
                  {editing === g.groupId && (
                    <div className="grid gap-1.5 rounded-md border border-border p-2" data-testid="degram-recognised-picker">
                      <input
                        aria-label={text.search}
                        className="h-7 min-w-0 rounded-md border border-input bg-transparent px-2 text-[0.8125rem]"
                        data-testid="degram-recognised-search"
                        onChange={event => setQuery(event.target.value)}
                        placeholder={text.search}
                        type="search"
                        value={query}
                      />
                      <ul className="grid max-h-40 gap-0.5 overflow-y-auto">
                        {options.length === 0 && <li className="text-[0.75rem] text-muted-foreground">{text.noMatch}</li>}
                        {options.map(c => (
                          <li key={c.iri}>
                            <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
                              <input
                                checked={chosen.includes(c.iri)}
                                data-testid="degram-recognised-class"
                                disabled={pending}
                                onChange={() => toggle(c.iri)}
                                type="checkbox"
                                value={c.iri}
                              />
                              <span>{c.label}</span>
                              {currentIris.includes(c.iri) && (
                                <span className="text-[0.75rem] text-muted-foreground">({text.current})</span>
                              )}
                            </label>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          data-testid="degram-recognised-apply"
                          disabled={pending || picked.length === 0 || unchanged}
                          onClick={() => void apply()}
                          size="xs"
                        >
                          {text.apply}
                        </Button>
                        <Button data-testid="degram-recognised-cancel" disabled={pending} onClick={stop} size="xs" variant="outline">
                          {text.cancel}
                        </Button>
                      </div>
                      {error && (
                        <p className="text-[0.75rem] leading-[1.4] text-destructive" role="alert">
                          {error}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
