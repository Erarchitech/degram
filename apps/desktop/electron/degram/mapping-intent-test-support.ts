// mapping-intent-test-support.ts — injected seams of the human-intent broker suites (plan 1303-35 Task 2).
//
// Three scripted seams, all in-process (no Electron, network, filesystem or Revit):
//   * the DG data-service member lane (a PartitionFetch): sessions with an advanced section, human challenges,
//     CSRF and role checks, revision staleness, one-shot consumption;
//   * the native/agent lane (a gateway handler): the connector's dialog, the protected operations, every call and
//     every successful native write counted;
//   * a fake WebSocket that runs the REAL createGatewayRpc against that agent handler, so the error codes and
//     timeouts reach the broker exactly the way production delivers them.

import { createHash } from 'node:crypto'

import type { PartitionFetch, PartitionRequest, PartitionResponse } from './dg-session'
import type { WebSocketLike } from './gateway-rpc'

export const PROOF_SECRET = 'SECRET-PROOF-0123456789abcdef'
export const LEAKED_TOKEN = 'dgd_LEAKED-TOKEN-0123456789abcdef'
export const LEAKED_COOKIE = 'dg_session=LEAKED-COOKIE-0123456789abcdef'

export const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0')
export const definitionId = (n: number): string => `MD-${hex(n, 12)}`
export const resultHash = (n: number): string => hex(n, 64)
export const revisionOf = (n: number): string => hex(n, 24)

export class RpcFail extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

interface Intent {
  intentId: string
  requestId: string
  project: string
  sessionId: string
  action: string
  document: string
  sessionRevision: string
  scope: Record<string, unknown>
  scopeHash: string
  issuedBy: string
  dialogDispatched?: boolean
  status: 'cancelled' | 'claimed' | 'confirmed' | 'consumed' | 'pending'
  proofSecret: string
}

export interface FakeServerOptions {
  origin: string
  project: string
  sessionId: string
  /** Everything outside /mapping/ (the auth routes) is delegated to the standard fake DG. */
  base: PartitionFetch
}

