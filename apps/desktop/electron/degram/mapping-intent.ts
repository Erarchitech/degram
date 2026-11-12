// mapping-intent.ts — the main-owned human-intent broker of the advanced Revit mapping (plan 1303-35 Task 2, Q1).
//
// A protected action of the advanced mapping (approve or skip a class definition, preview or clear its preview,
// the common commit) runs only against proof of a real human decision. The proof is built here, in Electron main,
// from two lanes that the renderer never sees:
//
//   member lane     the DG partition fetch (the signed-in member's own cookie + CSRF header) asks the DG
//                   data-service for a challenge frozen to the exact canonical tuple, and later reads its status;
//   delegated lane  the open scope's agent gateway (scope.callAgent, stamped with the environment generation by
//                   the backend handle) shows that challenge in the connector's NATIVE dialog and, once a person
//                   pressed Yes, performs the protected operation with the intent reference.
//
// The renderer sends a frozen tuple it SAW plus the environment/project/epoch stamp it saw. Nothing it sends is
// trusted as proof: main re-reads the canonical session, requires every tuple to still be current, builds the
// scope itself and refuses to go on unless the server reports the challenge as `confirmed`. A renderer click,
// `isTrusted`, a `confirmed`/`byAgent`/`source` field or calling the RPC alone can never create proof, because the
// proof is the server-side receipt posted by the connector after the dialog. The request is a closed shape: it has
// no field for an intent id, a scope, a URL, a method, a body or a credential.
//
// Credentials stay in their own lanes: the cookie jar is the environment's own partition (the injected fetch),
// the delegated token lives in the scope controller. Results carry only intent/status references and the safe
// canonical state the gateway returned (scrubbed of anything that looks like a credential).

import type { AuthState, Logger, PartitionFetch, PartitionResponse } from './dg-session'
import type { ScopeState } from './scope'

/** The CSRF header the DG data-service requires on a cookie-authenticated write (the same value dg-session sends). */
const CSRF_HEADER = 'X-DG-CSRF'

export const MAPPING_INTENT_ACTIONS = ['approve', 'skip', 'commit', 'preview', 'clear-preview'] as const

export type MappingIntentAction = (typeof MAPPING_INTENT_ACTIONS)[number]

/** The protected-action names of the DG data-service human-intent lane (`1303-API-CONTRACT.md` section 9). */
const WIRE_ACTION: Record<MappingIntentAction, string> = {
  approve: 'advanced-approve',
  skip: 'advanced-skip',
  commit: 'advanced-commit',
  preview: 'preview-definition',
  'clear-preview': 'clear-definition-preview'
}

/** A bulk answer is bounded like the largest advanced list the server accepts. */
export const MAX_BULK_ITEMS = 100

export interface EnvironmentFence {
  environmentId: string
  generation: number
}

/** One class definition result exactly as the card showed it: the frozen tuple an approve, skip or preview names. */
export interface AnswerTuple {
  definitionId: string
  definitionVersion: number
  resultHash: string
  bindingRevision: number
  generalization?: { selectorHash: string; matchedCount: number; countState: 'unknown' }
}

export interface CommitSpec {
  batchManifestHash: string
  /** The session revision the confirmation names (the `degram.mapping.apply` revision). */
  revision: string
  answerIds: string[]
  designStateName?: string
  designStateNameSource?: 'edited' | 'suggested'
}

interface RequestBase {
  /** The environment stamp the renderer saw; null only for a legacy runtime that has no coordinator. */
  environment: EnvironmentFence | null
  project: string
  /** The scope epoch the renderer saw (`state.scope.epoch`). */
  scopeEpoch: number
  sessionId: string
  /** The idempotency key of this user action. A retry of the same action reuses it; a new click uses a new one. */
  requestId: string
}

export type MappingIntentRequest = RequestBase &
  (
    | { action: 'approve' | 'preview' | 'skip'; items: AnswerTuple[] }
    | { action: 'clear-preview'; definitionIds: string[] }
    | { action: 'commit'; commit: CommitSpec }
  )

export interface MappingIntentStatusRequest {
  environment: EnvironmentFence | null
  project: string
  scopeEpoch: number
  sessionId: string
  requestId: string
}

export type MappingIntentCode =
  | 'ALREADY_ANSWERED'
  | 'BUSY'
  | 'CANCELLED'
  | 'CHALLENGE_MISMATCH'
  | 'CHALLENGE_REFUSED'
  | 'FAILED'
  | 'NATIVE_REFUSED'
  | 'NOT_A_MEMBER'
  | 'NOT_EDITOR'
  | 'NOT_READY'
  | 'NOT_SIGNED_IN'
  | 'PROOF_NOT_CONFIRMED'
  | 'REQUEST_CONFLICT'
  | 'SESSION_UNAVAILABLE'
  | 'STALE_ENVIRONMENT'
  | 'STALE_TUPLE'
  | 'UNKNOWN_REQUEST'
  | 'UNRESOLVED'

/** A reference to one human challenge: never a secret, only what the renderer needs to show and re-read status. */
export interface MappingIntentRef {
  intentId: string
  action: string
  status: string
  definitionId?: string
  operationId?: string
  operationState?: string
}

export interface MappingIntentSuccess {
  ok: true
  requestId: string
  action: MappingIntentAction
  intents: MappingIntentRef[]
  /** approve / skip: the recomputed session the gateway returned (canonical, safe). */
  session?: unknown
  /** commit: the batch of `degram.mapping.apply` (queued is not written). */
  batch?: unknown
  /** preview / clear-preview: what the native operation reported. */
  operation?: unknown
  /** The recorded answer of an earlier identical request, not a new operation. */
  replayed?: boolean
}

