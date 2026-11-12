// mapping-chat-card.tsx — the mapping card a degram_mapping call shows in a DeGram chat (DG 1303-33, D-118, D-119).
//
// It renders the session through the same SessionView as «Модели → Mapping»: questions with their class options, the
// row chips that show a group in Revit or Grasshopper, undo, the agent's marks (D-121) and the shared confirmation
// with the Design State name. The agent can only propose answers; the batch is committed by the user's click here, on
// the panel's own requestId / revision / answerIds path. A card from another project shows a neutral notice and no
// actions, so a left project's session is never answered or confirmed from an old chat.

import { useThreadRuntime } from '@assistant-ui/react'
import { useEffect, useRef, useState } from 'react'

import { parseMaybeObject } from '@/components/assistant-ui/tool/fallback-model/format'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { scopeKeyOf } from './documents-store'
import { type MappingStartOptions, startMapping } from './mapping-api'
import { canContinueAfter } from './mapping-filters'
import { Failure, Muted, SessionView, useMappingFocus } from './mapping-session-view'
import { mappingFailureText } from './mapping-view'
import type { BridgeApp } from './use-degram-gateway'
import { environmentStamp, isCurrentEnvironment, useDegram } from './use-degram-state'
import { useMappingSessionById } from './use-mapping-session'

/** An over-limit start (D-124): the start that continues after it, and what the last one read. */
export interface MappingCardNext {
  options: MappingStartOptions
  read: number
  matched: number
  remaining: number
}

export interface MappingCardAnchor {
  app: BridgeApp
  sessionId: string
  /** The project the tool call ran in; null when the result did not name it. */
  project: null | string
  next?: MappingCardNext | null
}

const whole = (value: unknown): null | number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

function nextOf(raw: unknown): MappingCardNext | null {
  const next = parseMaybeObject(raw)
  const after = whole(next.after)
  const remaining = whole(next.remaining)
  const limit = whole(next.limit)

  if (after === null || !remaining || !limit) {
    return null
  }

  return {
    options: { filters: parseMaybeObject(next.filters) as MappingStartOptions['filters'], limit, after },
    read: whole(next.read) ?? 0,
    matched: whole(next.matched) ?? 0,
    remaining
  }
}

/** The session a degram_mapping result points the card at, or null (no session yet, a refusal, a malformed result). */
export function mappingCardAnchor(result: unknown): MappingCardAnchor | null {
  const card = parseMaybeObject(parseMaybeObject(result).card)
  const app = card.app
  const sessionId = card.sessionId

  if ((app !== 'revit' && app !== 'grasshopper') || typeof sessionId !== 'string' || !sessionId) {
    return null
  }

  return {
    app,
    sessionId,
    project: typeof card.project === 'string' && card.project ? card.project : null,
    next: nextOf(card.next)
  }
}

const SHELL = cn(WIDGET_SHELL_CLASS, 'degram-mapping grid gap-2')

function SessionCard({ anchor, scopeKey, project }: { anchor: MappingCardAnchor; scopeKey: string; project?: string }) {
  // A continuation (D-124) starts the next session; the card then follows that one
  const [current, setCurrent] = useState({ sessionId: anchor.sessionId, next: anchor.next ?? null })

  return (
    <SessionCardBody
      anchor={anchor}
      current={current}
      key={current.sessionId}
      onNext={setCurrent}
      project={project}
      scopeKey={scopeKey}
    />
  )
}