export interface Logged {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

export function createFakeMappingServer(options: FakeServerOptions) {
  let counter = 1
  let intentSeq = 0
  const intents = new Map<string, Intent>()
  const byRequest = new Map<string, string>()
  const requests: Logged[] = []
  const flags = {
    signedIn: true,
    editor: true,
    /** Answer the next challenge POST with this refusal instead of a challenge. */
    refuseChallenge: null as null | { status: number; code: string },
    /** Freeze this scope instead of the one asked (a server that disagrees with main). */
    forceScope: null as null | Record<string, unknown>,
    /** The GET of the session fails. */
    sessionDown: false
  }

  const session = {
    revision: revisionOf(counter),
    document: 'Model.rvt',
    advanced: {
      definitions: [{ definitionId: definitionId(1), revision: 1, modeRevision: 0 }] as { definitionId: string; revision: number; modeRevision: number }[],
      bindings: [
        { definitionId: definitionId(1), revision: 4, resultStatus: 'ok', resultHash: resultHash(11), resultDefinitionVersion: 2 }
      ] as Record<string, unknown>[],
      pending: [] as Record<string, unknown>[],
      candidates: [] as unknown[],
      commit: null as null | { batchManifestHash: string }
    }
  }

  const bump = (): void => {
    counter += 1
    session.revision = revisionOf(counter)
  }

  const addDefinition = (n: number, binding: Record<string, unknown> = {}): void => {
    session.advanced.definitions.push({ definitionId: definitionId(n), revision: 1, modeRevision: 0 })
    session.advanced.bindings.push({
      definitionId: definitionId(n),
      revision: 4,
      resultStatus: 'ok',
      resultHash: resultHash(10 + n),
      resultDefinitionVersion: 2,
      ...binding
    })
  }

  const json = (status: number, body: unknown): PartitionResponse => ({ status, body: JSON.stringify(body) })
  const refuse = (status: number, code: string): PartitionResponse => json(status, { detail: { code } })

  const effective = (intent: Intent): Intent['status'] | 'stale' =>
    (intent.status === 'pending' || intent.status === 'confirmed') && intent.sessionRevision !== session.revision
      ? 'stale'
      : intent.status

  const publicIntent = (intent: Intent): Record<string, unknown> => ({
    intentId: intent.intentId,
    requestId: intent.requestId,
    project: intent.project,
    sessionId: intent.sessionId,
    action: intent.action,
    document: intent.document,
    sessionRevision: intent.sessionRevision,
    scope: intent.scope,
    scopeHash: intent.scopeHash,
    issuedBy: intent.issuedBy,
    status: effective(intent),
    dialogDispatched: intent.dialogDispatched === true,
    // A hypothetical server-side secret: it must never reach the renderer-bound result.
    proofSecret: intent.proofSecret
  })

  const fetch: PartitionFetch = async (request: PartitionRequest): Promise<PartitionResponse> => {
    const url = new URL(request.url)
    const prefix = `/data-service/mapping/sessions/${options.sessionId}`

    if (!url.pathname.startsWith('/data-service/mapping/')) {
      return options.base(request)
    }

    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...(request.headers ?? {}) },
      body: request.body ? JSON.parse(request.body) : null
    })

    if (!flags.signedIn) {
      return refuse(401, 'AUTH_REQUIRED')
    }

    if (url.pathname === prefix && request.method === 'GET') {
      if (flags.sessionDown) {
        return refuse(503, 'DG_DOWN')
      }

      return url.searchParams.get('project') === options.project ? json(200, session) : refuse(403, 'ACCESS_DENIED')
    }

    if (url.pathname === `${prefix}/human-intents` && request.method === 'POST') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, any>

      if (request.headers?.['X-DG-CSRF'] !== '1') {
        return refuse(403, 'CSRF_REQUIRED')
      }

      if (flags.refuseChallenge) {
        return refuse(flags.refuseChallenge.status, flags.refuseChallenge.code)
      }

      if (!flags.editor) {
        return refuse(403, 'INTENT_REVOKED')
      }

      if (body.project !== options.project) {
        return refuse(403, 'ACCESS_DENIED')
      }

      const known = byRequest.get(`${body.project}|${body.requestId}`)

      if (known) {
        return json(200, publicIntent(intents.get(known) as Intent))
      }

      if (body.expectedRevision !== session.revision) {
        return refuse(409, 'INTENT_STALE')
      }

      intentSeq += 1

      const scope = flags.forceScope ?? (body.scope as Record<string, unknown>)
      const core = JSON.stringify({ v: 1, action: body.action, project: body.project, sessionId: options.sessionId, sessionRevision: body.expectedRevision, document: session.document, scope })

      const intent: Intent = {
        intentId: `hi-${hex(intentSeq, 24)}`,
        requestId: body.requestId,
        project: body.project,
        sessionId: options.sessionId,
        action: body.action,
        document: session.document,
        sessionRevision: body.expectedRevision,
        scope,
        scopeHash: createHash('sha256').update(core).digest('hex'),
        issuedBy: 'alice',
        status: 'pending',
        proofSecret: PROOF_SECRET
      }

      intents.set(intent.intentId, intent)
      byRequest.set(`${body.project}|${body.requestId}`, intent.intentId)

      return json(200, publicIntent(intent))
    }

    const read = new RegExp(`^${prefix}/human-intents/(hi-[0-9a-f]{24})$`).exec(url.pathname)

    if (read && request.method === 'GET') {
      const intent = intents.get(read[1])

      return intent ? json(200, publicIntent(intent)) : refuse(404, 'INTENT_NOT_FOUND')
    }

    return refuse(404, 'NOT_FOUND')
  }

  // The connector's and the data-service's own steps (the broker never calls these over the member lane).
  const take = (intentId: string): Intent => {
    const intent = intents.get(intentId)

    if (!intent) {
      throw new RpcFail('INTENT_NOT_FOUND')
    }

    return intent
  }

  return {
    fetch,
    requests,
    flags,
    session,
    bump,
    addDefinition,
    intents,
    /** The person pressed Yes: the connector posted a positive receipt. */
    confirm: (intentId: string): void => {
      take(intentId).status = 'confirmed'
    },
    cancel: (intentId: string): void => {
      take(intentId).status = 'cancelled'
    },
    status: (intentId: string): string => effective(take(intentId)),
    /** Spend or claim a confirmed proof exactly once, for the exact action. */
    spend: (intentId: string, action: string, mode: 'claimed' | 'consumed'): Intent => {
      const intent = take(intentId)

      if (intent.action !== action) {
        throw new RpcFail('INTENT_HASH_CONFLICT')
      }

      if (intent.status === 'consumed' || intent.status === 'claimed') {
        throw new RpcFail('INTENT_ALREADY_CLAIMED')
      }

      if (effective(intent) !== 'confirmed') {
        throw new RpcFail('INTENT_NOT_CONFIRMED')
      }

      intent.status = mode

      return intent
    },
    /** Every challenge POST so far. */
    challenges: (): Logged[] => requests.filter(r => r.method === 'POST' && r.path.endsWith('/human-intents'))
  }
}

