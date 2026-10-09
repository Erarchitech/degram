// request-lifecycle.ts — the state machine of one DeGram request (Phase 1301-14, D-17, D-18, DGCL-06/07).
//
//   idle -> previewing -> ready -> streaming -> done | interrupted | failed
//
// D-29: up to two documents are pinned (one per bridge). A preview reads both; a bridge whose document cannot be read
// is excluded from the request and shown as such, while Send stays available for the rest.
//
// The machine has exactly one way into `streaming`: the user's Send (`armSend` after the composer gate, then the
// stock submit path reports `markSent`). Nothing else sends: not a timer, not a retry, not a scope change. A
// preview is a read (it asks the bridge what would be sent); it never reaches the model. A failure stays on screen
// until the user retries (a click), narrows the context, or dismisses it, and a retry is a new, explicit Send.
//
// Authority: the agent owns the payload and the turn; this store is the renderer's cache of the user's view of
// them. Every entry is tagged with the scope it was read for (a project change empties it in the same render), and
// an answer for a stale preview id is dropped.

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import { $degramEnabled } from '@/store/degram-flag'
import { $gateway } from '@/store/gateway'

import {
  $documents,
  allPinnedMismatched,
  noteBridgeOutcome,
  noteDocumentsRead,
  pinnedApps,
  scopeKeyOf,
  syncDocumentsScope,
  unpin
} from './documents-store'
import { FORWARDED_TO_MAIN, type ParsedFailure, parseFailureText } from './outcome-copy'
import { routeDisagreesWithScope } from './scope-route'
import {
  type BridgeApp,
  cancelContext,
  type ContextPreview,
  type ContextScope,
  gatewayIdentity,
  type OutcomeInfo,
  previewContext,
  request,
  subscribeGatewayEvents
} from './use-degram-gateway'
import { $degram, degramBridge } from './use-degram-state'

export type Phase = 'done' | 'failed' | 'idle' | 'interrupted' | 'previewing' | 'ready' | 'streaming'

export interface FailureInfo {
  parsed: ParsedFailure
  /** The raw text the agent reported; kept for the diagnostics line, never the headline. */
  text: string
  app: BridgeApp | null
  elapsedSeconds: number
  /** The message the user sent, for a retry. */
  lastText: null | string
}

export interface Lifecycle {
  scopeKey: string
  phase: Phase
  scope: ContextScope
  preview: ContextPreview | null
  /** Id of the read in flight (a cancel names it). */
  previewId: null | string
  /** The read ended in an outcome: shown inline in the card with «Повторить чтение». */
  previewError: null | OutcomeInfo
  /** The preview a send already used: it cannot be sent twice. */
  sentPreviewId: null | string
  failure: FailureInfo | null
  confirmOpen: boolean
  sessionId: null | string
  startedAt: null | number
  lastText: null | string
}

const INITIAL: Lifecycle = {
  scopeKey: '',
  phase: 'idle',
  scope: 'selection',
  preview: null,
  previewId: null,
  previewError: null,
  sentPreviewId: null,
  failure: null,
  confirmOpen: false,
  sessionId: null,
  startedAt: null,
  lastText: null
}

export const $lifecycle = atom<Lifecycle>(INITIAL)

// -- pure transitions ---------------------------------------------------------------------------------------

export type LifecycleAction =
  | { type: 'failed'; failure: FailureInfo }
  | { type: 'interrupted' }
  | { type: 'preview-failed'; previewId: string; outcome: OutcomeInfo }
  | { type: 'preview-ok'; previewId: string; preview: ContextPreview }
  | { type: 'preview-start'; previewId: string }
  | { type: 'preview-stop' }
  | { type: 'sent'; sessionId: null | string; text: string; at: number }
  | { type: 'done' }

/**
 * The transition function. Total and pure; `ready -> streaming` exists only for `sent`, which only the submit
 * seam dispatches after a user Send. Illegal moves return the state unchanged.
 */
