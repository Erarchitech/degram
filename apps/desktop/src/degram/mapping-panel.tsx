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

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'

import { scopeKeyOf } from './documents-store'
import type { DegramCopy } from './i18n'
import {
  answerMapping,
  applyMapping,
  focusComponent,
  type MappingAnswer,
  type MappingCommitIntent,
  type MappingItem,
  type MappingQuestion,
  MappingRefusal,
  type MappingSession,
  type MappingSummary,
  pendingMappingAnswers,
  type SessionResult,
  showRevitItem,
  startMapping,
  undoMappingAnswer
} from './mapping-api'
import {
  itemChipLabel,
  itemShowable,
  kindLabel,
  mappingFailureText,
  optionText,
  progressSegments,
  questionText,
  questionTitle,
  sessionLabels,
  typeLabel
} from './mapping-view'
import type { BridgeApp, OutcomeInfo } from './use-degram-gateway'
import { useDegram } from './use-degram-state'
import { useMappingSession } from './use-mapping-session'

type Copy = DegramCopy

/** cmdk's list owns Enter and the arrows; inside the sub-tab they belong to its own buttons, never to a document row. */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation()

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[0.75rem] leading-[1.4] text-muted-foreground">{children}</p>
}

function Failure({ text }: { text: string }) {
  return (
    <p className="text-[0.75rem] leading-[1.4] text-destructive" role="alert">
      {text}
    </p>
  )
}

function Disclosure({
  open,
  onToggle,
  controls,
  children,
  testId
}: {
  open: boolean
  onToggle: () => void
  controls: string
  children: ReactNode
  testId?: string
}) {
  return (
    <button
      aria-controls={open ? controls : undefined}
      aria-expanded={open}
      className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-1 text-left text-[0.8125rem] leading-[1.4]"
      data-testid={testId}
      onClick={onToggle}
      type="button"
    >
      <DisclosureCaret open={open} />
      {children}
    </button>
  )
}