export type FakeMappingServer = ReturnType<typeof createFakeMappingServer>

export type DialogScript =
  | 'cancel'
  | 'confirm'
  | 'confirm-then-timeout'
  | 'lie-confirmed'
  | 'timeout'
  | 'unresolved'

export interface FakeAgentCall {
  method: string
  params: Record<string, any>
}

export function createFakeAgent(server: FakeMappingServer) {
  const calls: FakeAgentCall[] = []
  const state = {
    dialog: 'confirm' as DialogScript,
    dialogs: 0,
    nativeWrites: 0,
    /** Methods that never answer (a hung native call). */
    hang: new Set<string>(),
    /** Holds the dialog until released (a person who has not decided yet). */
    gate: null as null | Promise<void>,
    onDialog: null as null | ((intentId: string) => void),
    answerOverride: null as null | Record<string, unknown>,
    failMethod: null as null | { method: string; code: string },
    bulkTimeoutAfterWrite: false
  }
  const dispatched = new Set<string>()
  const bulkReplies = new Map<string, unknown>()

  const intentView = (intentId: string): Record<string, unknown> => ({ intentId, status: server.status(intentId) })

  const handle = async (method: string, params: Record<string, any>): Promise<unknown> => {
    calls.push({ method, params })

    if (state.failMethod?.method === method) {
      throw new RpcFail(state.failMethod.code)
    }

    if (method === 'degram.mapping.advanced.confirmIntent') {
      if (dispatched.has(params.intentId)) {
        throw new RpcFail('INTENT_ALREADY_DISPATCHED')
      }

      dispatched.add(params.intentId)
      state.dialogs += 1
      state.onDialog?.(params.intentId)

      if (state.gate) {
        await state.gate
      }

      const script = state.dialog

      if (script === 'timeout') {
        return new Promise(() => undefined)
      }

      if (script === 'unresolved') {
        return { status: 'error', code: 'BUSY', reason: 'NATIVE_OUTCOME_UNRESOLVED', unresolved: true }
      }

      if (script === 'cancel') {
        server.cancel(params.intentId)

        return { status: 'ok', outcome: 'cancelled', decision: 'cancelled', intent: intentView(params.intentId) }
      }

      if (script === 'lie-confirmed') {
        // The agent claims a person confirmed; the server never received a receipt.
        return { status: 'ok', outcome: 'confirmed', decision: 'confirmed', intent: { intentId: params.intentId, status: 'confirmed' } }
      }

      server.confirm(params.intentId)

      if (script === 'confirm-then-timeout') {
        return new Promise(() => undefined)
      }

      return { status: 'ok', outcome: 'confirmed', decision: 'confirmed', intent: intentView(params.intentId) }
    }

    if (method === 'degram.mapping.advanced.answers') {
      const key = `${params.intentId}|${params.requestId}|${JSON.stringify(params.scope)}`
      if (bulkReplies.has(key)) {
        return bulkReplies.get(key)
      }
      server.spend(params.intentId, 'advanced-bulk-approve', 'consumed')
      state.nativeWrites += 1
      server.bump()
      const reply = { status: 'ok', session: { sessionId: params.sessionId, revision: server.session.revision } }
      bulkReplies.set(key, reply)
      if (state.bulkTimeoutAfterWrite) {
        return new Promise(() => undefined)
      }
      return reply
    }

    if (method === 'degram.mapping.advanced.answer') {
      if (state.hang.has(method)) {
        return new Promise(() => undefined)
      }

      const wire = params.action === 'approve' ? 'advanced-approve' : 'advanced-skip'

      server.spend(params.intentId, wire, 'consumed')
      state.nativeWrites += 1
      server.session.advanced.pending.push({
        answerId: `a-${params.requestId}`,
        definitionId: params.scope.definitionId,
        action: params.action,
        definitionVersion: params.scope.definitionVersion,
        bindingRevision: params.scope.bindingRevision,
        resultHash: params.scope.resultHash,
        valid: true
      })
      server.bump()

      return (
        state.answerOverride ?? {
          status: 'ok',
          session: { sessionId: params.sessionId, revision: server.session.revision, advancedState: { complete: true }, token: LEAKED_TOKEN, cookie: LEAKED_COOKIE }
        }
      )
    }

    if (method === 'degram.mapping.advanced.preview' || method === 'degram.mapping.advanced.clearPreview') {
      if (state.hang.has(method)) {
        return new Promise(() => undefined)
      }

      server.spend(params.intentId, method.endsWith('preview') && !method.endsWith('clearPreview') ? 'preview-definition' : 'clear-definition-preview', 'claimed')
      state.nativeWrites += 1

      return { status: 'ok', outcome: 'completed', operationId: `op-${state.nativeWrites}`, result: { shown: true, csrf: LEAKED_COOKIE } }
    }

    if (method === 'degram.mapping.apply') {
      if (state.hang.has(method)) {
        return new Promise(() => undefined)
      }

      server.spend(params.intentId, 'advanced-commit', 'consumed')
      state.nativeWrites += 1

      return { status: 'ok', batch: { batchId: params.requestId, revision: params.revision, delivery: { state: 'queued' }, authorization: LEAKED_TOKEN } }
    }

    throw new RpcFail('DEGRAM_LOCKED')
  }

  return { calls, state, handle, methods: (): string[] => calls.map(c => c.method) }
}