export function transition(state: Lifecycle, action: LifecycleAction): Lifecycle {
  switch (action.type) {
    case 'preview-start':
      // A read never starts while a turn streams (the next message's read starts when it ends).
      return state.phase === 'streaming'
        ? state
        : { ...state, phase: 'previewing', previewId: action.previewId, preview: null, previewError: null }

    case 'preview-ok':
      return state.phase === 'previewing' && state.previewId === action.previewId
        ? { ...state, phase: 'ready', previewId: null, preview: action.preview, previewError: null }
        : state

    case 'preview-failed':
      return state.phase === 'previewing' && state.previewId === action.previewId
        ? { ...state, phase: 'idle', previewId: null, preview: null, previewError: action.outcome }
        : state

    case 'preview-stop':
      return state.phase === 'previewing' ? { ...state, phase: 'idle', previewId: null } : state

    case 'sent':
      // Any resting phase may send (the gate decided); a send never starts while a turn already streams.
      return state.phase !== 'streaming'
        ? {
            ...state,
            phase: 'streaming',
            sentPreviewId: state.preview?.previewId ?? null,
            failure: null,
            sessionId: action.sessionId,
            startedAt: action.at,
            lastText: action.text
          }
        : state

    case 'done':
      return state.phase === 'streaming' ? { ...state, phase: 'done', sessionId: null, startedAt: null } : state

    case 'interrupted':
      return state.phase === 'streaming'
        ? { ...state, phase: 'interrupted', previewId: null, sessionId: null, startedAt: null }
        : state

    case 'failed':
      return state.phase === 'streaming'
        ? { ...state, phase: 'failed', failure: action.failure, sessionId: null, startedAt: null }
        : state
  }
}

function dispatch(action: LifecycleAction): void {
  $lifecycle.set(transition($lifecycle.get(), action))
}

// -- scope tagging ------------------------------------------------------------------------------------------

const currentKey = (): string => scopeKeyOf($degram.get())

/** Make the machine belong to the current scope; a different scope forgets the previous project's request. */
export function syncLifecycleScope(): void {
  const key = currentKey()

  if ($lifecycle.get().scopeKey !== key) {
    const previous = $lifecycle.get()

    if (previous.previewId) {
      void cancelContext(previous.previewId).catch(() => undefined)
    }

    clearArmed()
    $lifecycle.set({ ...INITIAL, scopeKey: key })
  }
}

/** The machine, or a blank one when it belongs to another scope than the current one (same-render reset). */
export function useLifecycle(): Lifecycle {
  const lifecycle = useStore($lifecycle)
  const key = scopeKeyOf(useStore($degram))

  return lifecycle.scopeKey === key ? lifecycle : { ...INITIAL, scopeKey: key }
}

export function resetLifecycle(scopeKey = ''): void {
  clearArmed()
  consentResolver = null
  $lifecycle.set({ ...INITIAL, scopeKey })
}

// -- preview (a read) ---------------------------------------------------------------------------------------

let previewCounter = 0

function newPreviewId(): string {
  previewCounter += 1
  const random = Math.floor(Math.random() * 0xffffffff).toString(16)

  // The agent accepts 1-64 of [A-Za-z0-9_-]: a client-chosen id lets a cancel name the read before it returns.
  return `pv_${Date.now().toString(36)}${previewCounter.toString(36)}${random}`
}

const RPC_TIMEOUT = /request timed out after (\d+(?:\.\d+)?)s/i

// A failure of the gateway connection itself (the socket is gone, never opened, or stopped answering heartbeats).
const GATEWAY_TRANSPORT = /gateway not connected|socket|websocket|connection|econn|network|heartbeat|closed|disconnected/i

/**
 * What a failed preview RPC means (1301-19, G-14). A timeout names itself and its seconds (the bridge's own BUSY comes
 * back as an answer, not as an exception), and only a broken gateway connection reads as «DG unreachable»: an error
 * the agent returned, or anything unrecognised, is the generic outcome instead of a wrong cause.
 */
export function classifyPreviewError(err: unknown): OutcomeInfo {
  const text = err instanceof Error ? err.message : String(err)
  const timeout = RPC_TIMEOUT.exec(text)

  if (timeout) {
    return { code: 'PREVIEW_TIMEOUT', message: `PREVIEW_TIMEOUT: request timed out after ${timeout[1]}s` }
  }

  if (GATEWAY_TRANSPORT.test(text)) {
    return { code: 'DG_UNAVAILABLE', message: text }
  }

  return { code: 'UNKNOWN', message: text }
}

/**
 * Read the pinned documents and show exactly what would be sent. Without a pinned document there is nothing to
 * read (the card says so and the request carries project data only). When every pinned document is known to be
 * gone or replaced no read is made at all; otherwise a mismatch on one bridge only leaves that document out.
 */