function MappingProgress({ copy, summary }: { copy: Copy; summary: MappingSummary }) {
  const segments = progressSegments(summary)

  return (
    <div className="grid gap-1.5" data-testid="degram-mapping-progress">
      <div
        aria-label={copy.mapping.progressLabel}
        className="flex h-2 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)"
        role="img"
      >
        {segments
          .filter(segment => segment.percent > 0)
          .map(segment => (
            <span
              className="degram-mapping-fill h-full"
              data-mapping-state={segment.state}
              data-testid={`degram-mapping-segment-${segment.state}`}
              key={segment.state}
              style={{ width: `${segment.percent}%` }}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[0.75rem] leading-[1.4] text-muted-foreground">
        {segments.map(segment => (
          <li className="inline-flex items-center gap-1" data-mapping-state={segment.state} key={segment.state}>
            <span aria-hidden className="degram-mapping-fill inline-block size-1.5 rounded-full" />
            <span>{copy.mapping.states[segment.state]}</span>
            <span className="font-mono text-foreground">{segment.count}</span>
          </li>
        ))}
      </ul>
      <Muted>
        {copy.mapping.total(summary.total)} · {copy.mapping.openQuestions(summary.openQuestions)}
      </Muted>
    </div>
  )
}

/** How a row's chip shows it in the CAD application the document belongs to. */
interface ShowTarget {
  app: BridgeApp
  onFocus: (item: MappingItem) => void
}

/** One proposed item on its own row: chip (click → CAD application), kind, → proposal, count, alternatives. */
function ItemRow({ copy, item, target }: { copy: Copy; item: MappingItem; target: ShowTarget }) {
  const kind = kindLabel(copy.mapping, item.kind)
  const showable = itemShowable(target.app, item)

  const amount =
    item.count === null
      ? ''
      : item.kind === 'measure'
        ? copy.mapping.values(item.count)
        : copy.mapping.elements(item.count)

  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.4]"
      data-mapping-item={item.itemId}
    >
      <button
        aria-label={itemChipLabel(copy.mapping, target.app, item)}
        className="degram-mapping-chip"
        data-mapping-state={item.state}
        data-testid="degram-mapping-chip"
        disabled={!showable}
        onClick={() => target.onFocus(item)}
        type="button"
      >
        <span className="truncate">{item.name}</span>
      </button>
      {kind && <span className="text-[0.75rem] text-muted-foreground">{kind}</span>}
      <span>
        {'→ '}
        {item.proposal ? (
          <span className="font-medium">{item.proposal.label}</span>
        ) : (
          <span className="text-muted-foreground">{copy.mapping.noProposal}</span>
        )}
      </span>
      {amount && <span className="font-mono text-[0.75rem] text-muted-foreground">{amount}</span>}
      {item.alternatives.length > 0 && (
        <span className="text-[0.75rem] text-muted-foreground">
          {copy.mapping.alternatives(item.alternatives.map(alt => alt.label).join(', '))}
        </span>
      )}
    </li>
  )
}

function Items({ copy, items, target }: { copy: Copy; items: MappingItem[]; target: ShowTarget }) {
  return (
    <ul className="grid gap-1.5">
      {items.map(item => (
        <ItemRow copy={copy} item={item} key={item.itemId} target={target} />
      ))}
    </ul>
  )
}

interface CardProps {
  copy: Copy
  ru: boolean
  labels: Map<string, string>
  expanded: boolean
  onToggle: () => void
  busy: boolean
  error: null | string
  target: ShowTarget
}

function ProposalCard({
  copy,
  ru,
  labels,
  question,
  expanded,
  onToggle,
  busy,
  sending,
  error,
  onAnswer,
  target
}: CardProps & {
  question: MappingQuestion
  sending: boolean
  onAnswer: (question: MappingQuestion, optionId: string) => void
}) {
  const bodyId = useId()
  const [details, setDetails] = useState(false)
  const heading = questionTitle(question, ru)
  const text = questionText(question, ru)

  return (
    <section
      className="grid gap-2 border-t border-(--ui-stroke-tertiary) pt-1.5"
      data-question-id={question.questionId}
      data-testid="degram-mapping-proposal"
    >
      <Disclosure controls={bodyId} onToggle={onToggle} open={expanded}>
        <Badge variant={question.type === 'mapping-or-design' ? 'warn' : 'outline'}>
          {typeLabel(copy.mapping, question.type)}
        </Badge>
        <span className="min-w-0 flex-1 truncate">{heading || text}</span>
        <span className="shrink-0 text-[0.75rem] text-muted-foreground">
          {copy.mapping.components(question.items.length)}
        </span>
      </Disclosure>
      {expanded && (
        <div className="grid gap-2 pb-1 pl-5" id={bodyId}>
          {question.items.length > 0 ? (
            <Items copy={copy} items={question.items} target={target} />
          ) : (
            <Muted>{text}</Muted>
          )}
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option, index) => (
              <Button
                disabled={busy}
                key={option.optionId}
                onClick={() => onAnswer(question, option.optionId)}
                size="xs"
                variant={index === 0 ? 'default' : 'outline'}
              >
                {optionText(copy.mapping, question.type, option, labels)}
              </Button>
            ))}
          </div>
          {sending && <Muted>{copy.mapping.sending}</Muted>}
          {error && <Failure text={error} />}
          {question.items.length > 0 && text && (
            <>
              <Button
                aria-expanded={details}
                className="justify-self-start"
                onClick={() => setDetails(value => !value)}
                size="micro"
                variant="text"
              >
                {copy.mapping.details}
              </Button>
              {details && (
                <p
                  className="text-[0.75rem] leading-[1.45] whitespace-pre-wrap text-muted-foreground"
                  data-testid="degram-mapping-details"
                >
                  {text}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function AnswerCard({
  copy,
  ru,
  labels,
  answer,
  expanded,
  onToggle,
  busy,
  error,
  onUndo,
  target
}: CardProps & { answer: MappingAnswer; onUndo: (answer: MappingAnswer) => void }) {
  const bodyId = useId()
  const decided = optionText(copy.mapping, answer.type, { optionId: answer.optionId, label: '' }, labels)

  return (
    <section
      className="grid gap-2 border-t border-(--ui-stroke-tertiary) pt-1.5"
      data-answer-id={answer.answerId}
      data-testid="degram-mapping-answer"
    >
      <Disclosure controls={bodyId} onToggle={onToggle} open={expanded}>
        <Badge variant="muted">{typeLabel(copy.mapping, answer.type)}</Badge>
        <span className="min-w-0 flex-1 truncate">{questionTitle(answer, ru)}</span>
        <span className="shrink-0 text-[0.75rem] text-muted-foreground">→ {decided}</span>
      </Disclosure>
      {expanded && (
        <div className="grid gap-2 pb-1 pl-5" id={bodyId}>
          <Items copy={copy} items={answer.items} target={target} />
          {(answer.decidedBy || answer.decidedAt) && (
            <Muted>
              {[answer.decidedBy, answer.decidedAt.replace('T', ' ').slice(0, 16)].filter(Boolean).join(' · ')}
            </Muted>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !answer.undoable} onClick={() => onUndo(answer)} size="xs" variant="outline">
              {copy.mapping.undo}
            </Button>
            {!answer.undoable && <Muted>{copy.mapping.undoUnavailable}</Muted>}
          </div>
          {error && <Failure text={error} />}
        </div>
      )}
    </section>
  )
}

interface Pending {
  kind: 'answer' | 'undo' | 'apply'
  id: string
}

function SessionView({
  app,
  copy,
  ru,
  project,
  session,
  adopt,
  reload,
  onFocus
}: {
  app: BridgeApp
  copy: Copy
  ru: boolean
  project?: string
  session: MappingSession
  adopt: (session: MappingSession) => void
  reload: () => void
  onFocus: (item: MappingItem) => void
}) {
  const target: ShowTarget = { app, onFocus }
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<null | Pending>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<null | string>(null)
  const labels = sessionLabels(session)
  const toggle = (key: string, fallback: boolean) => setOpenCards(s => ({ ...s, [key]: !(s[key] ?? fallback) }))

  const run = async (target: Pending, call: () => Promise<SessionResult>, done?: string) => {
    setPending(target)
    setErrors(s => ({ ...s, [target.id]: '' }))
    setNotice(null)

    try {
      const result = await call()

      if (result.outcome) {
        const text = mappingFailureText(copy, result.outcome, { app, project })

        setErrors(s => ({ ...s, [target.id]: text }))
      } else {
        adopt(result.session)
        setNotice(done ?? null)
      }
    } catch (error) {
      const outcome: OutcomeInfo =
        error instanceof MappingRefusal ? { code: error.code, message: error.message } : { code: 'DG_UNAVAILABLE' }

      setErrors(s => ({ ...s, [target.id]: mappingFailureText(copy, outcome, { app, project }) }))
      // DG refused for what the request is: the cached session is stale, read the truth.
      reload()
    } finally {
      setPending(null)
    }
  }

  const answer = (question: MappingQuestion, optionId: string) =>
    void run({ kind: 'answer', id: question.questionId }, () =>
      answerMapping(session.sessionId, question.questionId, optionId)
    )

  const undo = (entry: MappingAnswer) =>
    void run(
      { kind: 'undo', id: entry.answerId },
      () => undoMappingAnswer(session.sessionId, entry.answerId),
      copy.mapping.undone
    )

  const answerIds = pendingMappingAnswers(session)
  const intent = useRef<MappingCommitIntent | null>(null)
  const applying = useRef(false)
  const mounted = useRef(true)

  // Lifecycle guard only, not a mirrored store value; StrictMode re-runs setup after cleanup.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const apply = async () => {
    if (applying.current || pending || !answerIds.length) {
      return
    }

    applying.current = true
    const key = JSON.stringify([session.revision, answerIds])

    if (!intent.current || JSON.stringify([intent.current.revision, intent.current.answerIds]) !== key) {
      intent.current = { requestId: `commit-${session.revision}`, revision: session.revision, answerIds }
    }

    setPending({ kind: 'apply', id: 'apply' })
    setErrors(s => ({ ...s, apply: '' }))

    try {
      const result = await applyMapping(session.sessionId, intent.current)

      if (!mounted.current) {
        return
      }

      if (result.outcome) {
        setErrors(s => ({ ...s, apply: mappingFailureText(copy, result.outcome, { app, project }) }))
        reload()
      } else {
        const ids = new Set(result.batch.answerIds)

        adopt({
          ...session,
          pendingAnswerIds: session.pendingAnswerIds.filter(id => !ids.has(id)),
          answers: session.answers.map(answer => (ids.has(answer.answerId) ? { ...answer, undoable: false } : answer)),
          batches: [...session.batches.filter(batch => batch.batchId !== result.batch.batchId), result.batch]
        })
        reload()
      }
    } catch (error) {
      if (mounted.current) {
        const outcome =
          error instanceof MappingRefusal ? { code: error.code, message: error.message } : { code: 'DG_UNAVAILABLE' }

        setErrors(s => ({ ...s, apply: mappingFailureText(copy, outcome, { app, project }) }))
        reload()
      }
    } finally {
      applying.current = false

      if (mounted.current) {
        setPending(null)
      }
    }
  }

  return (
    <div className="grid gap-3">
      <MappingProgress copy={copy} summary={session.summary} />
      {session.llmStatus === 'pending' && (
        <p
          className="flex items-center gap-1.5 text-[0.75rem] leading-[1.4] text-muted-foreground"
          data-testid="degram-mapping-llm"
        >
          <GlyphSpinner ariaLabel={copy.mapping.llmPending} className="text-[0.8rem]" spinner="braille" />
          {copy.mapping.llmPending}
        </p>
      )}
      {session.appliedAt ? (
        <Muted>{copy.mapping.applied}</Muted>
      ) : (
        <div className="grid gap-1.5">
          <Muted>{copy.mapping.waitingApply}</Muted>
          <Button
            className="justify-self-start"
            data-testid="degram-mapping-apply"
            disabled={pending !== null || answerIds.length === 0}
            onClick={() => void apply()}
            size="sm"
          >
            {pending?.kind === 'apply' ? copy.mapping.confirming : copy.mapping.confirm(answerIds.length)}
          </Button>
          {errors.apply && <Failure text={errors.apply} />}
        </div>
      )}
      {session.batches.map(batch => (
        <p className="text-[0.75rem] leading-[1.4] text-muted-foreground" key={batch.batchId} role="status">
          {copy.mapping.delivery[batch.delivery]} · {batch.answerIds.length}
        </p>
      ))}
      {notice && <Muted>{notice}</Muted>}

      <div className="grid gap-1">
        <h4 className="text-[0.75rem] font-medium tracking-wide text-muted-foreground uppercase">
          {copy.mapping.proposals}
        </h4>
        {session.questions.length === 0 ? (
          <Muted>{copy.mapping.noProposals}</Muted>
        ) : (
          session.questions.map((question, index) => (
            <ProposalCard
              busy={pending !== null}
              copy={copy}
              error={errors[question.questionId] || null}
              expanded={openCards[question.questionId] ?? index === 0}
              key={question.questionId}
              labels={labels}
              onAnswer={answer}
              onToggle={() => toggle(question.questionId, index === 0)}
              question={question}
              ru={ru}
              sending={pending?.kind === 'answer' && pending.id === question.questionId}
              target={target}
            />
          ))
        )}
      </div>

      {session.answers.length > 0 && (
        <div className="grid gap-1">
          <h4 className="text-[0.75rem] font-medium tracking-wide text-muted-foreground uppercase">
            {copy.mapping.answers}
          </h4>
          {session.answers.map(entry => (
            <AnswerCard
              answer={entry}
              busy={pending !== null}
              copy={copy}
              error={errors[entry.answerId] || null}
              expanded={openCards[entry.answerId] ?? false}
              key={entry.answerId}
              labels={labels}
              onToggle={() => toggle(entry.answerId, false)}
              onUndo={undo}
              ru={ru}
              target={target}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The DG Revit connector's sign-in state and its start, always shown for a Revit model (D-47): the connector reads the
 * active model's scope (the selection, else the visible model instances) into a new session.
 */
function RevitConnector({
  copy,
  signedIn,
  message,
  hasSession,
  busy,
  onStart
}: {
  copy: Copy
  signedIn: boolean | null
  message: null | string
  hasSession: boolean
  busy: boolean
  onStart: () => void
}) {
  return (
    <div className="grid gap-1.5" data-testid="degram-mapping-revit-connector">
      {signedIn === false && <Muted>{copy.mapping.revitSignInFirst}</Muted>}
      {signedIn === true && <Muted>{copy.mapping.revitSignedIn}</Muted>}
      {signedIn !== null && message && <Muted>{message}</Muted>}
      <div>
        <Button disabled={busy} onClick={onStart} size="sm" variant={hasSession ? 'outline' : 'default'}>
          {busy ? copy.mapping.starting : hasSession ? copy.mapping.startAgain : copy.mapping.start}
        </Button>
      </div>
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
  const [startNote, setStartNote] = useState<null | { text: string; detail?: string; error?: boolean }>(null)
  const [focusError, setFocusError] = useState<null | string>(null)
  const ru = locale.toLowerCase().startsWith('ru')
  const sessionId = state.session?.sessionId ?? null

  const focusFailed = (error: unknown) =>
    setFocusError(
      mappingFailureText(
        copy,
        error instanceof MappingRefusal ? { code: error.code, message: error.message } : { code: 'DG_UNAVAILABLE' },
        { app, project }
      )
    )

  /** Show one row in its CAD application: a canvas component, or the elements of a Revit group of this session. */
  const focus = (item: MappingItem) => {
    if (!itemShowable(app, item)) {
      return
    }

    if (app === 'revit') {
      if (!sessionId) {
        return
      }

      setFocusError(null)
      void showRevitItem(sessionId, item.itemId)
        .then(result => {
          if (result.outcome) {
            setFocusError(mappingFailureText(copy, result.outcome, { app, project }))
          } else if (!result.found) {
            setFocusError(copy.mapping.notFoundRevit(item.name))
          }
        })
        .catch(focusFailed)

      return
    }

    if (!item.componentId) {
      return
    }

    setFocusError(null)
    void focusComponent(item.componentId)
      .then(result => {
        if (result.outcome) {
          setFocusError(mappingFailureText(copy, result.outcome, { app, project }))
        } else if (!result.found) {
          setFocusError(copy.mapping.notFound(item.name))
        }
      })
      .catch(focusFailed)
  }

  const start = async () => {
    setStarting(true)
    setStartNote(null)

    try {
      const result = await startMapping(app)

      if (result.outcome) {
        setStartNote({ text: mappingFailureText(copy, result.outcome, { app, project }), error: true })
      } else if (result.started) {
        setStartNote({ text: copy.mapping.started })
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
          copy={copy}
          hasSession={Boolean(state.session)}
          message={state.connectorMessage}
          onStart={() => void start()}
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

/** The Mapping sub-tab of one document row: collapsed by default, its own reads only while open. */
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
        <MappingBody app={app} document={document} open={open} />
      </div>
    </div>
  )
}
