// mapping-api.ts — the renderer side of `degram.mapping.*` (Phase 1303-10, tui_gateway/contracts/degram.py; DG shapes:
// 1303-API-CONTRACT.md §3 and §7). DG owns the sessions, proposals and answers; Grasshopper's CONNECTOR owns starting a
// session and the canvas owns focusing a component. Every answer is normalized here once, so the panel works with the
// narrow shapes below. A bridge or DG failure comes back as an outcome (`status: error` + `code`); a request DG refuses
// for what it is (applied session, answer already undone, stale question) is a JSON-RPC error whose `data.code` is DG's
// code, surfaced as `MappingRefusal`.

import { type OutcomeInfo, outcomeOf, request } from './use-degram-gateway'

export const MAPPING_STATES = ['confirmed', 'auto', 'suggested', 'ambiguous', 'unmapped'] as const

export type MappingState = (typeof MAPPING_STATES)[number]

export interface MappingSummary {
  total: number
  confirmed: number
  auto: number
  suggested: number
  ambiguous: number
  unmapped: number
  openQuestions: number
}

export interface MappingLabel {
  iri: string
  label: string
}

/** One proposed canvas component (§7.1 `items[]`): a row of its own, never free text. */
export interface MappingItem {
  itemId: string
  kind: string
  name: string
  /** The 32-hex Grasshopper InstanceGuid; null when unknown (Revit). */
  componentId: null | string
  count: null | number
  proposal: MappingLabel | null
  alternatives: MappingLabel[]
  state: MappingState
}

export interface MappingOption {
  optionId: string
  label: string
}

export interface MappingQuestion {
  questionId: string
  type: string
  title: string
  titleRu: string
  text: string
  textRu: string
  items: MappingItem[]
  options: MappingOption[]
}

export interface MappingAnswer {
  answerId: string
  questionId: string
  type: string
  title: string
  titleRu: string
  optionId: string
  items: MappingItem[]
  decidedAt: string
  decidedBy: string
  undoable: boolean
}

export interface MappingSession {
  sessionId: string
  label: string
  document: null | string
  createdAt: string
  appliedAt: null | string
  summary: MappingSummary
  questions: MappingQuestion[]
  answers: MappingAnswer[]
  /** The background LLM proposal: `pending` while it runs. */
  llmStatus: null | string
}

export interface MappingSessionRow {
  sessionId: string
  label: string
  document: null | string
  createdAt: string
  appliedAt: null | string
  summary: MappingSummary
}

export interface MappingSessionsResult {
  outcome: null | OutcomeInfo
  /** The document key the rows were matched by. */
  document: null | string
  /** Newest first. */
  sessions: MappingSessionRow[]
  /** Grasshopper only: CONNECTOR is on the canvas and signed in (null when the canvas did not answer). */
  signedIn: boolean | null
  connectorMessage: null | string
}

export type SessionResult = { outcome: OutcomeInfo; session: null } | { outcome: null; session: MappingSession }

/** A request DG refused for what it is: `code` is DG's own (MAPPING_SESSION_APPLIED, MAPPING_ANSWER_NOT_FOUND, ...). */
export class MappingRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MappingRefusal'
    this.code = code
  }
}

const asRecord = (value: unknown): null | Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const isState = (value: unknown): value is MappingState => MAPPING_STATES.includes(value as MappingState)

function parseLabel(raw: unknown): MappingLabel | null {
  const value = asRecord(raw)
  const iri = asString(value?.iri)

  return value && iri ? { iri, label: asString(value.label) || iri } : null
}

export function parseSummary(raw: unknown): MappingSummary {
  const s = asRecord(raw)

  return {
    total: asCount(s?.total),
    confirmed: asCount(s?.confirmed),
    auto: asCount(s?.auto),
    suggested: asCount(s?.suggested),
    ambiguous: asCount(s?.ambiguous),
    unmapped: asCount(s?.unmapped),
    openQuestions: asCount(s?.openQuestions)
  }
}

function parseItems(raw: unknown): MappingItem[] {
  return asList(raw).flatMap((entry, index) => {
    const item = asRecord(entry)

    if (!item) {
      return []
    }

    const componentId = asString(item.componentId)

    return [
      {
        itemId: asString(item.itemId) || `item-${index}`,
        kind: asString(item.kind),
        name: asString(item.name) || asString(item.itemId),
        componentId: componentId || null,
        count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : null,
        proposal: parseLabel(item.proposal),
        alternatives: asList(item.alternatives).flatMap(alt => {
          const label = parseLabel(alt)

          return label ? [label] : []
        }),
        state: isState(item.state) ? item.state : 'unmapped'
      }
    ]
  })
}

function parseQuestion(raw: unknown): MappingQuestion | null {
  const q = asRecord(raw)
  const questionId = asString(q?.questionId)

  if (!q || !questionId) {
    return null
  }

  return {
    questionId,
    type: asString(q.type),
    title: asString(q.title),
    titleRu: asString(q.titleRu),
    text: asString(q.text),
    textRu: asString(q.textRu),
    items: parseItems(q.items),
    options: asList(q.options).flatMap(entry => {
      const option = asRecord(entry)
      const optionId = asString(option?.optionId)

      return optionId ? [{ optionId, label: asString(option?.label) }] : []
    })
  }
}