export async function refreshPreview(): Promise<void> {
  syncDocumentsScope()
  syncLifecycleScope()
  const key = currentKey()
  const state = $lifecycle.get()

  if (!key || state.phase === 'streaming') {
    return
  }

  const documents = $documents.get()

  if (state.previewId) {
    void cancelContext(state.previewId).catch(() => undefined)
  }

  // Nothing pinned, or every pinned document already known to be gone: the card says so, nothing is read.
  if (pinnedApps(documents).length === 0 || allPinnedMismatched(documents)) {
    $lifecycle.set({ ...state, phase: 'idle', previewId: null, preview: null, previewError: null })

    return
  }

  // Whole-definition scope belongs to the Grasshopper definition only: without that pin the read is the selection.
  const scope: ContextScope =
    state.scope === 'whole-definition' && documents.pinned.grasshopper ? 'whole-definition' : 'selection'

  const previewId = newPreviewId()
  const project = $degram.get().state?.scope.project ?? ''

  // Synchronous: the card shows the spinner and Send is disabled before the read could answer.
  dispatch({ type: 'preview-start', previewId })

  try {
    const result = await previewContext(scope, previewId, project)

    if (currentKey() !== key) {
      return
    }

    if (result.preview) {
      // Each bridge answers for its own document: one that was left out is marked (neutral dot, no silent switch), one
      // that was read is present after all.
      for (const row of result.preview.summary.excluded) {
        noteBridgeOutcome(row.app, row)
      }

      noteDocumentsRead(result.preview.summary.documents.map(doc => doc.app))
      dispatch({ type: 'preview-ok', previewId, preview: result.preview })

      return
    }

    // A cancelled read (Stop, a newer read) is not a failure to show.
    if (result.outcome.code === 'CANCELLED') {
      dispatch({ type: 'preview-stop' })

      return
    }

    dispatch({ type: 'preview-failed', previewId, outcome: result.outcome })
  } catch (error) {
    if (currentKey() === key) {
      dispatch({ type: 'preview-failed', previewId, outcome: classifyPreviewError(error) })
    }
  }
}

/** Choose what the next request carries. A read for the new scope starts; nothing is sent. */
export function setContextScope(scope: ContextScope): void {
  syncLifecycleScope()
  $lifecycle.set({ ...$lifecycle.get(), scope })
  void refreshPreview()
}

// -- consent (whole definition) -----------------------------------------------------------------------------

let consentResolver: ((granted: boolean) => void) | null = null

/** Open the whole-definition confirmation and wait for the user's answer. Nothing is sent before it resolves true. */
export function requestConsent(): Promise<boolean> {
  consentResolver?.(false)

  return new Promise<boolean>(resolve => {
    consentResolver = resolve
    $lifecycle.set({ ...$lifecycle.get(), confirmOpen: true })
  })
}

/** The dialog's answer. «Keep selection only» sends nothing and puts the scope back to the selection. */
export function resolveConsent(granted: boolean): void {
  const resolve = consentResolver
  consentResolver = null
  $lifecycle.set({ ...$lifecycle.get(), confirmOpen: false })

  // An answer with no question open (the dialog's own close beat after a confirmed send) changes nothing.
  if (!resolve) {
    return
  }

  resolve(granted)

  if (!granted) {
    setContextScope('selection')
  }
}

// -- send (the user's Send, through the composer gate) -------------------------------------------------------

interface Armed {
  previewId: string
  consent: boolean
  text: string
  at: number
}

let armed: Armed | null = null

/** An arming older than this never applies: a send the engine did not make (queued, steered) must not leak later. */
const ARMED_TTL_MS = 30_000

/** The arming is spent (the turn was accepted) or void (the gate ran again, the scope changed). */
export function clearArmed(): void {
  armed = null
}

/**
 * True while the ready scope's profile and the chat's active gateway route disagree: a turn would run on another
 * scope's backend and credential (G-7, D-19, T-1301-18-02). Independent of any pinned document.
 */
export function routeMismatch(): boolean {
  return $degramEnabled.get() && routeDisagreesWithScope($degram.get().state)
}

/**
 * Why Send is blocked right now, or null when it may proceed. `route-mismatch` holds whatever is pinned and comes
 * first; the other reasons are only meaningful while a document is pinned. `mismatch` means every pinned document
 * is gone or replaced (D-29: one document left out never blocks the rest) until the user selects again or unpins.
 */