export interface MappingIntentFailure {
  ok: false
  requestId: string
  action: MappingIntentAction
  code: MappingIntentCode
  /** A fixed, safe sentence. The renderer localizes by `code`; no server text is echoed. */
  message: string
  /** The server's or the native side's own stable code, when it is a plain code. */
  serverCode?: string
  intents: MappingIntentRef[]
  /** Recorded draft definitions; an atomic bulk refusal never reports a partially completed subset. */
  completed: string[]
  /** The definitions whose frozen tuple was stale (nothing was asked of the person). */
  stale: string[]
  /** The outcome of a native step is unknown: read the status, never run the native action again. */
  unresolved?: boolean
  replayed?: boolean
}

export type MappingIntentResult = MappingIntentFailure | MappingIntentSuccess

export type MappingIntentStatusResult =
  | { ok: false; code: MappingIntentCode; message: string }
  | { ok: true; requestId: string; intents: MappingIntentRef[] }

export interface MappingIntentDeps {
  /** Present on coordinator-owned runtimes; a legacy fixture has none and its requests carry `environment: null`. */
  environment?: EnvironmentFence
  origin: string
  /** The member lane: the DG partition fetch of THIS environment (already fenced by the runtime's `isCurrent`). */
  fetch: PartitionFetch
  /** The delegated lane: one call on the open scope's agent backend (`scope.callAgent`). */
  callAgent: (method: string, params: Record<string, unknown>) => Promise<unknown>
  auth: () => AuthState
  scope: () => ScopeState
  isCurrent: () => boolean
  logger: Logger
  /** How many finished requests are remembered for idempotent retries (default 256). */
  maxRecords?: number
}

export interface SnapshotRecoveryRequest {
  environment: EnvironmentFence | null
  project: string
  scopeEpoch: number
  sessionId: string
  batchId: string
}

export type SnapshotRecoveryResult =
  | { ok: true; status: 'pending' | 'published' | 'failed' | 'skipped'; stateId?: string }
  | { ok: false; code: MappingIntentCode; message: string }

export function parseSnapshotRecoveryRequest(value: unknown): SnapshotRecoveryRequest {
  const body = closed(value, ['environment', 'project', 'scopeEpoch', 'sessionId', 'batchId'], 'snapshot recovery')

  return { environment: fence(body.environment), project: text(body.project, 'project'),
    scopeEpoch: whole(body.scopeEpoch, 'scope epoch'), sessionId: text(body.sessionId, 'session', SESSION_ID),
    batchId: text(body.batchId, 'batch', /^[A-Za-z0-9._:-]{3,64}$/) }
}

export interface MappingIntentBroker {
  recoverSnapshot: (request: SnapshotRecoveryRequest) => Promise<SnapshotRecoveryResult>
  run: (request: MappingIntentRequest) => Promise<MappingIntentResult>
  status: (request: MappingIntentStatusRequest) => Promise<MappingIntentStatusResult>
}

// ─── request validation (the IPC payload is untrusted) ───────────────────────────────────────────────

