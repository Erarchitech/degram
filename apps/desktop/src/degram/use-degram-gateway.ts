// use-degram-gateway.ts — a thin typed wrapper over the renderer's JSON-RPC client for the DeGram reads
// (Phase 1301-14). The wire contract is `tui_gateway/contracts/degram.py` (plan 11): every RPC answers `ok` with a
// `status` of `ok` or `error`; an error carries a named operational outcome (`code`, optional `reason`,
// `bridgeState`), and only requests refused for what they are come back as JSON-RPC errors with `data.code`.
//
// The generated result types leave the nested payloads as `unknown`, so each answer is normalized here once and
// the rest of the renderer works with the narrow shapes below. Nothing in this file sends a model request on its
// own: `send` is only ever called from the composer pipeline after the user pressed Send.

import { type GatewayEvent } from '@hermes/shared'

import { $gateway, activeGateway } from '@/store/gateway'

export type BridgeApp = 'grasshopper' | 'revit'

/** The bridges, in the order the strip and the picker show them. */
export const BRIDGE_APPS: readonly BridgeApp[] = ['revit', 'grasshopper']

export type BridgeStateName = 'busy' | 'identity-mismatch' | 'off' | 'pinned' | 'ready' | 'setup-incomplete'

export type ContextScope = 'selection' | 'whole-definition'

/** A named operational outcome (spec/degram/OPERATIONAL-OUTCOMES.md) as the RPCs return it. */
export interface OutcomeInfo {
  code: string
  reason?: string
  message?: string
  bridgeState?: string
}

export interface DocumentRow {
  app: BridgeApp
  name: string
  path: null | string
  unsaved: boolean
  identity: null | Record<string, unknown>
  pinned: boolean
}

export interface BridgeGroup {
  app: BridgeApp
  state: BridgeStateName
  documents: DocumentRow[]
  code?: string
  reason?: string
  message?: string
}

export interface PinnedDocument {
  app: BridgeApp
  name: string
  path: null | string
  unsaved: boolean
  identity: Record<string, unknown>
}

export interface ContextSummary {
  project: string
  document: null | { app: string; name: string; path: null | string }
  objects: number
  parameters: number
  rules: number
  fragments: number
  bytes: number
  emptySelection: boolean
}

export interface TruncationEntry {
  what: string
  kept: number
  total: number
}

export interface MissingEntry {
  what: string
  reason?: string
}

export interface ContextPreview {
  previewId: string
  scope: string
  requestedScope: string
  requiresConsent: boolean
  /** The exact text that goes to the model, byte for byte (plan 11: preview == sent payload). */
  payload: string
  summary: ContextSummary
  truncation: TruncationEntry[]
  missing: MissingEntry[]
}

export type RpcRequest = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

export interface EventSource {
  onEvent: (handler: (event: GatewayEvent) => void) => () => void
}

let requestOverride: null | RpcRequest = null
let eventsOverride: EventSource | null = null

/** Tests inject a scripted gateway; pass null to restore the live one. */
export function setDegramGatewayForTests(request: null | RpcRequest, events: EventSource | null = null): void {
  requestOverride = request
  eventsOverride = events
}

const asRecord = (value: unknown): null | Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (requestOverride) {
    return requestOverride<T>(method, params, timeoutMs)
  }

  const gateway = activeGateway()

  if (!gateway) {
    return Promise.reject(new Error('gateway not connected'))
  }

  return gateway.request<T>(method, params, timeoutMs)
}

/** Subscribe to the active gateway's event stream (turn completion and failure). Returns the disposer. */
export function subscribeGatewayEvents(handler: (event: GatewayEvent) => void): () => void {
  if (eventsOverride) {
    return eventsOverride.onEvent(handler)
  }

  // `$gateway` is the active socket, republished by every activation: the value a subscription must follow.
  const gateway = $gateway.get()

  return gateway ? gateway.onEvent(handler) : () => undefined
}

/** Identity of the live gateway, so a subscription can follow a gateway swap. */
export function gatewayIdentity(): object | null {
  return eventsOverride ?? $gateway.get()
}

const isApp = (value: unknown): value is BridgeApp => value === 'grasshopper' || value === 'revit'

const BRIDGE_STATES: readonly string[] = ['busy', 'identity-mismatch', 'off', 'pinned', 'ready', 'setup-incomplete']

/** `status: error` answers (and anything without `status: ok`) as an outcome; null for an ok answer. */
export function outcomeOf(raw: unknown): null | OutcomeInfo {
  const data = asRecord(raw)

  if (data?.status === 'ok') {
    return null
  }

  return {
    code: asString(data?.code) ?? 'UNKNOWN',
    reason: asString(data?.reason),
    message: asString(data?.message),
    bridgeState: asString(data?.bridgeState)
  }
}

function parseRow(app: BridgeApp, raw: unknown): DocumentRow | null {
  const row = asRecord(raw)

  if (!row || !asString(row.name)) {
    return null
  }

  return {
    app,
    name: row.name as string,
    path: asString(row.path) ?? null,
    unsaved: row.unsaved === true,
    identity: asRecord(row.identity),
    pinned: row.pinned === true
  }
}