export type FakeAgent = ReturnType<typeof createFakeAgent>

/**
 * A WebSocket class that answers JSON-RPC frames from the agent handler, so the REAL createGatewayRpc (its timeout, its
 * `data.code` mapping) is what the broker's delegated lane runs on.
 */
export function createFakeGatewaySocket(agent: FakeAgent): new (url: string) => WebSocketLike {
  return class FakeGatewaySocket implements WebSocketLike {
    readyState = 0
    private listeners = new Map<string, ((event: any) => void)[]>()

    constructor(readonly url: string) {
      queueMicrotask(() => this.emit('open', {}))
    }

    send(data: string): void {
      const frame = JSON.parse(data) as { id: string; method: string; params: Record<string, any> }

      agent.handle(frame.method, frame.params).then(
        result => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) }),
        (error: unknown) => {
          const code = error instanceof RpcFail ? error.code : 'INTERNAL'

          this.emit('message', {
            data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4090, message: code, data: { code } } })
          })
        }
      )
    }

    close(): void {}

    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }

    removeEventListener(): void {}

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event)
      }
    }
  }
}

/** The tuple the fake server's first definition shows. */
export const tupleOf = (n = 1): { definitionId: string; definitionVersion: number; resultHash: string; bindingRevision: number } => ({
  definitionId: definitionId(n),
  definitionVersion: 2,
  resultHash: resultHash(10 + n),
  bindingRevision: 4
})