export function sendBlockedReason(): 'mismatch' | 'previewing' | 'read-failed' | 'route-mismatch' | 'stale' | null {
  if (routeMismatch()) {
    return 'route-mismatch'
  }

  const key = currentKey()
  const documents = $documents.get()
  const state = $lifecycle.get()

  if (
    !$degramEnabled.get() ||
    !key ||
    pinnedApps(documents).length === 0 ||
    state.scopeKey !== key ||
    documents.scopeKey !== key
  ) {
    return null
  }

  if (allPinnedMismatched(documents)) {
    return 'mismatch'
  }

  if (state.phase === 'previewing') {
    return 'previewing'
  }

  if (state.previewError) {
    return 'read-failed'
  }

  if (!state.preview || state.preview.previewId === state.sentPreviewId) {
    return 'stale'
  }

  return null
}

/**
 * The composer middleware: the gate every send of the DeGram variant passes. With no pinned document the stock
 * path runs (project data only). With one, a send needs a ready, unused preview, and a whole-definition scope
 * needs the user's confirmation first; anything else cancels the send (the draft stays in the composer).
 */
export async function composerGate<T extends { text: string }>(draft: T): Promise<T | null> {
  try {
    if (!$degramEnabled.get() || !currentKey()) {
      return draft
    }

    syncDocumentsScope()
    syncLifecycleScope()
    clearArmed()

    // A route that is not on the scope's profile blocks every send, pinned document or not (G-7).
    if (routeMismatch()) {
      return null
    }

    if (pinnedApps($documents.get()).length === 0) {
      return draft
    }

    if (sendBlockedReason() !== null) {
      return null
    }

    const preview = $lifecycle.get().preview as ContextPreview
    let consent = false

    if (preview.requiresConsent) {
      consent = await requestConsent()

      if (!consent) {
        return null
      }

      // The scope or the document may have changed while the dialog was open: the consent was for a payload that
      // is no longer the one on the card.
      if (sendBlockedReason() !== null || $lifecycle.get().preview?.previewId !== preview.previewId) {
        return null
      }
    }

    armed = { previewId: preview.previewId, consent, text: draft.text, at: Date.now() }

    return draft
  } catch {
    // Unlike a plugin, this gate fails closed: a broken gate must not send without the disclosed context.
    return null
  }
}

export interface SendPlan {
  previewId: string
  consent: boolean
}

/**
 * The arming for exactly this text. Not consumed on read: the stock submit retries a busy session with the same
 * call, and that retry must still carry the context the card disclosed. `clearArmed` ends it once accepted.
 */
export function takeSendPlan(text: string): null | SendPlan {
  if (!armed || armed.text !== text || Date.now() - armed.at > ARMED_TTL_MS) {
    return null
  }

  return { previewId: armed.previewId, consent: armed.consent }
}

/** The stock submit path dispatched the turn: the machine enters `streaming`. */
export function markSent(sessionId: null | string, text: string): void {
  dispatch({ type: 'sent', sessionId, text, at: Date.now() })
}

/** The dispatch itself was refused (a named outcome such as CONSENT_REQUIRED, or a transport error). */
export function markSendFailed(message: string): void {
  failTurn(message)
}

// -- the turn's end -------------------------------------------------------------------------------------------

function forwardToMain(code: null | string): void {
  if (code && FORWARDED_TO_MAIN.includes(code)) {
    void degramBridge()
      ?.reportOutcome(code)
      .catch(() => undefined)
  }
}

function afterTurn(): void {
  // The next message gets a fresh read of the selection; reading is not sending.
  void refreshPreview()
}

/** The bridge a failure can be pinned on: the only pinned one (with two pins the failure text cannot say). */
function singlePinnedApp(): BridgeApp | null {
  const apps = pinnedApps($documents.get())

  return apps.length === 1 ? (apps[0] ?? null) : null
}

function failTurn(text: string): void {
  const state = $lifecycle.get()
  const parsed = parseFailureText(text)

  dispatch({
    type: 'failed',
    failure: {
      parsed,
      text,
      app: singlePinnedApp(),
      elapsedSeconds: state.startedAt ? Math.max(0, (Date.now() - state.startedAt) / 1000) : 0,
      lastText: state.lastText
    }
  })
  forwardToMain(parsed.code)
  afterTurn()
}

