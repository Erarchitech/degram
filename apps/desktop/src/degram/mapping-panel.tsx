// mapping-panel.tsx — the «Mapping» sub-tab under each document of the «Модели» screen (Phase 1303-10, 1303-13; owner
// requests 2026-10-18; data contract 1303-API-CONTRACT.md §3, §7 and §8).
//
// Collapsed by default: nothing is read until the user opens it. Open, it shows the newest mapping session of that
// document: the five-segment progress bar, the LLM status while the background proposal runs, each open proposal as
// its own collapsible section (the first one open) with ONE ROW PER ITEM, the option buttons and «Подробнее», then the
// decisions made, each collapsible with its own «Отменить решение». Every item has a state-coloured chip; a click shows
// it in its CAD application: the Grasshopper canvas selects and zooms to the component, Revit selects the element
// group's members and zooms the active view to them (D-51). A Grasshopper document without a session gets «Запустить
// меппинг» (CONNECTOR reads the canvas). A Revit document always shows the DG Revit connector's sign-in state and a
// start (D-47): «Запустить меппинг», or «Прочитать модель заново» over an existing session. DG answers every answer and
// undo with the recomputed session, which replaces the cached one; failures are named inline, never toasted.

import './mapping.css'

import { type KeyboardEvent, useId, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'

import { scopeKeyOf } from './documents-store'
import type { DegramCopy } from './i18n'
import { type MappingStartOptions, startMapping } from './mapping-api'
import { canContinueAfter, MappingFilters, mappingStartOptions, useMappingFilters } from './mapping-filters'
import { Disclosure, Failure, Muted, SessionView, useMappingFocus } from './mapping-session-view'
import { mappingFailureText } from './mapping-view'
import type { BridgeApp } from './use-degram-gateway'
import { useDegram } from './use-degram-state'
import { useMappingSession } from './use-mapping-session'

type Copy = DegramCopy

/** cmdk's list owns Enter and the arrows; inside the sub-tab they belong to its own buttons, never to a document row. */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation()

/**
 * The DG Revit connector's sign-in state and its start, always shown for a Revit model (D-47): the connector reads the
 * active model's scope (the selection, else the visible model instances) into a new session.
 */
/** An over-limit start (D-124): what was read, what remains, and the start that continues after it. */
interface Continuation {
  options: MappingStartOptions
  read: number
  matched: number
  remaining: number
}

function RevitConnector({
  copy,
  document,
  signedIn,
  message,
  hasSession,
  busy,
  next,
  canContinue,
  onStart
}: {
  copy: Copy
  document: string
  signedIn: boolean | null
  message: null | string
  hasSession: boolean
  busy: boolean
  next: Continuation | null
  canContinue: boolean
  onStart: (options: MappingStartOptions) => void
}) {
  const [filters, setFilters] = useMappingFilters(document)

  return (
    <div className="grid gap-1.5" data-testid="degram-mapping-revit-connector">
      {signedIn === false && <Muted>{copy.mapping.revitSignInFirst}</Muted>}
      {signedIn === true && <Muted>{copy.mapping.revitSignedIn}</Muted>}
      {signedIn !== null && message && <Muted>{message}</Muted>}
      <MappingFilters copy={copy} disabled={busy} onChange={setFilters} state={filters} />
      <div>
        <Button
          disabled={busy}
          onClick={() => onStart(mappingStartOptions(filters))}
          size="sm"
          variant={hasSession ? 'outline' : 'default'}
        >
          {busy ? copy.mapping.starting : hasSession ? copy.mapping.startAgain : copy.mapping.start}
        </Button>
      </div>
      {next && (
        <div className="grid gap-1.5" data-testid="degram-mapping-over-limit" role="status">
          <p className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.4]">
            <Badge variant="warn">{copy.mapping.filters.limit}</Badge>
            <span>{copy.mapping.filters.overLimit(next.read, next.matched, next.remaining)}</span>
          </p>
          <div>
            <Button disabled={busy || !canContinue} onClick={() => onStart(next.options)} size="sm" variant="default">
              {copy.mapping.filters.continue(next.remaining)}
            </Button>
          </div>
          {!canContinue && <Muted>{copy.mapping.filters.continueAfterConfirm}</Muted>}
        </div>
      )}
    </div>
  )
}