function SessionCardBody({
  anchor,
  current,
  onNext,
  scopeKey,
  project
}: {
  anchor: MappingCardAnchor
  current: { sessionId: string; next: MappingCardNext | null }
  onNext: (next: { sessionId: string; next: MappingCardNext | null }) => void
  scopeKey: string
  project?: string
}) {
  const { t, locale } = useI18n()
  const copy = t.degram
  const thread = useThreadRuntime({ optional: true })
  const { state, adopt, reload } = useMappingSessionById(current.sessionId, scopeKey)
  const { focus, focusError } = useMappingFocus(anchor.app, current.sessionId, copy, project)
  const ru = locale.toLowerCase().startsWith('ru')
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<null | string>(null)
  const [clarifyBusy, setClarifyBusy] = useState(false)
  const lifetime = useRef({ mounted: true, generation: 0, active: false })
  // Continuations belong to this mounted session card, not a later card/environment.

  useEffect(() => {
    const live = lifetime.current
    live.mounted = true

    return () => { live.mounted = false; live.generation++ }
  }, [])

  const continueMapping = async (next: MappingCardNext) => {
    if (lifetime.current.active) {return}
    lifetime.current.active = true
    const generation = ++lifetime.current.generation
    const stamp = environmentStamp()
    const valid = () => lifetime.current.mounted && lifetime.current.generation === generation && isCurrentEnvironment(stamp)
    setContinuing(true)
    setContinueError(null)

    try {
      const result = await startMapping('revit', next.options)

      if (!valid()) {return}

      if (result.outcome) {
        setContinueError(mappingFailureText(copy, result.outcome, { app: anchor.app, project }))
      } else if (result.started && result.sessionId) {
        onNext({
          sessionId: result.sessionId,
          next:
            result.remaining && result.lastElementId !== null
              ? {
                  options: { ...next.options, after: result.lastElementId },
                  read: result.read ?? 0,
                  matched: result.matched ?? 0,
                  remaining: result.remaining
                }
              : null
        })
      } else {
        setContinueError(result.message ?? copy.mapping.notStartedRevit)
      }
    } catch {
      if (valid()) {setContinueError(copy.errors.unknown)}
    } finally {
      lifetime.current.active = false

      if (valid()) {setContinuing(false)}
    }
  }

  return (
    <div className={SHELL} data-app={anchor.app} data-testid="degram-mapping-chat-card">
      <span className="text-[0.8125rem] font-medium">
        {copy.mapping.chatCard.title}
        {state.session?.label ? ` · ${state.session.label}` : ''}
      </span>
      {state.loading && !state.loaded && (
        <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
          <GlyphSpinner ariaLabel={copy.mapping.chatCard.reading} className="text-[0.85rem]" spinner="braille" />
          <span>{copy.mapping.chatCard.reading}</span>
        </p>
      )}
      {state.outcome && <Failure text={mappingFailureText(copy, state.outcome, { app: anchor.app, project })} />}
      {focusError && <Failure text={focusError} />}
      {clarifyBusy && <Muted>{copy.mapping.advanced.clarifyBusy}</Muted>}
      {current.next && (
        <div className="grid gap-1.5" data-testid="degram-mapping-over-limit" role="status">
          <p className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.4]">
            <Badge variant="warn">{copy.mapping.filters.limit}</Badge>
            <span>
              {copy.mapping.filters.overLimit(current.next.read, current.next.matched, current.next.remaining)}
            </span>
          </p>
          <div>
            <Button
              disabled={continuing || !canContinueAfter(state.session)}
              onClick={() => current.next && void continueMapping(current.next)}
              size="sm"
            >
              {copy.mapping.filters.continue(current.next.remaining)}
            </Button>
          </div>
          {!canContinueAfter(state.session) && <Muted>{copy.mapping.filters.continueAfterConfirm}</Muted>}
          {continueError && <Failure text={continueError} />}
        </div>
      )}
      {state.session && (
        <SessionView
          adopt={adopt}
          app={anchor.app}
          copy={copy}
          key={`${scopeKey}:${current.sessionId}`}
          onClarify={thread ? text => {
            if (thread.getState().isRunning) {
              setClarifyBusy(true)

              return
            }

            setClarifyBusy(false)
            thread.append({ role: 'user', content: [{ type: 'text', text }] })
          } : undefined}
          onFocus={focus}
          project={project}
          reload={reload}
          ru={ru}
          session={state.session}
        />
      )}
    </div>
  )
}

export function MappingChatCard({ anchor }: { anchor: MappingCardAnchor }) {
  const { t } = useI18n()
  const degram = useDegram()
  const scopeKey = scopeKeyOf(degram)
  const project = degram.state?.scope?.project ?? undefined

  if (!scopeKey || (anchor.project !== null && anchor.project !== project)) {
    return (
      <div className={SHELL} data-testid="degram-mapping-chat-card-elsewhere">
        <Muted>{t.degram.mapping.chatCard.otherProject(anchor.project ?? '—')}</Muted>
      </div>
    )
  }

  return <SessionCard anchor={anchor} key={`${scopeKey}:${anchor.sessionId}`} project={project} scopeKey={scopeKey} />
}