interface TurnPayload {
  status?: unknown
  error?: unknown
  message?: unknown
  text?: unknown
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Turn events of the session this request was sent to: complete, interrupted or failed. */
export function handleTurnEvent(event: { type: string; session_id?: string; payload?: unknown }): void {
  const state = $lifecycle.get()

  if (state.phase !== 'streaming' || (state.sessionId && event.session_id && event.session_id !== state.sessionId)) {
    return
  }

  const payload = (event.payload ?? {}) as TurnPayload

  if (event.type === 'message.complete') {
    if (payload.status === 'error') {
      failTurn(str(payload.error) || str(payload.text))

      return
    }

    if (payload.status === 'interrupted') {
      dispatch({ type: 'interrupted' })
      afterTurn()

      return
    }

    dispatch({ type: 'done' })
    afterTurn()

    return
  }

  if (event.type === 'error') {
    failTurn(str(payload.message))
  }
}

let eventBinding: null | { identity: object | null; off: () => void } = null

/** Follow the active gateway's turn events (re-binds when the gateway is swapped). Returns the disposer. */
export function bindTurnEvents(): () => void {
  const identity = gatewayIdentity()

  if (eventBinding && eventBinding.identity === identity) {
    return unbindTurnEvents
  }

  eventBinding?.off()
  eventBinding = { identity, off: subscribeGatewayEvents(handleTurnEvent) }

  return unbindTurnEvents
}

export function unbindTurnEvents(): void {
  eventBinding?.off()
  eventBinding = null
}

/**
 * The live wiring (mounted once by the shell host): the machine follows every gateway activation, so a completion,
 * an interruption or a failure of the turn ends the request in the same render it arrives. Returns the disposer.
 */
export function startTurnEventSync(): () => void {
  const stop = $gateway.subscribe(() => {
    bindTurnEvents()
  })

  return () => {
    stop()
    unbindTurnEvents()
  }
}

// -- stop, retry, dismiss -------------------------------------------------------------------------------------

/**
 * One Stop, painted in the current frame: the read in flight is abandoned and a streaming turn becomes
 * `interrupted` before any RPC returns. The bridge read is aborted (`degram.context.cancel`, once); the caller
 * that owns the interrupt RPC passes it so it is sent once too.
 */
export function stopRequest(options: { interrupt?: () => Promise<unknown> } = {}): void {
  const state = $lifecycle.get()
  const hadRead = state.phase === 'previewing'
  const wasStreaming = state.phase === 'streaming'

  clearArmed()
  dispatch(hadRead ? { type: 'preview-stop' } : { type: 'interrupted' })

  if (hadRead || wasStreaming) {
    // The next read starts only after the cancel settled, so the cancel cannot abort it.
    const cancelled = cancelContext(hadRead ? (state.previewId ?? undefined) : undefined).catch(() => undefined)

    if (wasStreaming) {
      void cancelled.then(afterTurn)
    }
  }

  void options.interrupt?.()?.catch(() => undefined)
}

/** Interrupt the live turn of a session through the gateway (`session.interrupt`). */
export function interruptSession(sessionId: null | string): () => Promise<unknown> {
  return () => (sessionId ? request('session.interrupt', { session_id: sessionId }) : Promise.resolve())
}

export function dismissFailure(): void {
  $lifecycle.set({ ...$lifecycle.get(), failure: null })
}

/** «Сузить контекст»: back to the selection, the failure gone, a fresh read. Nothing is sent. */
export function narrowContext(): void {
  $lifecycle.set({ ...$lifecycle.get(), failure: null, scope: 'selection' })
  void refreshPreview()
}

/**
 * «Повторить запрос»: an explicit new Send of the last message. The context is re-read first (the previous
 * preview was used), and the message goes through the composer's own submit, so the gate, the consent and the
 * transcript behave exactly as for a typed message. Only ever called from a click.
 */
export async function retryRequest(submit: (text: string) => Promise<boolean> | boolean): Promise<boolean> {
  const text = $lifecycle.get().failure?.lastText ?? $lifecycle.get().lastText

  if (!text) {
    return false
  }

  $lifecycle.set({ ...$lifecycle.get(), failure: null })

  if (pinnedApps($documents.get()).length > 0) {
    await refreshPreview()
  }

  return Boolean(await submit(text))
}

/** Unpin one bridge's document, or both with no argument (the escape from a blocked send). The other pin stays. */
export async function unpinDocument(app?: BridgeApp): Promise<void> {
  // Whole-definition is a Grasshopper-only scope: without that pin the card is back on the selection.
  if (!app || app === 'grasshopper') {
    $lifecycle.set({ ...$lifecycle.get(), scope: 'selection' })
  }

  await unpin(app)
  await refreshPreview()
}