export function parseGroups(raw: unknown): BridgeGroup[] {
  const groups = asRecord(raw)?.groups

  if (!Array.isArray(groups)) {
    return []
  }

  const out: BridgeGroup[] = []

  for (const entry of groups) {
    const group = asRecord(entry)
    const app = group?.app

    if (!group || !isApp(app)) {
      continue
    }

    const state = BRIDGE_STATES.includes(group.state as string) ? (group.state as BridgeStateName) : 'off'

    const documents = (Array.isArray(group.documents) ? group.documents : []).flatMap(doc => {
      const row = parseRow(app, doc)

      return row ? [row] : []
    })

    out.push({
      app,
      state,
      documents,
      code: asString(group.code),
      reason: asString(group.reason),
      message: asString(group.message)
    })
  }

  return out
}

export function parsePinned(raw: unknown): null | PinnedDocument {
  const pinned = asRecord(asRecord(raw)?.pinned)
  const app = pinned?.app

  if (!pinned || !isApp(app) || !asString(pinned.name)) {
    return null
  }

  return {
    app,
    name: pinned.name as string,
    path: asString(pinned.path) ?? null,
    unsaved: pinned.unsaved === true,
    identity: asRecord(pinned.identity) ?? {}
  }
}

function parseSummary(raw: unknown, fallbackProject: string): ContextSummary {
  const summary = asRecord(raw)
  const document = asRecord(summary?.document)

  return {
    project: asString(summary?.project) ?? fallbackProject,
    document: document
      ? {
          app: asString(document.app) ?? '',
          name: asString(document.name) ?? '',
          path: asString(document.path) ?? null
        }
      : null,
    objects: asCount(summary?.objects),
    parameters: asCount(summary?.parameters),
    rules: asCount(summary?.rules),
    fragments: asCount(summary?.fragments),
    bytes: asCount(summary?.bytes),
    emptySelection: summary?.emptySelection === true
  }
}

export function parsePreview(raw: unknown, fallbackProject = ''): ContextPreview | null {
  const data = asRecord(raw)
  const previewId = asString(data?.previewId)
  const payload = typeof data?.payload === 'string' ? data.payload : null

  if (!data || data.status !== 'ok' || !previewId || payload === null) {
    return null
  }

  const truncation = (Array.isArray(data.truncation) ? data.truncation : []).flatMap(entry => {
    const item = asRecord(entry)

    return item && asString(item.what)
      ? [{ what: item.what as string, kept: asCount(item.kept), total: asCount(item.total) }]
      : []
  })

  const missing = (Array.isArray(data.missing) ? data.missing : []).flatMap(entry => {
    const item = asRecord(entry)

    return item && asString(item.what) ? [{ what: item.what as string, reason: asString(item.reason) }] : []
  })

  return {
    previewId,
    scope: asString(data.scope) ?? 'selection',
    requestedScope: asString(data.requestedScope) ?? asString(data.scope) ?? 'selection',
    requiresConsent: data.requiresConsent === true,
    payload,
    summary: parseSummary(data.summary, fallbackProject),
    truncation,
    missing
  }
}

export interface ListResult {
  groups: BridgeGroup[]
  pinned: null | PinnedDocument
  outcome: null | OutcomeInfo
}

/** One bridge's open documents (the picker loads each group on its own). */
export async function listDocuments(app?: BridgeApp): Promise<ListResult> {
  const raw = await request<unknown>('degram.documents.list', app ? { app } : {})

  return { groups: parseGroups(raw), pinned: parsePinned(raw), outcome: outcomeOf(raw) }
}

export async function pinDocument(
  app: BridgeApp,
  identity: Record<string, unknown>
): Promise<{ outcome: null | OutcomeInfo; pinned: null | PinnedDocument }> {
  const raw = await request<unknown>('degram.documents.pin', { app, identity })

  return { outcome: outcomeOf(raw), pinned: parsePinned(raw) }
}

export async function unpinDocument(): Promise<void> {
  await request<unknown>('degram.documents.pin', { app: null })
}

export type PreviewResult = { outcome: OutcomeInfo; preview: null } | { outcome: null; preview: ContextPreview }

/** Read the pinned document and get the exact payload. `previewId` is chosen by the caller so a cancel can name it. */
export async function previewContext(
  scope: ContextScope | 'none',
  previewId: string,
  project: string
): Promise<PreviewResult> {
  const raw = await request<unknown>('degram.context.preview', { scope, previewId })
  const preview = parsePreview(raw, project)

  if (preview) {
    return { outcome: null, preview }
  }

  return { outcome: outcomeOf(raw) ?? { code: 'UNKNOWN' }, preview: null }
}

export async function cancelContext(previewId?: string): Promise<void> {
  await request<unknown>('degram.context.cancel', previewId ? { previewId } : {})
}

export interface SendParams {
  session_id: string
  previewId: string
  text: string
  consent: boolean
}

/** Submit a turn whose message embeds the previewed payload. Resolves with the `prompt.submit` result. */
export async function sendContext<T>(params: SendParams, timeoutMs?: number, rpc: RpcRequest = request): Promise<T> {
  const raw = await rpc<unknown>('degram.context.send', { ...params }, timeoutMs)
  const outcome = outcomeOf(raw)

  if (outcome) {
    throw new DegramOutcomeError(outcome)
  }

  return asRecord(raw)?.submit as T
}

/** A send that ended in a named outcome (CONSENT_REQUIRED, ...): thrown so the stock submit path reports a failure. */
export class DegramOutcomeError extends Error {
  readonly outcome: OutcomeInfo

  constructor(outcome: OutcomeInfo) {
    super(`${outcome.code}: ${outcome.message ?? outcome.reason ?? outcome.code}`)
    this.name = 'DegramOutcomeError'
    this.outcome = outcome
  }
}
