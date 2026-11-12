// mapping-api.ts — the renderer side of `degram.mapping.*` (Phase 1303-10, 1303-13; tui_gateway/contracts/degram.py; DG
// shapes: 1303-API-CONTRACT.md §3, §7 and §8). DG owns the sessions, proposals and answers. Starting a session and
// showing an item belong to the CAD side: Grasshopper's CONNECTOR and canvas, or the DG Revit connector (`app: 'revit'`:
// it reads the active model, and selects and zooms a group's elements). Every answer is normalized here once, so the
// panel works with the narrow shapes below. A bridge or DG failure comes back as an outcome (`status: error` + `code`);
// a request DG refuses for what it is (applied session, answer already undone, stale question) is a JSON-RPC error whose
// `data.code` is DG's code, surfaced as `MappingRefusal`.

import type {
  AnswerTuple,
  CommitSpec,
  MappingIntentResult,
  MappingIntentStatusResult
} from '../../electron/degram/mapping-intent'

import { type Line, safeDefinitionScheme } from './definition-scheme'
import {
  type BridgeApp,
  type OutcomeInfo,
  outcomeOf,
  readMappingIntentStatus,
  request,
  runMappingIntent
} from './use-degram-gateway'

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

export interface MappingBatch {
  batchId: string
  revision: string
  answerIds: string[]
  committedAt: string
  delivery: 'queued' | 'written' | 'failed' | 'unknown'
  snapshot?: { status: 'pending' | 'published' | 'failed' | 'skipped' | 'unknown'; stateId: string; reason: string } | null
}

export interface AdvancedDefinition {
  definitionId: string
  classIri: string
  revision: number
  mode: string
  modeRevision: number
  head: { version: number; kind: string; text: string; proposedBy: string; source: string } | null
  effective: { version: number; kind: string; text: string } | null
  modeProposal: string | null
  agentProposed: boolean
}

export interface AdvancedBinding {
  definitionId: string
  revision: number
  resultDefinitionVersion: number
  resultHash: string
  resultStatus: string
  change: string
  confirmation: string
  delivery: string
  approvedVersion: number | null
  eligible: boolean
  profileOffer: { selector: Record<string, string>; selectorHash: string; matchedCount: number; capturedCount: number; countState: 'unknown'; futureScope: string } | null
  reasons: string[]
  display: { message: string; question: string; code: string; memberIds: string[]; inputIds: string[]; scheme: { lines: Line[] } | null }
}

export interface AdvancedState {
  revision: string
  definitions: AdvancedDefinition[]
  bindings: AdvancedBinding[]
  pending: { answerId: string; definitionId: string; valid: boolean; action: string; reasons: string[] }[]
  model: { document: string; modelKey: string }
  complete: boolean
  commitHash: string
  commitCounts: { upserts: number; deletes: number; direct: number; ordinary: number } | null
  operations: { definitionId: string; definitionVersion: number | null; classIri: string; instanceKey: string; action: string; nativeId: string; reason: string; uniqueIds: string[] }[]
  affectedModels: { definitionId: string; modelKey: string; document: string }[]
  confirmationComplete: boolean
  ordinaryRows: { nativeId: string; roles: string[]; clear: boolean; kind: string; name: string; propertyIri: string; stream: string }[]
  snapshotState: string
}

/** Closed display projection: do not let raw session keys become renderer state or HTML. Missing eligibility is
 * unknown, never success. Only the bounded public display projection is retained, never raw native geometry. */