function MappingBody({ app, document, open }: { app: BridgeApp; document: string; open: boolean }) {
  const { t, locale } = useI18n()
  const copy = t.degram
  const degram = useDegram()
  const project = degram.state?.scope?.project ?? undefined
  const { state, adopt, follow, reload, following } = useMappingSession(app, document, open, scopeKeyOf(degram))
  const [starting, setStarting] = useState(false)
  const [next, setNext] = useState<Continuation | null>(null)
  const [startNote, setStartNote] = useState<null | { text: string; detail?: string; error?: boolean }>(null)
  const ru = locale.toLowerCase().startsWith('ru')
  const sessionId = state.session?.sessionId ?? null
  const { focus, focusError } = useMappingFocus(app, sessionId, copy, project)

  const start = async (options?: MappingStartOptions) => {
    setStarting(true)
    setStartNote(null)

    try {
      const result = await startMapping(app, app === 'revit' ? options : undefined)

      // D-124: more elements pass the filters than the limit: the next session continues after the last one read
      setNext(
        options && result.started && result.remaining && result.lastElementId !== null
          ? {
              options: { ...options, after: result.lastElementId },
              read: result.read ?? 0,
              matched: result.matched ?? 0,
              remaining: result.remaining
            }
          : null
      )

      if (result.outcome) {
        setStartNote({ text: mappingFailureText(copy, result.outcome, { app, project }), error: true })
      } else if (result.started) {
        // F-10: a leftover Revit selection (a row click selects too) narrows the read; say so loudly, not in grey
        setStartNote(
          result.scope === 'selection'
            ? { text: copy.mapping.startedSelectionOnly(result.read ?? 0), error: true }
            : { text: copy.mapping.started }
        )
        // Revit reads the model again over an existing session: follow until a new one shows.
        follow(sessionId)
      } else {
        setStartNote({
          text: app === 'revit' ? copy.mapping.notStartedRevit : copy.mapping.notStarted,
          detail: result.message ?? undefined,
          error: true
        })
      }
    } catch {
      setStartNote({ text: copy.errors.unknown, error: true })
    } finally {
      setStarting(false)
    }
  }

  if (!open) {
    return null
  }

  if (state.loading && !state.loaded) {
    return (
      <div
        className="flex items-center gap-2 py-1 text-[0.8125rem] text-muted-foreground"
        data-testid="degram-mapping-reading"
      >
        <GlyphSpinner ariaLabel={copy.mapping.reading} className="text-[0.85rem]" spinner="braille" />
        <span>{copy.mapping.reading}</span>
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="flex justify-end">
        <Button aria-label={copy.mapping.refresh} onClick={reload} size="icon-xs" variant="ghost">
          <Codicon name="refresh" size="0.8rem" />
        </Button>
      </div>
      {state.outcome && <Failure text={mappingFailureText(copy, state.outcome, { app, project })} />}
      {app === 'revit' && (
        <RevitConnector
          busy={starting || following}
          canContinue={canContinueAfter(state.session)}
          copy={copy}
          document={document}
          hasSession={Boolean(state.session)}
          message={state.connectorMessage}
          next={next}
          onStart={options => void start(options)}
          signedIn={state.signedIn}
        />
      )}
      {focusError && <Failure text={focusError} />}
      {state.session ? (
        <SessionView
          adopt={adopt}
          app={app}
          copy={copy}
          key={`${scopeKeyOf(degram)}:${app}:${document}:${state.session.sessionId}`}
          onFocus={focus}
          project={project}
          reload={reload}
          ru={ru}
          session={state.session}
        />
      ) : (
        state.loaded &&
        !state.outcome && (
          <div className="grid gap-2" data-testid="degram-mapping-empty">
            <Muted>{app === 'grasshopper' ? copy.mapping.noSession : copy.mapping.noSessionRevit}</Muted>
            {app === 'grasshopper' && (
              <>
                {state.signedIn === false && <Muted>{state.connectorMessage ?? copy.mapping.signInFirst}</Muted>}
                <div>
                  <Button disabled={starting || following} onClick={() => void start()} size="sm" variant="default">
                    {starting || following ? copy.mapping.starting : copy.mapping.start}
                  </Button>
                </div>
              </>
            )}
          </div>
        )
      )}
      {startNote && (startNote.error ? <Failure text={startNote.text} /> : <Muted>{startNote.text}</Muted>)}
      {startNote?.detail && <Muted>{startNote.detail}</Muted>}
    </div>
  )
}

/**
 * The Design State section of one document row (DG 1303-30, D-101; the Mapping sub-tab before): collapsed by default,
 * its own reads only while open. A Design State exists only through a confirmed mapping, so the mapping sits under it.
 */
export function MappingSubtab({ app, document }: { app: BridgeApp; document: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <div
      className="degram-mapping grid gap-1 px-2 pb-2 pl-6"
      data-app={app}
      data-testid="degram-mapping-subtab"
      onKeyDown={keepKeys}
    >
      <Disclosure
        controls={bodyId}
        onToggle={() => setOpen(value => !value)}
        open={open}
        testId="degram-mapping-toggle"
      >
        <span className="font-medium">{t.degram.mapping.tab}</span>
      </Disclosure>
      <div id={bodyId}>
        {open && (
          <div className="grid gap-0.5 pt-1" data-testid="degram-design-state-intro">
            <span className="text-[0.8125rem] font-medium">{t.degram.mapping.section}</span>
            <span className="text-[0.75rem] text-muted-foreground">{t.degram.mapping.stateHint}</span>
          </div>
        )}
        <MappingBody app={app} document={document} open={open} />
      </div>
    </div>
  )
}