function parseAnswer(raw: unknown): MappingAnswer | null {
  const a = asRecord(raw)
  const answerId = asString(a?.answerId)

  if (!a || !answerId) {
    return null
  }

  return {
    answerId,
    questionId: asString(a.questionId),
    type: asString(a.type),
    title: asString(a.title),
    titleRu: asString(a.titleRu),
    optionId: asString(a.optionId),
    items: parseItems(a.items),
    decidedAt: asString(a.decidedAt),
    decidedBy: asString(a.decidedBy),
    undoable: a.undoable === true
  }
}

export function parseSession(raw: unknown): MappingSession | null {
  const s = asRecord(raw)
  const sessionId = asString(s?.sessionId)

  if (!s || !sessionId) {
    return null
  }

  return {
    sessionId,
    label: asString(s.label),
    document: asString(s.document) || null,
    createdAt: asString(s.createdAt),
    appliedAt: asString(s.appliedAt) || null,
    summary: parseSummary(s.summary),
    questions: asList(s.questions).flatMap(q => {
      const question = parseQuestion(q)

      return question ? [question] : []
    }),
    answers: asList(s.answers).flatMap(a => {
      const answer = parseAnswer(a)

      return answer ? [answer] : []
    }),
    llmStatus: asString(asRecord(s.llm)?.status) || null
  }
}

function parseRow(raw: unknown): MappingSessionRow | null {
  const row = asRecord(raw)
  const sessionId = asString(row?.sessionId)

  return row && sessionId
    ? {
        sessionId,
        label: asString(row.label),
        document: asString(row.document) || null,
        createdAt: asString(row.createdAt),
        appliedAt: asString(row.appliedAt) || null,
        summary: parseSummary(row.summary)
      }
    : null
}

/** Rethrow a DG refusal (JSON-RPC error with `data.code`) as `MappingRefusal`; anything else as it came. */
async function call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  try {
    return await request<unknown>(method, params, timeoutMs)
  } catch (error) {
    const data = asRecord(asRecord(error)?.data)
    const code = asString(data?.code)

    if (code) {
      const message = error instanceof Error ? error.message.replace(/^[A-Z0-9_]+:\s*/, '') : code

      throw new MappingRefusal(code, message)
    }

    throw error
  }
}

function sessionResult(raw: unknown): SessionResult {
  const outcome = outcomeOf(raw)
  const session = outcome ? null : parseSession(asRecord(raw)?.session)

  if (outcome || !session) {
    return { outcome: outcome ?? { code: 'DG_UNAVAILABLE', reason: 'MALFORMED' }, session: null }
  }

  return { outcome: null, session }
}

/** The sessions of one document, newest first. For Grasshopper the canvas names the document key first. */
export async function listMappingSessions(app: string, document: string): Promise<MappingSessionsResult> {
  const raw = asRecord(await call('degram.mapping.sessions', { app, document }))

  return {
    outcome: outcomeOf(raw),
    document: asString(raw?.document) || null,
    sessions: asList(raw?.sessions).flatMap(entry => {
      const row = parseRow(entry)

      return row ? [row] : []
    }),
    signedIn: typeof raw?.signedIn === 'boolean' ? raw.signedIn : null,
    connectorMessage: asString(raw?.connectorMessage) || null
  }
}

export async function readMappingSession(sessionId: string): Promise<SessionResult> {
  return sessionResult(await call('degram.mapping.session', { sessionId }))
}

export async function answerMapping(sessionId: string, questionId: string, optionId: string): Promise<SessionResult> {
  return sessionResult(await call('degram.mapping.answer', { sessionId, questionId, optionId }))
}

export async function undoMappingAnswer(sessionId: string, answerId: string): Promise<SessionResult> {
  return sessionResult(await call('degram.mapping.undo', { sessionId, answerId }))
}

/** `start_mapping` reads the whole canvas and posts it to DG: give it longer than the stock 30 s. */
export const START_RPC_TIMEOUT_MS = 45_000

export async function startMapping(): Promise<{
  outcome: null | OutcomeInfo
  started: boolean
  message: null | string
}> {
  const raw = asRecord(await call('degram.mapping.start', {}, START_RPC_TIMEOUT_MS))
  const outcome = outcomeOf(raw)

  return { outcome, started: !outcome && raw?.started === true, message: asString(raw?.message) || null }
}

export async function focusComponent(
  componentId: string
): Promise<{ outcome: null | OutcomeInfo; found: boolean; name: null | string }> {
  const raw = asRecord(await call('degram.mapping.focus', { componentId }))
  const outcome = outcomeOf(raw)

  return { outcome, found: !outcome && raw?.found === true, name: asString(raw?.name) || null }
}