function parseAdvanced(raw: unknown): AdvancedState | null {
  const a = asRecord(raw)

  if (!a) {
    return null
  }

  const strings = (v: unknown) => asList(v).filter((s): s is string => typeof s === 'string').slice(0, 100)

  const version = (v: unknown) => {
    const r = asRecord(v)

    return r && Number.isSafeInteger(r.version) && (r.version as number) >= 1 ? { version: asCount(r.version), kind: asString(r.kind), text: asString(r.text).slice(0, 16000),
      proposedBy: asString(r.proposedBy), source: asString(r.source) } : null
  }

  const commit = asRecord(a.commit)
  const operationList = commit?.operations
  const affected = a.affectedModels
  const ordinary = asRecord(commit?.ordinaryRows)
  const boundedText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max

  const uniqueTexts = (value: unknown, maxItems: number, maxLength = 512): value is string[] =>
    Array.isArray(value) && value.length <= maxItems && value.every(v => boundedText(v, maxLength)) && new Set(value).size === value.length

  const exactOrdinary = Boolean(ordinary && ['elements', 'parameters', 'measures'].every(kind => {
    const rows = ordinary[kind]

    if (!Array.isArray(rows) || rows.length > 5000) {
      return false
    }

    const ids = new Set<string>()

    return rows.every(raw => {
      const row = asRecord(raw)

      if (!row || !boundedText(row.nativeId, 200) || ids.has(row.nativeId)) {
        return false
      }

      ids.add(row.nativeId)

      if (row.stream !== undefined && row.stream !== null && !boundedText(row.stream)) {
        return false
      }

      if (kind === 'elements') {
        return uniqueTexts(row.roles, 100) && (row.clear === undefined || typeof row.clear === 'boolean') &&
          (row.clear === true ? row.roles.length === 0 : row.roles.length > 0)
      }

      return boundedText(row.name) && (kind !== 'measures' || boundedText(row.propertyIri))
    })
  }))

  const exactOperations = Array.isArray(operationList) && operationList.length <= 1500 && operationList.every(raw => {
    const op = asRecord(raw)

    if (!op || !boundedText(op.definitionId, 200)) {
      return false
    }

    if (op.action === 'direct') {
      return boundedText(op.classIri) && uniqueTexts(op.uniqueIds, 500, 200) && op.uniqueIds.length > 0
    }

    if (!boundedText(op.instanceKey)) {
      return false
    }

    if (op.action === 'delete') {
      return boundedText(op.nativeId, 200) && ['skip', 'stale'].includes(asString(op.reason))
    }

    return ['create', 'update'].includes(asString(op.action)) && boundedText(op.classIri) &&
      Number.isSafeInteger(op.definitionVersion) && (op.definitionVersion as number) >= 1 &&
      (op.action === 'create' ? op.existing === null : boundedText(op.existing, 200))
  })

  const exactAffected = Array.isArray(affected) && affected.length <= 500 && affected.every(raw => {
    const model = asRecord(raw)

    return model && ['definitionId', 'modelKey', 'document'].every(k => boundedText(model[k]))
  })

  // Never enable a write from a sliced definition/binding/pending list. Old or oversized contracts stay read-only.
  const completeLists = ['definitions', 'bindings', 'pending'].every(k => {
    const rows = a[k]

    if (!Array.isArray(rows) || rows.length > 500) {
      return false
    }

    const identities = new Set<string>()

    return rows.every(raw => {
      const row = asRecord(raw)

      if (!row || !boundedText(row.definitionId, 200)) {
        return false
      }

      const identity = k === 'pending' ? row.answerId : row.definitionId

      if (!boundedText(identity, 200) || identities.has(identity)) {
        return false
      }

      identities.add(identity)

      return k !== 'pending' || (typeof row.valid === 'boolean' && ['approve', 'skip'].includes(asString(row.action)))
    })
  })

  return {
    revision: asString(a.revision),
    definitions: asList(a.definitions).slice(0, 500).flatMap(v => {
      const d = asRecord(v)

      return d && asString(d.definitionId) ? [{ definitionId: asString(d.definitionId), classIri: asString(d.classIri),
        revision: asCount(d.revision), mode: asString(d.mode), modeRevision: asCount(d.modeRevision),
        head: version(d.head), effective: version(d.effective), modeProposal: asString(asRecord(d.modeProposal)?.mode) || null,
        agentProposed: d.agentProposed === true }] : []
    }),
    bindings: asList(a.bindings).slice(0, 500).flatMap(v => {
      const b = asRecord(v)
      const eligibility = asRecord(b?.eligibility)
      const display = asRecord(b?.display)
      const offer = asRecord(b?.profileOffer)
      const selector = asRecord(offer?.selector)
      const profileOffer = offer && selector && Object.keys(selector).length > 0 && Object.keys(selector).every(k => ['category', 'family', 'type'].includes(k) && typeof selector[k] === 'string') && /^[a-f0-9]{16}$/.test(asString(offer.selectorHash)) && Number.isSafeInteger(offer.matchedCount) && (offer.matchedCount as number) >= 0 && Number.isSafeInteger(offer.capturedCount) && (offer.capturedCount as number) >= 0 && offer.countState === 'unknown' && offer.futureScope === 'project-revit-future-sessions' ? { selector: selector as Record<string, string>, selectorHash: asString(offer.selectorHash), matchedCount: asCount(offer.matchedCount), capturedCount: asCount(offer.capturedCount), countState: 'unknown' as const, futureScope: asString(offer.futureScope) } : null
      const lines = b?.resultStatus === 'ok' ? safeDefinitionScheme(display?.scheme) : null

      return b && asString(b.definitionId) ? [{ definitionId: asString(b.definitionId), revision: Number.isSafeInteger(b.revision) && (b.revision as number) >= 0 ? b.revision as number : -1,
        resultDefinitionVersion: asCount(b.resultDefinitionVersion), resultHash: asString(b.resultHash),
        resultStatus: asString(b.resultStatus), change: asString(b.change), confirmation: asString(b.confirmation),
        delivery: asString(asRecord(b.materialization)?.state) || asString(b.delivery), approvedVersion: asRecord(b.approved) ? asCount(asRecord(b.approved)?.definitionVersion) : null,
        eligible: eligibility?.eligible === true, profileOffer, reasons: strings(eligibility?.reasons),
        display: { message: asString(display?.message).slice(0, 2000), question: asString(display?.question).slice(0, 2000),
          code: asString(display?.code).slice(0, 2000), memberIds: asList(display?.memberIds).slice(0, 5000).filter((s): s is string => typeof s === 'string' && s.length <= 200), inputIds: asList(display?.inputIds).slice(0, 5000).filter((s): s is string => typeof s === 'string' && s.length <= 200), scheme: lines ? { lines } : null }
      }] : []
    }),
    pending: asList(a.pending).slice(0, 500).flatMap(v => {
      const p = asRecord(v)

      return p && asString(p.answerId) ? [{ answerId: asString(p.answerId), definitionId: asString(p.definitionId),
        valid: p.valid === true, action: asString(p.action), reasons: strings(p.invalidReasons) }] : []
    }),
    model: { document: asString(asRecord(a.model)?.document), modelKey: asString(asRecord(a.model)?.modelKey) },
    complete: a.complete === true && completeLists,
    commitHash: asString(asRecord(a.commit)?.batchManifestHash),
    commitCounts: ['upserts', 'deletes', 'direct', 'ordinary'].every(k => Number.isSafeInteger(asRecord(a.commit)?.[k]) && (asRecord(a.commit)?.[k] as number) >= 0) ? {
      upserts: asCount(asRecord(a.commit)?.upserts), deletes: asCount(asRecord(a.commit)?.deletes),
      direct: asCount(asRecord(a.commit)?.direct), ordinary: asCount(asRecord(a.commit)?.ordinary)
    } : null,
    operations: asList(asRecord(a.commit)?.operations).slice(0, 1500).flatMap(raw => {
      const op = asRecord(raw)

      return op ? [{ definitionId: asString(op.definitionId), definitionVersion: Number.isSafeInteger(op.definitionVersion) ? op.definitionVersion as number : null,
        classIri: asString(op.classIri), instanceKey: asString(op.instanceKey), reason: asString(op.reason),
        action: asString(op.action), nativeId: asString(op.nativeId) || asString(op.existing), uniqueIds: asList(op.uniqueIds).slice(0, 500).filter((v): v is string => typeof v === 'string' && v.length <= 200) }] : []
    }),
    affectedModels: asList(a.affectedModels).slice(0, 500).flatMap(raw => {
      const model = asRecord(raw)

      return model ? [{ definitionId: asString(model.definitionId), modelKey: asString(model.modelKey), document: asString(model.document) }] : []
    }),
    confirmationComplete: completeLists && exactOrdinary && exactOperations && exactAffected,
    ordinaryRows: exactOrdinary ? ['elements', 'parameters', 'measures'].flatMap(kind => asList(ordinary?.[kind]).map(raw => {
      const row = asRecord(raw)!

      return { kind, nativeId: asString(row.nativeId), roles: asList(row.roles).map(asString), clear: row.clear === true,
        name: asString(row.name), propertyIri: asString(row.propertyIri), stream: asString(row.stream) }
    })) : [],
    snapshotState: asString(asRecord(a.snapshot)?.status)
  }
}

