// mapping-session-view.tsx — one mapping session as the user reads and decides it (Phase 1303-10; moved out of
// mapping-panel.tsx by DG 1303-33, D-118, so the «Модели → Mapping» sub-tab and the chat card render the same view):
// the progress bar, the LLM status, each open proposal with its items and options, the decisions with their undo, the
// shared confirmation with the Design State name of 1303-31, and the mark on answers the agent proposed (D-121).

import './mapping.css'

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Input } from '@/components/ui/input'

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
  suggestMappingStateName,
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

type Copy = DegramCopy

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[0.75rem] leading-[1.4] text-muted-foreground">{children}</p>
}

export function Failure({ text }: { text: string }) {
  return (
    <p className="text-[0.75rem] leading-[1.4] text-destructive" role="alert">
      {text}
    </p>
  )
}

export function Disclosure({
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
  target,
  byAgent
}: CardProps & { answer: MappingAnswer; byAgent: boolean; onUndo: (answer: MappingAnswer) => void }) {
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
        {byAgent && (
          <Badge data-testid="degram-mapping-by-agent" variant="outline">
            {copy.mapping.proposedByAgent}
          </Badge>
        )}
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

export function SessionView({
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

  // DG 1303-31 (D-106): a Revit confirmation records a Design State, so it first asks for that state's name
  const [naming, setNaming] = useState<null | {
    name: string
    suggestion: string
    loading: boolean
    source: 'llm' | 'fallback' | null
  }>(null)

  const requestApply = () => {
    if (app !== 'revit') {
      void apply()

      return
    }

    if (pending !== null || !answerIds.length) {
      return
    }

    setNaming({ name: '', suggestion: '', loading: true, source: null })
    suggestMappingStateName(session.sessionId, answerIds, ru ? 'ru' : 'en')
      .then(found => {
        if (mounted.current) {
          setNaming(
            n =>
              n && {
                ...n,
                loading: false,
                name: n.name || found?.name || '',
                suggestion: found?.name ?? '',
                source: found?.source ?? null
              }
          )
        }
      })
      .catch(() => {
        if (mounted.current) {
          setNaming(n => n && { ...n, loading: false })
        }
      })
  }

  const confirmNamed = () => {
    const name = (naming?.name ?? '').replace(/\s+/g, ' ').trim()

    if (name) {
      void apply({ name, source: naming?.suggestion.replace(/\s+/g, ' ').trim() === name ? 'suggested' : 'edited' })
    }
  }

  const apply = async (designState?: { name: string; source: 'suggested' | 'edited' }) => {
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
      const result = await applyMapping(
        session.sessionId,
        designState
          ? { ...intent.current, designStateName: designState.name, designStateNameSource: designState.source }
          : intent.current
      )

      if (!mounted.current) {
        return
      }

      if (result.outcome) {
        setErrors(s => ({ ...s, apply: mappingFailureText(copy, result.outcome, { app, project }) }))
        reload()
      } else {
        const ids = new Set(result.batch.answerIds)

        setNaming(null)

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
            disabled={pending !== null || answerIds.length === 0 || naming !== null}
            onClick={requestApply}
            size="sm"
          >
            {pending?.kind === 'apply' ? copy.mapping.confirming : copy.mapping.confirm(answerIds.length)}
          </Button>
          {naming && (
            <div className="grid gap-1.5" data-testid="degram-mapping-state-name">
              <Muted>{copy.mapping.stateName.hint}</Muted>
              <Input
                aria-label={copy.mapping.stateName.label}
                data-testid="degram-mapping-state-name-input"
                maxLength={120}
                onChange={event => {
                  const value = event.target.value

                  setNaming(n => n && { ...n, name: value })
                }}
                onKeyDown={event => event.key === 'Enter' && confirmNamed()}
                placeholder={naming.loading ? copy.mapping.stateName.suggesting : copy.mapping.stateName.label}
                value={naming.name}
              />
              <Muted>
                {naming.loading
                  ? copy.mapping.stateName.suggesting
                  : naming.source === 'llm'
                    ? copy.mapping.stateName.llm
                    : naming.source === 'fallback'
                      ? copy.mapping.stateName.fallback
                      : copy.mapping.stateName.none}
              </Muted>
              <div className="flex gap-1.5">
                <Button
                  data-testid="degram-mapping-state-name-confirm"
                  disabled={pending !== null || !naming.name.trim()}
                  onClick={confirmNamed}
                  size="sm"
                >
                  {pending?.kind === 'apply' ? copy.mapping.confirming : copy.mapping.confirm(answerIds.length)}
                </Button>
                <Button disabled={pending !== null} onClick={() => setNaming(null)} size="sm" variant="ghost">
                  {copy.mapping.stateName.cancel}
                </Button>
              </div>
            </div>
          )}
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
              byAgent={session.agentAnswerIds.includes(entry.answerId)}
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
 * Show one row in its CAD application: a Grasshopper canvas component, or the elements of a Revit group of the session
 * (D-51). Shared by the Models → Mapping sub-tab and the chat card (D-118); a failure is named inline.
 */
export function useMappingFocus(app: BridgeApp, sessionId: null | string, copy: Copy, project?: string) {
  const [focusError, setFocusError] = useState<null | string>(null)

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

  return { focus, focusError }
}