const REQUEST_ID = /^[A-Za-z0-9._:-]{3,48}$/
const SESSION_ID = /^[A-Za-z0-9._:-]{1,64}$/
const DEFINITION_ID = /^MD-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{16,64}$/
const REVISION = /^[a-f0-9]{24}$/
const ANSWER_ID = /^[A-Za-z0-9._:#-]{1,128}$/
const INTENT_ID = /^hi-[0-9a-f]{24}$/
const PLAIN_CODE = /^[A-Z][A-Z0-9_]{2,63}$/
const MAX_TEXT = 200

function invalid(what: string): Error {
  return new Error(`degram: invalid mapping intent ${what}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function closed(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalid(what)
  }

  for (const key of Object.keys(value)) {
    // An explicit `undefined` carries no data (structured clone keeps the key): only a defined extra is refused.
    if (value[key] !== undefined && !keys.includes(key)) {
      // `confirmed`, `byAgent`, `intentId`, `scope`, `url`, `method`, `body`, `token`... have no place in a request.
      throw invalid(`${what} field`)
    }
  }

  return value
}

function text(value: unknown, what: string, pattern?: RegExp): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT || /[\u0000-\u001f]/.test(value)) {
    throw invalid(what)
  }

  if (pattern && !pattern.test(value)) {
    throw invalid(what)
  }

  return value
}

function whole(value: unknown, what: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 1_000_000_000) {
    throw invalid(what)
  }

  return value
}

function fence(value: unknown): EnvironmentFence | null {
  if (value === null) {
    return null
  }

  const record = closed(value, ['environmentId', 'generation'], 'environment')

  return { environmentId: text(record.environmentId, 'environment'), generation: whole(record.generation, 'environment') }
}

function tuple(value: unknown): AnswerTuple {
  const record = closed(value, ['definitionId', 'definitionVersion', 'resultHash', 'bindingRevision', 'generalization'], 'item')
  const g = record.generalization === undefined ? null : closed(record.generalization, ['selectorHash', 'matchedCount', 'countState'], 'generalization')

  if (g && g.countState !== 'unknown') {throw invalid('generalization count state')}

  return {
    definitionId: text(record.definitionId, 'definition', DEFINITION_ID),
    definitionVersion: whole(record.definitionVersion, 'definition version', 1),
    resultHash: text(record.resultHash, 'result hash', HASH),
    bindingRevision: whole(record.bindingRevision, 'binding revision'),
    ...(g ? { generalization: { selectorHash: text(g.selectorHash, 'selector hash', HASH), matchedCount: whole(g.matchedCount, 'matched count'), countState: 'unknown' as const } } : {})
  }
}

function list<T>(value: unknown, what: string, max: number, each: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw invalid(what)
  }

  return value.map(each)
}

function commitSpec(value: unknown): CommitSpec {
  const record = closed(
    value,
    ['batchManifestHash', 'revision', 'answerIds', 'designStateName', 'designStateNameSource'],
    'commit'
  )

  const name = record.designStateName
  const source = record.designStateNameSource

  if (source !== undefined && source !== 'suggested' && source !== 'edited') {
    throw invalid('commit name source')
  }

  const nameSource: CommitSpec['designStateNameSource'] = source === 'suggested' || source === 'edited' ? source : undefined

  return {
    batchManifestHash: text(record.batchManifestHash, 'manifest hash', HASH),
    revision: text(record.revision, 'revision', REVISION),
    answerIds: list(record.answerIds, 'answer ids', 200, entry => text(entry, 'answer id', ANSWER_ID)),
    ...(name === undefined ? {} : { designStateName: text(name, 'state name') }),
    ...(nameSource === undefined ? {} : { designStateNameSource: nameSource })
  }
}

/** Validate an IPC payload into a request. Throws on anything that is not exactly the closed shape. */
export function parseMappingIntentRequest(value: unknown): MappingIntentRequest {
  const record = isRecord(value) ? value : null
  const action = record?.action

  if (typeof action !== 'string' || !(MAPPING_INTENT_ACTIONS as readonly string[]).includes(action)) {
    throw invalid('action')
  }

  const common = ['environment', 'project', 'scopeEpoch', 'sessionId', 'requestId', 'action']
  const keys = action === 'commit' ? [...common, 'commit'] : action === 'clear-preview' ? [...common, 'definitionIds'] : [...common, 'items']
  const body = closed(value, keys, 'request')

  const base: RequestBase = {
    environment: fence(body.environment),
    project: text(body.project, 'project'),
    scopeEpoch: whole(body.scopeEpoch, 'scope epoch'),
    sessionId: text(body.sessionId, 'session', SESSION_ID),
    requestId: text(body.requestId, 'request id', REQUEST_ID)
  }

  if (action === 'commit') {
    return { ...base, action, commit: commitSpec(body.commit) }
  }

  if (action === 'clear-preview') {
    const ids = list(body.definitionIds, 'definitions', 1, entry => text(entry, 'definition', DEFINITION_ID))

    return { ...base, action, definitionIds: ids }
  }

  const items = list(body.items, 'items', action === 'approve' ? MAX_BULK_ITEMS : 1, tuple)

  if (items.some(i => i.generalization) && (action !== 'approve' || items.length !== 1)) {throw invalid('generalization action')}

  if (new Set(items.map(item => item.definitionId)).size !== items.length) {
    throw invalid('items')
  }

  return { ...base, action: action as 'approve' | 'preview' | 'skip', items }
}

export function parseMappingIntentStatusRequest(value: unknown): MappingIntentStatusRequest {
  const body = closed(value, ['environment', 'project', 'scopeEpoch', 'sessionId', 'requestId'], 'status request')

  return {
    environment: fence(body.environment),
    project: text(body.project, 'project'),
    scopeEpoch: whole(body.scopeEpoch, 'scope epoch'),
    sessionId: text(body.sessionId, 'session', SESSION_ID),
    requestId: text(body.requestId, 'request id', REQUEST_ID)
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** JSON with sorted keys: a fingerprint and an equality test that do not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? 'null'
}

const CREDENTIAL_KEY = /token|cookie|csrf|secret|password|credential|authorization/i

/** A value passed back to the renderer: every key that looks like a credential is dropped, at any depth. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 24) {
    return null
  }

  if (Array.isArray(value)) {
    return value.map(entry => scrub(entry, depth + 1))
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {}

    for (const [key, entry] of Object.entries(value)) {
      if (!CREDENTIAL_KEY.test(key)) {
        out[key] = scrub(entry, depth + 1)
      }
    }

    return out
  }

  return value
}

function plainCode(value: unknown): string | undefined {
  return typeof value === 'string' && PLAIN_CODE.test(value) ? value : undefined
}

function errorCodeOf(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined
  }

  const detail = isRecord(body.detail) ? body.detail : null

  return plainCode(detail?.code ?? body.code)
}

function parseBody(response: PartitionResponse): unknown {
  try {
    return response.body ? JSON.parse(response.body) : null
  } catch {
    return null
  }
}

const MESSAGES: Record<MappingIntentCode, string> = {
  ALREADY_ANSWERED: 'This answer is already recorded; nothing was asked.',
  BUSY: 'Another protected action is being confirmed; finish it first.',
  CANCELLED: 'The confirmation was cancelled; nothing was done.',
  CHALLENGE_MISMATCH: 'The server frozen the challenge for something other than what was asked; nothing was confirmed.',
  CHALLENGE_REFUSED: 'The server refused to issue a confirmation for this action.',
  FAILED: 'The action did not return success; reconcile the canonical session before trying again.',
  NATIVE_REFUSED: 'The CAD connector did not return a usable confirmation; check its status.',
  NOT_A_MEMBER: 'You are not a member of this project.',
  NOT_EDITOR: 'Only an editor of the project can confirm this action.',
  NOT_READY: 'No project scope is ready.',
  NOT_SIGNED_IN: 'The DG session is not signed in.',
  PROOF_NOT_CONFIRMED: 'The server does not hold a confirmed receipt for this action; nothing was done.',
  REQUEST_CONFLICT: 'This request id already names a different action.',
  SESSION_UNAVAILABLE: 'The session could not be read from DG; nothing was asked.',
  STALE_ENVIRONMENT: 'The account, environment, project or scope changed; reconcile the original target before another action.',
  STALE_TUPLE: 'What you confirmed is no longer current; read the session again.',
  UNKNOWN_REQUEST: 'No such request is known to this runtime.',
  UNRESOLVED: 'The outcome is not known yet; read its status, do not repeat the action.'
}

/** A failure that stops the flow; carries what the result needs. */
class Stop extends Error {
  readonly code: MappingIntentCode
  readonly serverCode?: string
  readonly unresolved: boolean
  readonly stale: string[]

  constructor(code: MappingIntentCode, extra: { serverCode?: string; unresolved?: boolean; stale?: string[] } = {}) {
    super(code)
    this.code = code
    this.serverCode = extra.serverCode
    this.unresolved = extra.unresolved === true
    this.stale = extra.stale ?? []
  }
}

/** Where one item stands: nothing here is ever read from the renderer. */
interface Step {
  intentId?: string
  /** The native dialog was dispatched for this intent: it is never dispatched again. */
  dispatched: boolean
  /** The operation was called (proof may be spent). Only plural draft submission has exact server replay. */
  called: boolean
  /** Main-frozen plural scope retained across a lost response; never rebuilt from newer card state. */
  bulkScope?: Record<string, unknown>
  /** The protected operation finished with an ok answer. */
  done: boolean
  ref: MappingIntentRef
}

interface RequestRecord {
  actor: string
  fingerprint: string
  steps: Map<string, Step>
  promise: Promise<MappingIntentResult> | null
  result: MappingIntentResult | null
  completed: string[]
  /** The session this request belongs to (status reads need it). */
  sessionId: string
  project: string
}

interface Binding {
  definitionId: string
  revision: number | null
  resultStatus: string | null
  resultHash: string | null
  resultDefinitionVersion: number | null
  profileOffer: { selectorHash: string; matchedCount: number; countState: string } | null
}

interface Canonical {
  revision: string
  bindings: Map<string, Binding>
  definitions: Set<string>
  definitionRevisions: Map<string, { definitionRevision: number; modeRevision: number }>
  pending: { definitionId: string; action: string; definitionVersion: unknown; bindingRevision: unknown; resultHash: unknown; valid: boolean }[]
  commitHash: string | null
}

/** How the delegated lane reports a call whose outcome is unknown (the Python side raises these on a timeout). */
const UNRESOLVED_TRANSPORT = new Set(['RPC_TIMEOUT', 'RPC_SOCKET_CLOSED', 'RPC_SOCKET_ERROR', 'RPC_SEND_FAILED', 'INTENT_ALREADY_DISPATCHED'])

export function createMappingIntentBroker(deps: MappingIntentDeps): MappingIntentBroker {
  const actor = (): string => {
    const auth = deps.auth()

    return auth.kind === 'signed-in' && typeof auth.username === 'string' ? auth.username.trim().toLowerCase() : ''
  }

  const maxRecords = deps.maxRecords ?? 256
  const records = new Map<string, RequestRecord>()
  let running: string | null = null

  const base = `${deps.origin}/data-service`

  const remember = (requestId: string, record: RequestRecord): void => {
    records.set(requestId, record)

    if (records.size > maxRecords) {
      for (const [id, entry] of records) {
        if (records.size <= maxRecords) {
          break
        }

        if (entry.result && id !== requestId) {
          records.delete(id)
        }
      }
    }
  }

  // ── fence: environment generation, scope epoch, membership; checked before and after every await ──

  const assertFence = (request: { environment: EnvironmentFence | null; project: string; scopeEpoch: number; requestId?: string }): void => {
    if (!deps.isCurrent()) {
      throw new Stop('STALE_ENVIRONMENT')
    }

    const mine = deps.environment ?? null
    const theirs = request.environment

    if (
      (mine === null) !== (theirs === null) ||
      (mine && theirs && (mine.environmentId !== theirs.environmentId || mine.generation !== theirs.generation))
    ) {
      throw new Stop('STALE_ENVIRONMENT')
    }

    const auth = deps.auth()

    if (auth.kind !== 'signed-in' || !actor()) {
      throw new Stop('NOT_SIGNED_IN')
    }

    const record = request.requestId ? records.get(request.requestId) : undefined

    if (record && record.actor !== actor()) {
      throw new Stop('STALE_ENVIRONMENT')
    }

    const scope = deps.scope()

    if (scope.status !== 'ready') {
      throw new Stop('NOT_READY')
    }

    if (scope.project !== request.project || scope.epoch !== request.scopeEpoch) {
      throw new Stop('STALE_ENVIRONMENT')
    }

    const membership = auth.memberships.find(entry => entry.project === request.project)

    if (!membership) {
      throw new Stop('NOT_A_MEMBER')
    }

    if (membership.role !== 'editor' && membership.role !== 'owner') {
      throw new Stop('NOT_EDITOR')
    }
  }

  // ── member lane ──

  const memberFetch = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<PartitionResponse> => {
    try {
      return await deps.fetch({
        method,
        url: `${base}${path}`,
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' }, body: JSON.stringify(body) }
          : {})
      })
    } catch {
      throw new Stop('SESSION_UNAVAILABLE')
    }
  }

  const readSession = async (project: string, sessionId: string): Promise<Canonical> => {
    const response = await memberFetch('GET', `/mapping/sessions/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(project)}`)

    if (response.status !== 200) {
      throw new Stop('SESSION_UNAVAILABLE', { serverCode: errorCodeOf(parseBody(response)) })
    }

    const session = parseBody(response)

    if (!isRecord(session) || typeof session.revision !== 'string' || !REVISION.test(session.revision)) {
      throw new Stop('SESSION_UNAVAILABLE')
    }

    // A session without an advanced section has nothing to approve: every tuple is then stale.
    const advanced: Record<string, unknown> = isRecord(session.advanced) ? session.advanced : {}

    const bindings = new Map<string, Binding>()

    for (const entry of Array.isArray(advanced.bindings) ? advanced.bindings : []) {
      if (isRecord(entry) && typeof entry.definitionId === 'string') {
        bindings.set(entry.definitionId, {
          definitionId: entry.definitionId,
          revision: typeof entry.revision === 'number' ? entry.revision : null,
          resultStatus: typeof entry.resultStatus === 'string' ? entry.resultStatus : null,
          resultHash: typeof entry.resultHash === 'string' ? entry.resultHash : null,
          resultDefinitionVersion: typeof entry.resultDefinitionVersion === 'number' ? entry.resultDefinitionVersion : null,
          profileOffer: isRecord(entry.profileOffer) && typeof entry.profileOffer.selectorHash === 'string' && Number.isSafeInteger(entry.profileOffer.matchedCount) ? { selectorHash: entry.profileOffer.selectorHash, matchedCount: entry.profileOffer.matchedCount as number, countState: String(entry.profileOffer.countState) } : null
        })
      }
    }

    const definitions = new Set<string>()
    const definitionRevisions = new Map<string, { definitionRevision: number; modeRevision: number }>()

    for (const entry of Array.isArray(advanced.definitions) ? advanced.definitions : []) {
      if (isRecord(entry) && typeof entry.definitionId === 'string') {
        definitions.add(entry.definitionId)

        if (Number.isSafeInteger(entry.revision) && (entry.revision as number) >= 1 && Number.isSafeInteger(entry.modeRevision) && (entry.modeRevision as number) >= 0) {
          definitionRevisions.set(entry.definitionId, { definitionRevision: entry.revision as number, modeRevision: entry.modeRevision as number })
        }
      }
    }

    const pending = (Array.isArray(advanced.pending) ? advanced.pending : []).flatMap(entry =>
      isRecord(entry) && typeof entry.definitionId === 'string' && typeof entry.action === 'string'
        ? [
            {
              definitionId: entry.definitionId,
              action: entry.action,
              definitionVersion: entry.definitionVersion,
              bindingRevision: entry.bindingRevision,
              resultHash: entry.resultHash,
              valid: entry.valid === true
            }
          ]
        : []
    )

    const commit = isRecord(advanced.commit) ? advanced.commit : null

    return {
      revision: session.revision,
      bindings,
      definitions,
      definitionRevisions,
      pending,
      commitHash: commit && typeof commit.batchManifestHash === 'string' ? commit.batchManifestHash : null
    }
  }

  /** Every tuple must be the binding's current result: any other is stale (nothing is asked of the person). */
  const staleDefinitions = (request: MappingIntentRequest, session: Canonical): string[] => {
    if (request.action === 'commit') {
      return session.commitHash === request.commit.batchManifestHash && session.revision === request.commit.revision
        ? []
        : ['commit']
    }

    if (request.action === 'clear-preview') {
      return request.definitionIds.filter(id => !session.definitions.has(id))
    }

    return request.items
      .filter(item => {
        const binding = session.bindings.get(item.definitionId)

        return !(
          session.definitions.has(item.definitionId) &&
          binding &&
          binding.resultStatus === 'ok' &&
          binding.resultHash === item.resultHash &&
          binding.resultDefinitionVersion === item.definitionVersion &&
          binding.revision === item.bindingRevision &&
          (!item.generalization || (binding.profileOffer?.selectorHash === item.generalization.selectorHash && binding.profileOffer.matchedCount === item.generalization.matchedCount && binding.profileOffer.countState === item.generalization.countState))
        )
      })
      .map(item => item.definitionId)
  }

  const alreadyAnswered = (request: MappingIntentRequest, item: AnswerTuple, session: Canonical): boolean =>
    (request.action === 'approve' || request.action === 'skip') &&
    session.pending.some(
      entry =>
        entry.valid &&
        entry.definitionId === item.definitionId &&
        entry.action === request.action &&
        entry.definitionVersion === item.definitionVersion &&
        entry.bindingRevision === item.bindingRevision &&
        entry.resultHash === item.resultHash
    )

  interface Intent {
    intentId: string
    status: string
    scopeHash: string
    scope: unknown
    dialogDispatched: boolean
    operationId?: string
    operationState?: string
  }

  const parseIntent = (body: unknown, expect: { sessionId: string; project: string; action: string }): Intent => {
    const record = isRecord(body) ? body : null

    if (
      !record ||
      typeof record.intentId !== 'string' ||
      !INTENT_ID.test(record.intentId) ||
      typeof record.status !== 'string' ||
      record.action !== expect.action ||
      record.sessionId !== expect.sessionId ||
      record.project !== expect.project ||
      typeof record.scopeHash !== 'string' ||
      !HASH.test(record.scopeHash)
    ) {
      throw new Stop('CHALLENGE_MISMATCH')
    }

    const operation = isRecord(record.operation) ? record.operation : null

    return {
      intentId: record.intentId,
      status: record.status,
      scopeHash: record.scopeHash,
      scope: record.scope,
      dialogDispatched: record.dialogDispatched === true,
      ...(operation && typeof operation.operationId === 'string' ? { operationId: operation.operationId } : {}),
      ...(operation && typeof operation.state === 'string' ? { operationState: operation.state } : {})
    }
  }

  const readIntent = async (
    project: string,
    sessionId: string,
    intentId: string,
    action: string
  ): Promise<Intent> => {
    const response = await memberFetch(
      'GET',
      `/mapping/sessions/${encodeURIComponent(sessionId)}/human-intents/${encodeURIComponent(intentId)}?project=${encodeURIComponent(project)}`
    )

    if (response.status !== 200) {
      throw new Stop('SESSION_UNAVAILABLE', { serverCode: errorCodeOf(parseBody(response)) })
    }

    const intent = parseIntent(parseBody(response), { sessionId, project, action })

    if (intent.intentId !== intentId) {
      throw new Stop('CHALLENGE_MISMATCH')
    }

    return intent
  }

  const issueChallenge = async (
    request: MappingIntentStatusRequest,
    session: Canonical,
    action: string,
    requestId: string,
    scope: Record<string, unknown>
  ): Promise<Intent> => {
    const response = await memberFetch('POST', `/mapping/sessions/${encodeURIComponent(request.sessionId)}/human-intents`, {
      project: request.project,
      requestId,
      action,
      expectedRevision: session.revision,
      scope
    })

    const body = parseBody(response)

    if (response.status !== 200 && response.status !== 201) {
      throw new Stop('CHALLENGE_REFUSED', { serverCode: errorCodeOf(body) })
    }

    const intent = parseIntent(body, { sessionId: request.sessionId, project: request.project, action })

    // The server must have frozen exactly the scope main asked for; anything else is not what the person was told.
    if (canonical(isRecord(body) ? body.scope : null) !== canonical(scope)) {
      throw new Stop('CHALLENGE_MISMATCH')
    }

    return intent
  }

  // ── delegated lane ──

  const agent = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    try {
      return await deps.callAgent(method, params)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code

      if (typeof code === 'string' && UNRESOLVED_TRANSPORT.has(code)) {
        throw new Stop('UNRESOLVED', { serverCode: code, unresolved: true })
      }

      if (typeof code === 'string') {
        throw new Stop('FAILED', { serverCode: plainCode(code) })
      }

      // The scope controller's "no project scope is ready" has no code: nothing left main.
      throw new Stop('NOT_READY')
    }
  }

  const resultCode = (result: Record<string, unknown>): string | undefined => plainCode(result.code)

  /** The result of a protected operation (status ok) or its refusal. `unresolved` is a native outcome not known. */
  const checkOperation = (result: unknown, failure: MappingIntentCode): Record<string, unknown> => {
    if (!isRecord(result)) {
      throw new Stop('UNRESOLVED', { unresolved: true })
    }

    if (result.status === 'ok') {
      return result
    }

    if (result.unresolved === true || result.reason === 'NATIVE_OUTCOME_UNRESOLVED') {
      throw new Stop('UNRESOLVED', { serverCode: resultCode(result), unresolved: true })
    }

    throw new Stop(failure, { serverCode: resultCode(result) })
  }

  // ── one item: challenge -> native dialog -> server receipt -> protected operation ──

  const refOf = (intent: Intent, wire: string, definitionId?: string): MappingIntentRef => ({
    intentId: intent.intentId,
    action: wire,
    status: intent.status,
    ...(definitionId ? { definitionId } : {}),
    ...(intent.operationId ? { operationId: intent.operationId } : {}),
    ...(intent.operationState ? { operationState: intent.operationState } : {})
  })

  /**
   * Obtain a confirmed server receipt for `scope`: issue the challenge (idempotent by request id), show it in the
   * native dialog at most once per intent, then READ the receipt from the server. The dialog's own answer is never
   * proof; only the member-lane read of a `confirmed` challenge is.
   */
  const confirm = async (
    request: MappingIntentStatusRequest,
    session: Canonical,
    record: RequestRecord,
    key: string,
    wire: string,
    rid: string,
    scope: Record<string, unknown>,
    definitionId: string | undefined
  ): Promise<Intent> => {
    let step = record.steps.get(key)
    let intent = await issueChallenge(request, session, wire, rid, scope)

    assertFence(request)

    if (!step || step.intentId !== intent.intentId) {
      step = { intentId: intent.intentId, dispatched: false, called: false, done: false, ref: refOf(intent, wire, definitionId) }
      record.steps.set(key, step)
    }

    step.ref = refOf(intent, wire, definitionId)

    if (intent.status === 'pending' && intent.dialogDispatched) {
      throw new Stop('UNRESOLVED', { serverCode: 'INTENT_ALREADY_DISPATCHED', unresolved: true })
    }

    if (intent.status === 'pending' && !step.dispatched) {
      // Set before the call: whatever happens next, this intent never reaches the native dialog twice.
      step.dispatched = true

      let result: unknown = null
      let transport: Stop | null = null

      try {
        result = await agent('degram.mapping.advanced.confirmIntent', {
          sessionId: request.sessionId,
          intentId: intent.intentId,
          scope: intent.scope
        })
      } catch (error) {
        if (error instanceof Stop && error.code === 'UNRESOLVED') {
          transport = error
        } else {
          throw error instanceof Stop && error.code === 'FAILED' ? new Stop('NATIVE_REFUSED', { serverCode: error.serverCode }) : error
        }
      }

      assertFence(request)

      if (!transport && isRecord(result) && result.status === 'error' && result.unresolved !== true && result.reason !== 'NATIVE_OUTCOME_UNRESOLVED') {
        throw new Stop('NATIVE_REFUSED', { serverCode: resultCode(result) })
      }

      // Only an explicit Cancel from the dialog stops here; "confirmed" (or an unknown outcome) is settled below
      // against the server's receipt.
      if (!transport && isRecord(result) && result.status === 'ok' && result.decision !== 'confirmed') {
        throw new Stop('CANCELLED')
      }
    }
    // A pending challenge whose dialog was already dispatched is never shown again: only the status below.

    intent = await readIntent(request.project, request.sessionId, intent.intentId, wire)
    assertFence(request)

    if (canonical(intent.scope) !== canonical(scope)) {
      throw new Stop('CHALLENGE_MISMATCH')
    }

    step.ref = refOf(intent, wire, definitionId)

    if (intent.status === 'confirmed') {
      return intent
    }

    if (intent.status === 'cancelled') {
      throw new Stop('CANCELLED')
    }

    if (intent.status === 'pending') {
      throw new Stop('UNRESOLVED', { unresolved: true })
    }

    throw new Stop('PROOF_NOT_CONFIRMED', { serverCode: plainCode(intent.status.toUpperCase()) })
  }

  const itemScope = (request: MappingIntentRequest, index: number): Record<string, unknown> => {
    if (request.action === 'commit') {
      return { batchManifestHash: request.commit.batchManifestHash }
    }

    if (request.action === 'clear-preview') {
      return { definitionId: request.definitionIds[index] }
    }

    const item = request.items[index]

    return {
      definitionId: item.definitionId,
      definitionVersion: item.definitionVersion,
      resultHash: item.resultHash,
      bindingRevision: item.bindingRevision,
      ...(item.generalization ? { generalize: true, ...item.generalization } : {})
    }
  }

  const count = (request: MappingIntentRequest): number =>
    request.action === 'commit' ? 1 : request.action === 'clear-preview' ? request.definitionIds.length : request.items.length

  const definitionOf = (request: MappingIntentRequest, index: number): string | undefined =>
    request.action === 'commit' ? undefined : request.action === 'clear-preview' ? request.definitionIds[index] : request.items[index].definitionId

  const execute = async (request: MappingIntentRequest, record: RequestRecord): Promise<MappingIntentSuccess> => {
    assertFence(request)

    const wire = WIRE_ACTION[request.action]
    const total = count(request)
    let session: unknown
    let batch: unknown
    let operation: unknown

    // The only replayable write is the server's atomic plural DRAFT operation, not CAD/native actions.
    // Reuse its exact intent/request/scope so durable server records reconcile ambiguous responses.
    const pendingBulk = record.steps.get('advanced-bulk-approve')

    if (request.action === 'approve' && request.items.length > 1 && pendingBulk?.called) {
      if (!pendingBulk.intentId || !pendingBulk.bulkScope) {
        throw new Stop('UNRESOLVED', { unresolved: true })
      }

      const answer = checkOperation(await agent('degram.mapping.advanced.answers', {
        sessionId: request.sessionId, requestId: request.requestId,
        intentId: pendingBulk.intentId, scope: pendingBulk.bulkScope
      }), 'FAILED')

      assertFence(request)
      pendingBulk.done = true

      return { ok: true, requestId: request.requestId, action: request.action,
        intents: [...record.steps.values()].map(entry => ({ ...entry.ref })), session: scrub(answer.session) }
    }

    // 1. atomic precheck of the whole frozen list against the canonical session: any stale tuple refuses all,
    //    and nothing is asked of the person.
    let current = await readSession(request.project, request.sessionId)

    assertFence(request)

    const stale = staleDefinitions(request, current)

    if (stale.length > 0) {
      throw new Stop('STALE_TUPLE', { stale })
    }

    if (request.action === 'approve' || request.action === 'skip') {
      const answered = request.items.filter(item => alreadyAnswered(request, item, current)).map(item => item.definitionId)

      // A card already answered at exactly this tuple is not asked twice; a partly answered list is refused whole.
      if (answered.length > 0 && ![...record.steps.values()].some(step => step.called)) {
        throw new Stop('ALREADY_ANSWERED', { stale: answered })
      }
    }

    if (request.action === 'approve' && request.items.length > 1) {
      const items = [...request.items].sort((a, b) => a.definitionId.localeCompare(b.definitionId)).map(item => {
        const revisions = current.definitionRevisions.get(item.definitionId)

        if (!revisions) {
          throw new Stop('STALE_TUPLE', { stale: [item.definitionId] })
        }

        return { ...item, ...revisions }
      })

      const scope = { items }
      const key = 'advanced-bulk-approve'
      const existing = record.steps.get(key)

      if (existing?.called) {
        throw new Stop('UNRESOLVED', { unresolved: true })
      }

      const intent = await confirm(request, current, record, key, key, request.requestId, scope, undefined)
      const step = record.steps.get(key) as Step
      step.bulkScope = scope
      step.called = true

      const answer = checkOperation(await agent('degram.mapping.advanced.answers', {
        sessionId: request.sessionId, requestId: request.requestId, intentId: intent.intentId, scope
      }), 'FAILED')

      step.done = true
      assertFence(request)
      record.completed.push(...items.map(item => item.definitionId))

      return { ok: true, requestId: request.requestId, action: request.action,
        intents: [...record.steps.values()].map(entry => ({ ...entry.ref })), session: scrub(answer.session) }
    }

    // Single-item operations only; bulk approve takes the single atomic server transaction above.
    for (let index = 0; index < total; index += 1) {
      const definitionId = definitionOf(request, index)
      const key = `${wire}:${definitionId ?? 'commit'}`
      const existing = record.steps.get(key)

      if (existing?.done) {
        continue
      }

      if (existing?.called) {
        // The protected operation was already called with this proof: the outcome is read, never re-run.
        throw new Stop('UNRESOLVED', { unresolved: true })
      }

      if (index > 0) {
        current = await readSession(request.project, request.sessionId)
        assertFence(request)

        const laterStale = staleDefinitions(
          request.action === 'commit' || request.action === 'clear-preview'
            ? request
            : { ...request, items: request.items.slice(index) },
          current
        )

        if (laterStale.length > 0) {
          throw new Stop('STALE_TUPLE', { stale: laterStale })
        }
      }

      const rid = total === 1 ? request.requestId : `${request.requestId}:${index}`
      const scope = itemScope(request, index)
      const intent = await confirm(request, current, record, key, wire, rid, scope, definitionId)
      const step = record.steps.get(key) as Step

      // Set before the call: whatever it does, this proof is never offered to the operation twice.
      step.called = true

      if (request.action === 'approve' || request.action === 'skip') {
        const answer = checkOperation(
          await agent('degram.mapping.advanced.answer', {
            sessionId: request.sessionId,
            requestId: rid,
            intentId: intent.intentId,
            action: request.action,
            scope
          }),
          'FAILED'
        )

        session = answer.session
        record.completed.push(definitionOf(request, index) as string)
      } else if (request.action === 'commit') {
        const spec = request.commit

        const applied = checkOperation(
          await agent('degram.mapping.apply', {
            sessionId: request.sessionId,
            requestId: request.requestId,
            revision: spec.revision,
            answerIds: spec.answerIds,
            intentId: intent.intentId,
            ...(spec.designStateName === undefined ? {} : { designStateName: spec.designStateName }),
            ...(spec.designStateNameSource === undefined ? {} : { designStateNameSource: spec.designStateNameSource })
          }),
          'FAILED'
        )

        batch = applied.batch
      } else {
        const method = request.action === 'preview' ? 'degram.mapping.advanced.preview' : 'degram.mapping.advanced.clearPreview'
        const done = checkOperation(await agent(method, { sessionId: request.sessionId, intentId: intent.intentId }), 'FAILED')

        operation = { outcome: done.outcome ?? null, operationId: done.operationId ?? null, result: done.result ?? null }
      }

      step.done = true
      assertFence(request)
    }

    return {
      ok: true,
      requestId: request.requestId,
      action: request.action,
      intents: [...record.steps.values()].map(step => ({ ...step.ref })),
      ...(session === undefined ? {} : { session: scrub(session) }),
      ...(batch === undefined ? {} : { batch: scrub(batch) }),
      ...(operation === undefined ? {} : { operation: scrub(operation) })
    }
  }

  const failure = (request: { requestId: string; action: MappingIntentAction }, record: RequestRecord | null, error: unknown): MappingIntentFailure => {
    const stop = error instanceof Stop ? error : new Stop('FAILED')

    return {
      ok: false,
      requestId: request.requestId,
      action: request.action,
      code: stop.code,
      message: MESSAGES[stop.code],
      ...(stop.serverCode ? { serverCode: stop.serverCode } : {}),
      intents: record ? [...record.steps.values()].map(step => ({ ...step.ref })) : [],
      completed: record ? [...record.completed] : [],
      stale: [...stop.stale],
      ...(stop.unresolved ? { unresolved: true } : {})
    }
  }

  const run = (request: MappingIntentRequest): Promise<MappingIntentResult> => {
    try { assertFence(request) } catch (error) { return Promise.resolve(failure(request, null, error)) }
    const fingerprint = canonical(request)
    const known = records.get(request.requestId)

    if (known) {
      if (known.actor !== actor()) {
        return Promise.resolve(failure(request, null, new Stop('STALE_ENVIRONMENT')))
      }

      if (known.fingerprint !== fingerprint) {
        return Promise.resolve(failure(request, null, new Stop('REQUEST_CONFLICT')))
      }

      if (known.promise) {
        return known.promise
      }

      // A finished request: its answer is replayed, except an unresolved native outcome, which is resumed from the
      // recorded steps (a dispatched dialog is never dispatched again) so the status can settle.
      if (known.result && !(known.result.ok === false && known.result.code === 'UNRESOLVED')) {
        return Promise.resolve({ ...known.result, replayed: true })
      }
    }

    if (running && running !== request.requestId) {
      return Promise.resolve(failure(request, null, new Stop('BUSY')))
    }

    const record: RequestRecord = known ?? {
      actor: actor(),
      fingerprint,
      steps: new Map(),
      promise: null,
      result: null,
      completed: [],
      sessionId: request.sessionId,
      project: request.project
    }

    running = request.requestId

    const promise = (async (): Promise<MappingIntentResult> => {
      try {
        return await execute(request, record)
      } catch (error) {
        if (!(error instanceof Stop)) {
          deps.logger.warn('[degram] a mapping intent request failed unexpectedly')
        }

        return failure(request, record, error)
      }
    })().then(result => {
      record.result = result
      record.promise = null

      if (running === request.requestId) {
        running = null
      }

      return result
    })

    record.promise = promise
    record.result = null
    remember(request.requestId, record)

    return promise
  }

  const status = async (request: MappingIntentStatusRequest): Promise<MappingIntentStatusResult> => {
    try {
      assertFence(request)

      const record = records.get(request.requestId)

      if (!record || record.actor !== actor() || record.sessionId !== request.sessionId || record.project !== request.project) {
        throw new Stop('UNKNOWN_REQUEST')
      }

      const intents: MappingIntentRef[] = []

      for (const step of record.steps.values()) {
        if (!step.intentId) {
          continue
        }

        const intent = await readIntent(request.project, request.sessionId, step.intentId, step.ref.action)

        assertFence(request)
        step.ref = refOf(intent, step.ref.action, step.ref.definitionId)
        intents.push({ ...step.ref })
      }

      return { ok: true, requestId: request.requestId, intents }
    } catch (error) {
      const stop = error instanceof Stop ? error : new Stop('FAILED')

      return { ok: false, code: stop.code, message: MESSAGES[stop.code] }
    }
  }

  const recoverSnapshot = async (request: SnapshotRecoveryRequest): Promise<SnapshotRecoveryResult> => {
    try {
      assertFence(request)
      const owner = actor()

      const response = await memberFetch('POST', `/mapping/sessions/${encodeURIComponent(request.sessionId)}/snapshot/recover`,
        { project: request.project, batchId: request.batchId })

      assertFence(request)

      if (owner !== actor()) {throw new Stop('STALE_ENVIRONMENT')}

      if (response.status !== 200) {throw new Stop('FAILED')}
      const body = parseBody(response)

      if (!isRecord(body) || !['pending', 'published', 'failed', 'skipped'].includes(String(body.status))) {throw new Stop('FAILED')}

      // Closed projection: no server reason, geometry, destination or credential crosses IPC.
      return { ok: true, status: body.status as 'pending' | 'published' | 'failed' | 'skipped',
        ...(typeof body.stateId === 'string' && /^OS_[a-f0-9]{16}$/.test(body.stateId) ? { stateId: body.stateId } : {}) }
    } catch (error) {
      const stop = error instanceof Stop ? error : new Stop('FAILED')

      return { ok: false, code: stop.code, message: MESSAGES[stop.code] }
    }
  }

  return { run, status, recoverSnapshot }
}