export interface MappingSession {
  advanced: AdvancedState | null
  revision: string
  pendingAnswerIds: string[]
  batches: MappingBatch[]
  sessionId: string
  label: string
  document: null | string
  createdAt: string
  appliedAt: null | string
  summary: MappingSummary
  questions: MappingQuestion[]
  answers: MappingAnswer[]
  /** DG 1303-33 (D-121): ids of the current answers the DeGram agent proposed from a chat. */
  agentAnswerIds: string[]
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
  /** CONNECTOR on the canvas / the DG Revit connector is signed in (null when the connector did not answer). */
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

function parseBatch(raw: unknown): MappingBatch | null {
  const b = asRecord(raw)
  const state = asRecord(b?.delivery)?.state
  const snapshot = asRecord(b?.snapshot)
  const snapshotStatus = snapshot?.status

  return b && asString(b.batchId)
    ? {
        batchId: asString(b.batchId),
        revision: asString(b.revision),
        answerIds: asList(b.answerIds).filter((v): v is string => typeof v === 'string' && Boolean(v)),
        committedAt: asString(b.committedAt),
        delivery: state === 'queued' || state === 'written' || state === 'failed' ? state : 'unknown',
        snapshot: snapshot ? {
          status: snapshotStatus === 'pending' || snapshotStatus === 'published' || snapshotStatus === 'failed' || snapshotStatus === 'skipped' ? snapshotStatus : 'unknown',
          stateId: asString(snapshot.stateId).slice(0, 200), reason: asString(snapshot.reason).slice(0, 1000)
        } : null
      }
    : null
}

export function parseSession(raw: unknown): MappingSession | null {
  const s = asRecord(raw)
  const sessionId = asString(s?.sessionId)

  if (!s || !sessionId) {
    return null
  }

  return {
    sessionId,
    advanced: parseAdvanced(s.advancedState),
    label: asString(s.label),
    document: asString(s.document) || null,
    createdAt: asString(s.createdAt),
    appliedAt: asString(s.appliedAt) || null,
    revision: /^[a-f0-9]{24}$/.test(asString(s.revision)) ? asString(s.revision) : '',
    pendingAnswerIds: asList(s.pendingAnswerIds).filter((v): v is string => typeof v === 'string' && Boolean(v)),
    batches: asList(s.batches).flatMap(raw => {
      const batch = parseBatch(raw)

      return batch ? [batch] : []
    }),
    summary: parseSummary(s.summary),
    questions: asList(s.questions).flatMap(q => {
      const question = parseQuestion(q)

      return question ? [question] : []
    }),
    answers: asList(s.answers).flatMap(a => {
      const answer = parseAnswer(a)

      return answer ? [answer] : []
    }),
    llmStatus: asString(asRecord(s.llm)?.status) || null,
    agentAnswerIds: asList(s.agentAnswerIds).filter((v): v is string => typeof v === 'string' && Boolean(v))
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

/** Terminal references only: an empty response, confirmed challenge, claimed or unknown operation never unlocks. */
export function advancedIntentSettled(result: MappingIntentStatusResult): boolean {
  return result.ok && result.intents.length > 0 && result.intents.every(i =>
    i.operationState ? ['completed', 'failed', 'cancelled'].includes(i.operationState) :
      ['cancelled', 'expired', 'stale', 'revoked', 'consumed'].includes(i.status))
}

export async function proposeOrdinaryMode(definition: AdvancedDefinition): Promise<void> {
  const raw = await call('degram.mapping.advanced.mode', {
    definitionId: definition.definitionId, mode: 'ordinary', expectedRevision: definition.revision
  })

  const outcome = outcomeOf(raw)

  if (outcome) {
    throw new MappingRefusal(outcome.code, outcome.code)
  }
}

/** Pure derivation only; never approve or materialize. Reuse the request id for status, not a blind retry. */
export async function deriveAdvancedDefinition(sessionId: string, definition: AdvancedDefinition, bindingRevision: number | undefined, requestId: string, statusOnly = false, binding?: { grids: string[]; phaseScope?: 'all-model' } | { memberIds: string[] } | { uniqueIds: string[] }): Promise<string> {
  const raw = await call('degram.mapping.advanced.derive', {
    sessionId, definitionId: definition.definitionId, requestId,
    ...(statusOnly ? {} : {
      definitionVersion: definition.head?.version,
      ...(binding === undefined ? {} : { binding }),
      ...(bindingRevision === undefined ? {} : { expectedBindingRevision: bindingRevision })
    }), statusOnly
  })

  const outcome = outcomeOf(raw)

  if (outcome) {
    throw new MappingRefusal(outcome.code, outcome.code)
  }

  return asString(asRecord(raw)?.outcome) || asString(asRecord(raw)?.resultStatus) || 'unknown'
}

function sessionResult(raw: unknown): SessionResult {
  const outcome = outcomeOf(raw)
  const session = outcome ? null : parseSession(asRecord(raw)?.session)

  if (outcome || !session) {
    return { outcome: outcome ?? { code: 'DG_UNAVAILABLE', reason: 'MALFORMED' }, session: null }
  }

  return { outcome: null, session }
}

/**
 * The sessions of one document, newest first, with the connector's sign-in state. For Grasshopper the canvas names
 * the document key first; for Revit it is the key of the `.rvt` name.
 */
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

export interface MappingCommitIntent {
  requestId: string
  revision: string
  answerIds: string[]
  /** DG 1303-31 (D-106): the confirmed name of the Design State a Revit confirmation records. */
  designStateName?: string
  designStateNameSource?: 'suggested' | 'edited'
}

export interface DesignStateNameSuggestion {
  name: string
  source: 'llm' | 'fallback'
}

/** DG 1303-31 (D-107): DG's suggested name of the Design State this confirmation records; null when none came. */
export async function suggestMappingStateName(
  sessionId: string,
  answerIds: string[],
  language: 'ru' | 'en'
): Promise<DesignStateNameSuggestion | null> {
  const raw = await call('degram.mapping.suggestName', { sessionId, answerIds, language }, 60_000)
  const suggestion = asRecord(asRecord(raw)?.suggestion)
  const name = asString(suggestion?.name)

  return name ? { name, source: suggestion?.source === 'fallback' ? 'fallback' : 'llm' } : null
}

/** Never infer acceptance from counters, auto matches, or an empty question list. */
export function pendingMappingAnswers(session: MappingSession): string[] {
  if (session.appliedAt || !session.revision) {
    return []
  }

  const committed = new Set(session.batches.flatMap(batch => batch.answerIds))

  return [...new Set(session.pendingAnswerIds)]
    .filter(id => !committed.has(id) && session.answers.some(answer => answer.answerId === id && answer.undoable))
    .sort()
}

export async function applyMapping(
  sessionId: string,
  intent: MappingCommitIntent
): Promise<{ outcome: OutcomeInfo; batch: null } | { outcome: null; batch: MappingBatch }> {
  if (!intent.answerIds.length || !/^[a-f0-9]{24}$/.test(intent.revision)) {
    throw new MappingRefusal('MAPPING_COMMIT_REQUIRED', 'MAPPING_COMMIT_REQUIRED')
  }

  const raw = await call('degram.mapping.apply', { sessionId, ...intent })
  const outcome = outcomeOf(raw)
  const batch = parseBatch(asRecord(raw)?.batch)

  if (
    outcome ||
    !batch ||
    batch.batchId !== intent.requestId ||
    batch.revision !== intent.revision ||
    JSON.stringify(batch.answerIds) !== JSON.stringify([...intent.answerIds].sort()) ||
    batch.delivery === 'unknown'
  ) {
    return { outcome: outcome ?? { code: 'DG_UNAVAILABLE', reason: 'MALFORMED' }, batch: null }
  }

  return { outcome: null, batch }
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

/**
 * A start reads the whole canvas or Revit scope (up to 5000 elements) and posts it to DG, and a Revit show selects up
 * to 5000 elements: give both longer than the stock 30 s (the backend answers BUSY after 40 s).
 */
export const START_RPC_TIMEOUT_MS = 45_000

export interface StartResult {
  outcome: null | OutcomeInfo
  started: boolean
  /** Revit only: the session the connector just created. */
  sessionId: null | string
  message: null | string
  /** Revit only: `selection` when only the elements selected in Revit were read (D-48), `view` for the whole view,
   *  `filters` for a filtered start (DG 1303-33, D-123). */
  scope: null | 'filters' | 'selection' | 'view'
  /** Revit only: elements sent to DG. */
  read: null | number
  /** Revit, filtered start (D-124): elements passing the filters, those left beyond the limit, and the ElementId the
   *  next session continues after. */
  matched: null | number
  remaining: null | number
  lastElementId: null | number
}

/** DG 1303-33 (D-123, D-124): the Revit mapping filters that are on, the element limit and the continuation. */
export interface MappingStartOptions {
  /** `{}` reads the whole model; `view` is `'active'`, a view id, or (from the agent) a view name. */
  filters: { view?: number | string; selection?: true; categories?: string[] }
  limit: number
  after?: number
}

const count = (value: unknown): null | number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** Grasshopper keeps its parameterless call; Revit names itself (the connector's `dg_start_mapping`), with the
 *  filters, limit and continuation when they are given. */
export async function startMapping(app: BridgeApp = 'grasshopper', options?: MappingStartOptions): Promise<StartResult> {
  const params = app === 'revit' ? { app, ...(options ?? {}) } : {}
  const raw = asRecord(await call('degram.mapping.start', params, START_RPC_TIMEOUT_MS))
  const outcome = outcomeOf(raw)
  const scope = raw?.scope

  return {
    outcome,
    started: !outcome && raw?.started === true,
    sessionId: asString(raw?.sessionId) || null,
    message: asString(raw?.message) || null,
    scope: scope === 'selection' || scope === 'view' || scope === 'filters' ? scope : null,
    read: count(raw?.read),
    matched: count(raw?.matched),
    remaining: count(raw?.remaining),
    lastElementId: count(raw?.lastElementId)
  }
}

export interface MappingCategoryChoice {
  name: string
  label: string
  count: number
}

export interface MappingViewChoice {
  id: number
  name: string
  type: string
}

/** D-123: what the Revit filters offer, read from the open model through the DG Revit connector. */
export async function readMappingFilters(): Promise<{
  outcome: null | OutcomeInfo
  categories: MappingCategoryChoice[]
  views: MappingViewChoice[]
}> {
  const raw = asRecord(await call('degram.mapping.filters', { app: 'revit' }, START_RPC_TIMEOUT_MS))

  return {
    outcome: outcomeOf(raw),
    categories: asList(raw?.categories).flatMap(entry => {
      const c = asRecord(entry)
      const name = asString(c?.name)

      return name ? [{ name, label: asString(c?.label) || name, count: asCount(c?.count) }] : []
    }),
    views: asList(raw?.views).flatMap(entry => {
      const v = asRecord(entry)
      const id = count(v?.id)

      return id ? [{ id, name: asString(v?.name) || String(id), type: asString(v?.type) }] : []
    })
  }
}

export async function focusComponent(
  componentId: string
): Promise<{ outcome: null | OutcomeInfo; found: boolean; name: null | string }> {
  const raw = asRecord(await call('degram.mapping.focus', { componentId }))
  const outcome = outcomeOf(raw)

  return { outcome, found: !outcome && raw?.found === true, name: asString(raw?.name) || null }
}

export interface RevitShowResult {
  outcome: null | OutcomeInfo
  /** At least one element of the group is in the model. */
  found: boolean
  shown: number
  /** UniqueIds the model no longer holds. */
  missing: string[]
}

/** Select the elements of one session group in Revit and zoom the active view to them (D-51). */
export async function showRevitItem(sessionId: string, itemId: string): Promise<RevitShowResult> {
  const raw = asRecord(await call('degram.mapping.focus', { app: 'revit', sessionId, itemId }, START_RPC_TIMEOUT_MS))
  const outcome = outcomeOf(raw)

  return {
    outcome,
    found: !outcome && raw?.found === true,
    shown: asCount(raw?.shown),
    missing: asList(raw?.missing).filter((id): id is string => typeof id === 'string')
  }
}

// ─── 1303-35: protected advanced-mapping actions (the human-intent lane) ─────────────────────────────
//
// Approve, skip, preview, clear preview and the common commit of the advanced Revit mapping are NOT gateway calls from
// the renderer. Each goes to Electron main's broker (`runMappingIntent`), which shows the connector's native dialog and
// holds the proof; the renderer only names what the card showed (the frozen tuple) and gets back intent/status
// references plus the canonical state. A refusal is a value (`ok: false` + `code`), never a thrown credential.
// `requestId` is the idempotency key of one user action: reuse it to retry that action (it resumes, it never shows a
// second dialog), mint a new one for a new click.

export type {
  AnswerTuple as AdvancedAnswerTuple,
  CommitSpec as AdvancedCommitSpec,
  MappingIntentCode,
  MappingIntentFailure,
  MappingIntentRef,
  MappingIntentResult,
  MappingIntentStatusResult,
  MappingIntentSuccess
} from '../../electron/degram/mapping-intent'

/** A fresh idempotency key for one user action (3 to 48 characters of `[A-Za-z0-9._:-]`). */
export function newIntentRequestId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

  return `mi-${random}`.slice(0, 48)
}

/** Approve one definition or one atomic frozen list; skip accepts a single definition only. */
export function answerAdvanced(
  action: 'approve' | 'skip',
  sessionId: string,
  requestId: string,
  items: AnswerTuple[]
): Promise<MappingIntentResult> {
  return runMappingIntent({ action, sessionId, requestId, items })
}

/** Show the native preview of a definition result (claimed once; never enters the population). */
export function previewAdvancedDefinition(sessionId: string, requestId: string, item: AnswerTuple): Promise<MappingIntentResult> {
  return runMappingIntent({ action: 'preview', sessionId, requestId, items: [item] })
}

/** Remove that definition's own preview (owned authorization, never a generic delete). */
export function clearAdvancedPreview(sessionId: string, requestId: string, definitionId: string): Promise<MappingIntentResult> {
  return runMappingIntent({ action: 'clear-preview', sessionId, requestId, definitionIds: [definitionId] })
}

/** The common commit of a batch with advanced work: one native confirmation of the exact manifest, then apply. */
export function commitAdvanced(sessionId: string, requestId: string, commit: CommitSpec): Promise<MappingIntentResult> {
  return runMappingIntent({ action: 'commit', sessionId, requestId, commit })
}

/** After an unresolved outcome: read where the challenges of that request stand (never repeats a native action). */
export function readAdvancedIntentStatus(sessionId: string, requestId: string): Promise<MappingIntentStatusResult> {
  return readMappingIntentStatus({ sessionId, requestId })
}
