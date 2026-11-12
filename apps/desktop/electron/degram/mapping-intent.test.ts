// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import type { AuthState } from './dg-session'
import { createGatewayRpc } from './gateway-rpc'
import {
  createMappingIntentBroker,
  type MappingIntentRequest,
  type MappingIntentResult,
  parseMappingIntentRequest,
  parseMappingIntentStatusRequest,
  parseSnapshotRecoveryRequest
} from './mapping-intent'
import {
  createFakeAgent,
  createFakeGatewaySocket,
  createFakeMappingServer,
  definitionId,
  LEAKED_COOKIE,
  LEAKED_TOKEN,
  PROOF_SECRET,
  resultHash,
  revisionOf,
  tupleOf
} from './mapping-intent-test-support'
import type { ScopeState } from './scope'
import { createFakeDg } from './test-support'

const SESSION_ID = 'ms-000000000001'
const ENV = { environmentId: 'env-a', generation: 3 }

function rig(options: { role?: string; maxRecords?: number; timeoutMs?: number } = {}) {
  const dg = createFakeDg()
  const server = createFakeMappingServer({ origin: dg.origin, project: 'alpha', sessionId: SESSION_ID, base: dg.fetch })
  const agent = createFakeAgent(server)
  const rpc = createGatewayRpc({ WebSocketImpl: createFakeGatewaySocket(agent), timeoutMs: options.timeoutMs ?? 40 })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  const ctx = {
    current: true,
    auth: {
      kind: 'signed-in',
      username: 'alice',
      isAdmin: false,
      memberships: [{ project: 'alpha', role: options.role ?? 'editor', company: 'ACME' }]
    } as AuthState,
    scope: { status: 'ready', project: 'alpha', company: 'ACME', profile: 'p', epoch: 5, error: null } as ScopeState
  }

  const broker = createMappingIntentBroker({
    environment: ENV,
    origin: dg.origin,
    fetch: server.fetch,
    // The real gateway-rpc, stamped with the environment generation exactly like the backend handle in main.
    callAgent: (method, params) => rpc('ws://127.0.0.1/api/ws?token=session', method, { ...params, _degram_environment: ENV }),
    auth: () => ctx.auth,
    scope: () => ctx.scope,
    isCurrent: () => ctx.current,
    logger,
    maxRecords: options.maxRecords
  })

  /** An IPC payload, validated like registerDegramIpc does. */
  const req = (over: Record<string, unknown> = {}): MappingIntentRequest =>
    parseMappingIntentRequest({
      environment: ENV,
      project: 'alpha',
      scopeEpoch: 5,
      sessionId: SESSION_ID,
      requestId: 'req-0001',
      action: 'approve',
      items: [tupleOf(1)],
      ...over
    })

  const statusReq = (over: Record<string, unknown> = {}) =>
    parseMappingIntentStatusRequest({ environment: ENV, project: 'alpha', scopeEpoch: 5, sessionId: SESSION_ID, requestId: 'req-0001', ...over })

  const nothingHappened = (): void => {
    expect(server.requests).toEqual([])
    expect(agent.calls).toEqual([])
    expect(agent.state.nativeWrites).toBe(0)
  }

  const noNativeWrite = (): void => {
    expect(agent.state.nativeWrites).toBe(0)
    expect(agent.methods().filter(m => m !== 'degram.mapping.advanced.confirmIntent')).toEqual([])
  }

  return { dg, server, agent, ctx, broker, req, statusReq, nothingHappened, noNativeWrite, logger }
}

const noSecrets = (value: unknown): void => {
  const text = JSON.stringify(value)

  for (const secret of [PROOF_SECRET, LEAKED_TOKEN, LEAKED_COOKIE, 'dg_session', 'X-DG-CSRF']) {
    expect(text).not.toContain(secret)
  }
}

const ok = (result: MappingIntentResult) => {
  if (result.ok === false) {
    throw new Error(`expected ok, got ${result.code}`)
  }

  return result
}

describe('snapshot publication recovery', () => {
  const request = () => parseSnapshotRecoveryRequest({ environment: ENV, project: 'alpha', scopeEpoch: 5,
    sessionId: SESSION_ID, batchId: 'batch-001' })

  it('uses only the fixed member route and returns a closed projection', async () => {
    const r = rig()
    const fetch = vi.fn(async () => ({ status: 200, body: JSON.stringify({ status: 'published', stateId: 'OS_0123456789abcdef',
      token: LEAKED_TOKEN, reason: LEAKED_COOKIE }) }))
    const callAgent = vi.fn()
    const broker = createMappingIntentBroker({ environment: ENV, origin: r.dg.origin, fetch, callAgent,
      auth: () => r.ctx.auth, scope: () => r.ctx.scope, isCurrent: () => r.ctx.current, logger: r.logger })
    const result = await broker.recoverSnapshot(request())
    expect(result).toEqual({ ok: true, status: 'published', stateId: 'OS_0123456789abcdef' })
    noSecrets(result)
    expect(callAgent).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST',
      url: expect.stringContaining(`/mapping/sessions/${SESSION_ID}/snapshot/recover`),
      body: JSON.stringify({ project: 'alpha', batchId: 'batch-001' }) }))
  })

  it('refuses viewer, stale scope and untrusted extra fields before any request', async () => {
    const r = rig({ role: 'viewer' })
    expect(await r.broker.recoverSnapshot(request())).toMatchObject({ ok: false, code: 'NOT_EDITOR' })
    r.ctx.scope = { ...r.ctx.scope, epoch: 7 } as ScopeState
    expect(await r.broker.recoverSnapshot(request())).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    r.nothingHappened()
    expect(() => parseSnapshotRecoveryRequest({ ...request(), url: 'http://other' })).toThrow()
  })

  it('drops a late result after A to B to A scope changes', async () => {
    const r = rig()
    const fetch = vi.fn(async () => {
      r.ctx.scope = { ...r.ctx.scope, epoch: 7 } as ScopeState

      return { status: 200, body: JSON.stringify({ status: 'published' }) }
    })
    const broker = createMappingIntentBroker({ environment: ENV, origin: r.dg.origin, fetch,
      callAgent: vi.fn(), auth: () => r.ctx.auth, scope: () => r.ctx.scope,
      isCurrent: () => true, logger: r.logger })
    expect(await broker.recoverSnapshot(request())).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
  })
})

describe('verified future profile opt-in', () => {
  it('freezes the canonical offer in a single approval without expanding current items', async () => {
    const r = rig()
    r.server.session.advanced.bindings[0].profileOffer = { selectorHash: 'a'.repeat(16), matchedCount: 7, countState: 'unknown' }
    const generalization = { selectorHash: 'a'.repeat(16), matchedCount: 7, countState: 'unknown' }
    const result = await r.broker.run(r.req({ items: [{ ...tupleOf(1), generalization }] }))
    expect(result.ok).toBe(true)
    const challenge = r.server.requests.find(x => x.method === 'POST' && x.path.endsWith('/human-intents'))
    expect(challenge?.body).toMatchObject({ scope: { generalize: true, ...generalization, definitionId: definitionId(1) } })
    expect(r.agent.state.dialogs).toBe(1)
  })
  it('rejects stale offers and forbids generalization in preview, skip or bulk', async () => {
    const r = rig()
    const generalization = { selectorHash: 'a'.repeat(16), matchedCount: 7, countState: 'unknown' }
    expect(await r.broker.run(r.req({ items: [{ ...tupleOf(1), generalization }] }))).toMatchObject({ ok: false, code: 'STALE_TUPLE' })
    expect(r.agent.calls).toHaveLength(0)

    for (const action of ['skip', 'preview']) {expect(() => r.req({ action, items: [{ ...tupleOf(1), generalization }] })).toThrow()}
    expect(() => r.req({ items: [{ ...tupleOf(1), generalization }, tupleOf(2)] })).toThrow()
  })
})

describe('atomic bulk contract', () => {
  it('reconciles a lost plural response using the exact stored scope without another dialog or write', async () => {
    const r = rig()
    r.server.addDefinition(2)
    r.agent.state.bulkTimeoutAfterWrite = true
    const request = r.req({ items: [tupleOf(2), tupleOf(1)] })
    const first = await r.broker.run(request)
    expect(first).toMatchObject({ ok: false, code: 'UNRESOLVED' })
    expect(r.agent.state.nativeWrites).toBe(1)
    const second = await r.broker.run(request)
    expect(second).toMatchObject({ ok: true })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
    expect(r.agent.calls.filter(call => call.method === 'degram.mapping.advanced.answers')).toHaveLength(2)
    const calls = r.agent.calls.filter(call => call.method === 'degram.mapping.advanced.answers')
    expect(calls[1].params).toEqual(calls[0].params)
  })

  it('does not redispatch a pending dialog after main loses its records', async () => {
    const r = rig()
    r.agent.state.dialog = 'timeout'
    const request = r.req()
    await r.broker.run(request)
    const intent = [...r.server.intents.values()][0]
    intent.status = 'pending'
    intent.dialogDispatched = true

    // Fresh broker simulates process-memory loss. Server mark is authoritative.
    const restarted = createMappingIntentBroker({
      environment: ENV, origin: r.dg.origin, fetch: r.server.fetch,
      callAgent: vi.fn(() => { throw new Error('must not redispatch') }),
      auth: () => r.ctx.auth, scope: () => r.ctx.scope, isCurrent: () => true, logger: r.logger
    })

    const before = r.agent.calls.length
    const result = await restarted.run(request)
    expect(result).toMatchObject({ ok: false, code: 'UNRESOLVED', serverCode: 'INTENT_ALREADY_DISPATCHED' })
    expect(r.agent.calls).toHaveLength(before)
  })

  it('refuses multi-item skip rather than performing partial writes', () => {
    const r = rig()
    expect(() => r.req({ action: 'skip', items: [tupleOf(1), tupleOf(2)] })).toThrow()
  })

  it('sends one bulk challenge and one plural RPC for the frozen list', async () => {
    const r = rig()
    r.server.addDefinition(2)
    await r.broker.run(r.req({ items: [tupleOf(2), tupleOf(1)] }))
    const challenges = r.server.requests.filter(x => x.path.endsWith('/human-intents') && x.method === 'POST')
    expect(challenges).toHaveLength(1)
    expect(challenges[0].body).toMatchObject({ action: 'advanced-bulk-approve', scope: { items: expect.arrayContaining([expect.objectContaining({ definitionId: definitionId(1) }), expect.objectContaining({ definitionId: definitionId(2) })]) } })
    expect(r.agent.methods().filter(m => m === 'degram.mapping.advanced.answers')).toHaveLength(1)
    expect(r.agent.methods()).not.toContain('degram.mapping.advanced.answer')
  })
})

describe('request validation (the IPC payload is untrusted)', () => {
  const valid = {
    environment: ENV,
    project: 'alpha',
    scopeEpoch: 5,
    sessionId: SESSION_ID,
    requestId: 'req-0001',
    action: 'approve',
    items: [tupleOf(1)]
  }

  it('accepts exactly the closed shape of each action', () => {
    expect(parseMappingIntentRequest(valid)).toMatchObject({ action: 'approve', items: [tupleOf(1)] })
    expect(parseMappingIntentRequest({ ...valid, action: 'skip' })).toMatchObject({ action: 'skip' })
    expect(parseMappingIntentRequest({ ...valid, action: 'preview' })).toMatchObject({ action: 'preview' })
    expect(
      parseMappingIntentRequest({ ...valid, action: 'clear-preview', items: undefined, definitionIds: [definitionId(1)] })
    ).toMatchObject({ action: 'clear-preview', definitionIds: [definitionId(1)] })
    expect(
      parseMappingIntentRequest({
        ...valid,
        action: 'commit',
        items: undefined,
        commit: { batchManifestHash: resultHash(7), revision: revisionOf(9), answerIds: ['a-1'], designStateName: 'DS', designStateNameSource: 'edited' }
      })
    ).toMatchObject({ action: 'commit' })
  })

  it.each([
    ['a confirmation flag', { confirmed: true }],
    ['byAgent', { byAgent: false }],
    ['a source', { source: 'desktop' }],
    ['an intent id', { intentId: 'hi-000000000000000000000001' }],
    ['a scope', { scope: { definitionId: definitionId(1) } }],
    ['a url', { url: 'http://evil.test/' }],
    ['a method', { method: 'DELETE' }],
    ['a body', { body: '{}' }],
    ['a token', { token: LEAKED_TOKEN }],
    ['a cookie', { cookie: LEAKED_COOKIE }],
    ['an actor', { actor: 'bob' }],
    ['a csrf value', { csrf: '1' }]
  ])('refuses a forged payload carrying %s', (_name, extra) => {
    expect(() => parseMappingIntentRequest({ ...valid, ...extra })).toThrow(/invalid mapping intent/)
  })

  it('refuses malformed fields and shapes', () => {
    const bad = (over: Record<string, unknown>): void => {
      expect(() => parseMappingIntentRequest({ ...valid, ...over })).toThrow(/invalid mapping intent/)
    }

    bad({ action: 'delete' })
    bad({ action: 'confirmIntent' })
    bad({ action: 7 })
    bad({ requestId: 'x' })
    bad({ requestId: 'x'.repeat(49) })
    bad({ requestId: 'has space' })
    bad({ sessionId: '../../etc' })
    bad({ project: '' })
    bad({ project: 'a\nb' })
    bad({ scopeEpoch: -1 })
    bad({ scopeEpoch: 1.5 })
    bad({ environment: { environmentId: 'env-a' } })
    bad({ environment: { environmentId: 'env-a', generation: 3, mode: 'demo' } })
    bad({ items: [] })
    bad({ items: [{ ...tupleOf(1), extra: 1 }] })
    bad({ items: [{ ...tupleOf(1), definitionId: 'MD-xyz' }] })
    bad({ items: [{ ...tupleOf(1), resultHash: 'nothex' }] })
    bad({ items: [{ ...tupleOf(1), definitionVersion: 0 }] })
    bad({ items: [tupleOf(1), tupleOf(1)] })
    bad({ items: Array.from({ length: 101 }, (_v, i) => tupleOf(i + 1)) })
    bad({ action: 'preview', items: [tupleOf(1), tupleOf(2)] })
    bad({ action: 'commit', items: undefined, commit: { batchManifestHash: 'zz', revision: revisionOf(1), answerIds: ['a'] } })
    bad({ action: 'commit', items: undefined, commit: { batchManifestHash: resultHash(1), revision: 'r', answerIds: ['a'] } })
    bad({ action: 'commit', items: undefined, commit: { batchManifestHash: resultHash(1), revision: revisionOf(1), answerIds: [] } })
    bad({ action: 'commit', items: undefined, commit: { batchManifestHash: resultHash(1), revision: revisionOf(1), answerIds: ['a'], designStateNameSource: 'bot' } })
    bad({ action: 'clear-preview', items: undefined, definitionIds: [] })
    expect(() => parseMappingIntentRequest(null)).toThrow(/invalid mapping intent/)
    expect(() => parseMappingIntentRequest('approve')).toThrow(/invalid mapping intent/)
    expect(() => parseMappingIntentStatusRequest({ ...valid, action: 'approve', items: [] })).toThrow(/invalid mapping intent/)
  })
})

describe('approve: member challenge, native dialog, server receipt, protected operation', () => {
  it('runs the lanes in order, freezes the exact canonical scope and spends the proof once', async () => {
    const r = rig()
    const result = ok(await r.broker.run(r.req()))

    // member lane: canonical session first, then the challenge with cookie lane + CSRF + the revision it was read at
    const first = r.server.requests[0]
    const challenge = r.server.challenges()[0]

    expect(first).toMatchObject({ method: 'GET', path: `/data-service/mapping/sessions/${SESSION_ID}?project=alpha` })
    expect(challenge.headers['X-DG-CSRF']).toBe('1')
    expect(challenge.body).toEqual({
      project: 'alpha',
      requestId: 'req-0001',
      action: 'advanced-approve',
      expectedRevision: revisionOf(1),
      scope: tupleOf(1)
    })

    // delegated lane: the native dialog (scope echo only, generation stamped) and only then the answer with the intent ref
    expect(r.agent.methods()).toEqual(['degram.mapping.advanced.confirmIntent', 'degram.mapping.advanced.answer'])

    const confirm = r.agent.calls[0].params
    const answer = r.agent.calls[1].params

    expect(confirm).toEqual({
      sessionId: SESSION_ID,
      intentId: 'hi-000000000000000000000001',
      scope: tupleOf(1),
      _degram_environment: ENV
    })
    expect(answer).toMatchObject({ sessionId: SESSION_ID, requestId: 'req-0001', intentId: 'hi-000000000000000000000001', action: 'approve', scope: tupleOf(1), _degram_environment: ENV })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)

    // the order across lanes: challenge before dialog, receipt read between dialog and answer
    const intentRead = r.server.requests.findIndex(x => x.method === 'GET' && x.path.includes('/human-intents/'))

    expect(intentRead).toBeGreaterThan(r.server.requests.indexOf(challenge))
    expect(result.intents).toEqual([
      { intentId: 'hi-000000000000000000000001', action: 'advanced-approve', status: 'confirmed', definitionId: definitionId(1) }
    ])
    expect(result.session).toMatchObject({ sessionId: SESSION_ID })
    noSecrets(result)
  })

  it('also runs skip, preview, clear-preview and commit with the right action, scope and operation', async () => {
    const r = rig()

    const skip = ok(await r.broker.run(r.req({ requestId: 'req-skip-1', action: 'skip' })))

    expect(skip.intents[0].action).toBe('advanced-skip')
    expect(r.agent.calls.at(-1)).toMatchObject({ method: 'degram.mapping.advanced.answer', params: { action: 'skip' } })

    r.server.addDefinition(2)

    const preview = ok(await r.broker.run(r.req({ requestId: 'req-prev-1', action: 'preview', items: [tupleOf(2)] })))

    expect(preview.intents[0].action).toBe('preview-definition')
    expect(preview.operation).toMatchObject({ outcome: 'completed', operationId: 'op-2' })
    expect(r.agent.calls.at(-1)).toMatchObject({ method: 'degram.mapping.advanced.preview', params: { intentId: preview.intents[0].intentId } })

    const clear = ok(await r.broker.run(r.req({ requestId: 'req-clear-1', action: 'clear-preview', items: undefined, definitionIds: [definitionId(2)] })))

    expect(clear.intents[0].action).toBe('clear-definition-preview')
    expect(r.server.challenges().at(-1)?.body).toMatchObject({ scope: { definitionId: definitionId(2) } })
    expect(r.agent.calls.at(-1)?.method).toBe('degram.mapping.advanced.clearPreview')

    r.server.session.advanced.commit = { batchManifestHash: resultHash(77) }

    const commit = ok(
      await r.broker.run(
        r.req({
          requestId: 'req-comm-1',
          action: 'commit',
          items: undefined,
          commit: {
            batchManifestHash: resultHash(77),
            revision: r.server.session.revision,
            answerIds: ['a-1'],
            designStateName: 'DS 1',
            designStateNameSource: 'suggested'
          }
        })
      )
    )

    expect(commit.intents[0].action).toBe('advanced-commit')
    expect(r.server.challenges().at(-1)?.body).toMatchObject({ scope: { batchManifestHash: resultHash(77) } })
    expect(r.agent.calls.at(-1)).toMatchObject({
      method: 'degram.mapping.apply',
      params: { sessionId: SESSION_ID, requestId: 'req-comm-1', answerIds: ['a-1'], designStateName: 'DS 1', designStateNameSource: 'suggested', intentId: commit.intents[0].intentId }
    })
    expect(commit.batch).toMatchObject({ delivery: { state: 'queued' } })
    noSecrets([skip, preview, clear, commit])
  })

  it('scrubs credential-looking keys out of whatever the gateway returned', async () => {
    const r = rig()

    r.agent.state.answerOverride = {
      status: 'ok',
      session: { sessionId: SESSION_ID, nested: [{ ok: 1, token: LEAKED_TOKEN, Authorization: 'Bearer x', cookie: LEAKED_COOKIE }], proofSecret: PROOF_SECRET }
    }

    const result = ok(await r.broker.run(r.req()))

    expect(result.session).toEqual({ sessionId: SESSION_ID, nested: [{ ok: 1 }] })
    noSecrets(result)
  })
})

describe('the fence: environment, project, scope, membership', () => {
  it('refuses another environment generation (a delayed A to B reply) before any request', async () => {
    const r = rig()

    for (const environment of [{ ...ENV, generation: 2 }, { ...ENV, generation: 4 }, { ...ENV, environmentId: 'env-b' }, null]) {
      const result = await r.broker.run(r.req({ environment, requestId: `req-fence-${Math.random().toString(36).slice(2, 8)}` }))

      expect(result).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    }

    r.nothingHappened()
  })

  it('refuses a project or scope epoch that moved', async () => {
    const r = rig()

    expect(await r.broker.run(r.req({ project: 'beta', requestId: 'req-proj-1' }))).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    expect(await r.broker.run(r.req({ scopeEpoch: 4, requestId: 'req-epoch-1' }))).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    r.nothingHappened()
  })

  it('refuses an obsolete runtime, a signed-out session, no scope, no membership and a viewer', async () => {
    const r = rig()

    r.ctx.current = false
    expect(await r.broker.run(r.req({ requestId: 'req-old-001' }))).toMatchObject({ code: 'STALE_ENVIRONMENT' })
    r.ctx.current = true

    r.ctx.auth = { ...r.ctx.auth, kind: 'signed-out' }
    expect(await r.broker.run(r.req({ requestId: 'req-out-001' }))).toMatchObject({ code: 'NOT_SIGNED_IN' })
    r.ctx.auth = { ...r.ctx.auth, kind: 'unreachable' }
    expect(await r.broker.run(r.req({ requestId: 'req-unr-001' }))).toMatchObject({ code: 'NOT_SIGNED_IN' })
    r.ctx.auth = { ...r.ctx.auth, kind: 'signed-in', memberships: [] }
    expect(await r.broker.run(r.req({ requestId: 'req-mem-001' }))).toMatchObject({ code: 'NOT_A_MEMBER' })
    r.ctx.auth = { ...r.ctx.auth, memberships: [{ project: 'alpha', role: 'viewer', company: null }] }
    expect(await r.broker.run(r.req({ requestId: 'req-view-001' }))).toMatchObject({ code: 'NOT_EDITOR' })
    r.ctx.auth = { ...r.ctx.auth, memberships: [{ project: 'other', role: 'owner', company: null }] }
    expect(await r.broker.run(r.req({ requestId: 'req-oth-001' }))).toMatchObject({ code: 'NOT_A_MEMBER' })
    r.ctx.auth = { ...r.ctx.auth, memberships: [{ project: 'alpha', role: 'owner', company: null }] }
    r.ctx.scope = { ...r.ctx.scope, status: 'opening' }
    expect(await r.broker.run(r.req({ requestId: 'req-scope-01' }))).toMatchObject({ code: 'NOT_READY' })
    r.nothingHappened()
  })

  it('a member lane without cookie or CSRF is refused by the server and nothing is asked of the person', async () => {
    const r = rig()

    r.server.flags.signedIn = false
    expect(await r.broker.run(r.req({ requestId: 'req-nocookie' }))).toMatchObject({ ok: false, code: 'SESSION_UNAVAILABLE' })
    r.noNativeWrite()
    expect(r.agent.state.dialogs).toBe(0)

    r.server.flags.signedIn = true
    r.server.flags.refuseChallenge = { status: 403, code: 'CSRF_REQUIRED' }

    const refused = await r.broker.run(r.req({ requestId: 'req-nocsrf-1' }))

    expect(refused).toMatchObject({ ok: false, code: 'CHALLENGE_REFUSED', serverCode: 'CSRF_REQUIRED' })
    expect(r.agent.state.dialogs).toBe(0)
    r.noNativeWrite()
    noSecrets(refused)
    // every write main ever sent carried the CSRF header
    expect(r.server.challenges().every(c => c.headers['X-DG-CSRF'] === '1')).toBe(true)
  })

  it('a server that no longer sees the issuer as an editor refuses the challenge', async () => {
    const r = rig()

    r.server.flags.editor = false
    expect(await r.broker.run(r.req())).toMatchObject({ ok: false, code: 'CHALLENGE_REFUSED', serverCode: 'INTENT_REVOKED' })
    expect(r.agent.state.dialogs).toBe(0)
    r.noNativeWrite()
  })

  it('a server challenge that froze another scope than the one asked is not shown to the person', async () => {
    const r = rig()

    r.server.flags.forceScope = { ...tupleOf(1), resultHash: resultHash(99) }
    expect(await r.broker.run(r.req())).toMatchObject({ ok: false, code: 'CHALLENGE_MISMATCH' })
    expect(r.agent.state.dialogs).toBe(0)
    r.noNativeWrite()
  })
})

describe('frozen tuples: stale means nothing is asked', () => {
  it.each([
    ['a replaced result', { resultHash: resultHash(99) }],
    ['a moved definition version', { definitionVersion: 3 }],
    ['a moved binding revision', { bindingRevision: 5 }],
    ['an unknown definition', { definitionId: definitionId(9) }]
  ])('refuses %s without a challenge or a dialog', async (_name, change) => {
    const r = rig()
    const result = await r.broker.run(r.req({ items: [{ ...tupleOf(1), ...change }] }))

    expect(result).toMatchObject({ ok: false, code: 'STALE_TUPLE', stale: [(change as { definitionId?: string }).definitionId ?? definitionId(1)] })
    expect(r.server.challenges()).toEqual([])
    expect(r.agent.calls).toEqual([])
  })

  it('refuses a binding whose result is not ok and a session without an advanced section', async () => {
    const r = rig()

    r.server.session.advanced.bindings[0].resultStatus = 'failed'
    expect(await r.broker.run(r.req({ requestId: 'req-bad-001' }))).toMatchObject({ code: 'STALE_TUPLE' })
    ;(r.server.session as { advanced?: unknown }).advanced = undefined
    expect(await r.broker.run(r.req({ requestId: 'req-bad-002' }))).toMatchObject({ code: 'STALE_TUPLE' })
    expect(r.server.challenges()).toEqual([])
    expect(r.agent.calls).toEqual([])
  })

  it('refuses a commit for another manifest or revision', async () => {
    const r = rig()

    r.server.session.advanced.commit = { batchManifestHash: resultHash(77) }

    const commit = (batchManifestHash: string, revision: string) =>
      r.req({ action: 'commit', items: undefined, requestId: `req-c-${batchManifestHash.slice(-3)}${revision.slice(-2)}`, commit: { batchManifestHash, revision, answerIds: ['a-1'] } })

    expect(await r.broker.run(commit(resultHash(78), r.server.session.revision))).toMatchObject({ code: 'STALE_TUPLE', stale: ['commit'] })
    expect(await r.broker.run(commit(resultHash(77), revisionOf(99)))).toMatchObject({ code: 'STALE_TUPLE' })
    expect(r.agent.calls).toEqual([])
  })

  it('does not ask again for an answer already recorded at exactly this tuple', async () => {
    const r = rig()

    ok(await r.broker.run(r.req()))
    r.agent.calls.length = 0

    const again = await r.broker.run(r.req({ requestId: 'req-again-1' }))

    expect(again).toMatchObject({ ok: false, code: 'ALREADY_ANSWERED', stale: [definitionId(1)] })
    expect(r.agent.calls).toEqual([])
  })
})

describe('bulk approve: one frozen list, atomic precheck, no silent subset', () => {
  function bulkRig() {
    const r = rig()

    r.server.addDefinition(2)
    r.server.addDefinition(3)

    return { ...r, items: [tupleOf(1), tupleOf(2), tupleOf(3)] }
  }

  it('uses one dialog and one plural operation for the entire list', async () => {
    const r = bulkRig()
    const result = ok(await r.broker.run(r.req({ requestId: 'req-bulk-001', items: r.items })))
    expect(result.intents).toHaveLength(1)
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
    expect(r.server.challenges()).toHaveLength(1)
    expect(r.agent.methods()).toContain('degram.mapping.advanced.answers')
  })

  it('one stale tuple refuses the whole list before the first challenge', async () => {
    const r = bulkRig()
    const items = [tupleOf(1), { ...tupleOf(2), resultHash: resultHash(99) }, tupleOf(3)]
    const result = await r.broker.run(r.req({ requestId: 'req-bulk-002', items }))

    expect(result).toMatchObject({ ok: false, code: 'STALE_TUPLE', stale: [definitionId(2)], completed: [] })
    expect(r.server.challenges()).toEqual([])
    expect(r.agent.calls).toEqual([])
  })

  it('refuses if a tuple goes stale during the dialog', async () => {
    const r = bulkRig()

    r.agent.state.onDialog = () => { r.server.session.advanced.bindings[1].resultHash = resultHash(98); r.server.bump() }
    const result = await r.broker.run(r.req({ requestId: 'req-bulk-003', items: r.items }))
    expect(result).toMatchObject({ ok: false, completed: [] })
    expect(r.agent.state.nativeWrites).toBe(0)
  })

  it('a cancelled bulk dialog does not write any item', async () => {
    const r = bulkRig()
    r.agent.state.dialog = 'cancel'
    const result = await r.broker.run(r.req({ requestId: 'req-bulk-004', items: r.items }))
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', completed: [] })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(0)
  })
})

describe('cancel, duplicates and the one-dialog rule', () => {
  it('a cancelled native dialog grants nothing and a retry of the same request replays the cancel', async () => {
    const r = rig()

    r.agent.state.dialog = 'cancel'

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', completed: [] })
    r.noNativeWrite()
    expect(r.server.status('hi-000000000000000000000001')).toBe('cancelled')

    const before = r.server.requests.length
    const retry = await r.broker.run(r.req())

    expect(retry).toMatchObject({ ok: false, code: 'CANCELLED', replayed: true })
    expect(r.server.requests.length).toBe(before)
    expect(r.agent.state.dialogs).toBe(1)
    noSecrets([result, retry])
  })

  it('a duplicate of a request in flight shares its one dialog; another request is busy', async () => {
    const r = rig({ timeoutMs: 5000 })
    let release: () => void = () => undefined

    r.agent.state.gate = new Promise<void>(resolve => {
      release = resolve
    })

    const first = r.broker.run(r.req())
    const duplicate = r.broker.run(r.req())
    const other = await r.broker.run(r.req({ requestId: 'req-other-01' }))

    expect(other).toMatchObject({ ok: false, code: 'BUSY' })
    await vi.waitFor(() => expect(r.agent.state.dialogs).toBe(1))
    release()

    const [a, b] = await Promise.all([first, duplicate])

    expect(a).toBe(b)
    expect(ok(a).intents).toHaveLength(1)
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
  })

  it('an identical request after success is replayed from memory: no request, no dialog, no second write', async () => {
    const r = rig()

    ok(await r.broker.run(r.req()))

    const requests = r.server.requests.length
    const calls = r.agent.calls.length
    const replay = ok(await r.broker.run(r.req()))

    expect(replay.replayed).toBe(true)
    expect(r.server.requests.length).toBe(requests)
    expect(r.agent.calls.length).toBe(calls)
  })

  it('the same request id for a different action is a conflict and does nothing', async () => {
    const r = rig()

    ok(await r.broker.run(r.req()))

    const calls = r.agent.calls.length
    const result = await r.broker.run(r.req({ action: 'skip' }))

    expect(result).toMatchObject({ ok: false, code: 'REQUEST_CONFLICT' })
    expect(r.agent.calls.length).toBe(calls)
  })

  it('does not replay a cached result to another signed-in member', async () => {
    const r = rig()
    ok(await r.broker.run(r.req()))
    r.ctx.auth = { ...r.ctx.auth, username: 'bob' } as AuthState
    const result = await r.broker.run(r.req())
    expect(result).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
  })

  it('does not reopen a cancelled dialog after its local record is evicted', async () => {
    const r = rig({ maxRecords: 1 })
    r.agent.state.dialog = 'cancel'
    await r.broker.run(r.req({ requestId: 'cancel-old' }))
    await r.broker.run(r.req({ requestId: 'cancel-new' }))
    const dialogs = r.agent.state.dialogs
    expect(await r.broker.run(r.req({ requestId: 'cancel-old' }))).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(r.agent.state.dialogs).toBe(dialogs)
    expect(r.agent.state.nativeWrites).toBe(0)
  })

  it('remembers a bounded number of finished requests', async () => {
    const r = rig({ maxRecords: 2 })

    r.agent.state.dialog = 'cancel'

    for (const id of ['req-evict-1', 'req-evict-2', 'req-evict-3']) {
      await r.broker.run(r.req({ requestId: id }))
    }

    // the oldest was forgotten: its status is unknown
    expect(await r.broker.status(r.statusReq({ requestId: 'req-evict-1' }))).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' })
    expect(await r.broker.status(r.statusReq({ requestId: 'req-evict-3' }))).toMatchObject({ ok: true })
  })
})

describe('the server receipt is the proof, not the dialog answer', () => {
  it('an agent that says "confirmed" while the server holds no receipt creates no proof and no write', async () => {
    const r = rig()

    r.agent.state.dialog = 'lie-confirmed'

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })
    r.noNativeWrite()
    expect(r.server.status('hi-000000000000000000000001')).toBe('pending')
  })

  it('a session that moved during the dialog makes the receipt stale: no write', async () => {
    const r = rig()

    r.agent.state.onDialog = () => r.server.bump()

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'PROOF_NOT_CONFIRMED' })
    r.noNativeWrite()
  })

  it('an unresolved native outcome reads the status and never shows the dialog again', async () => {
    const r = rig()

    r.agent.state.dialog = 'unresolved'

    const first = await r.broker.run(r.req())

    expect(first).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })
    r.noNativeWrite()

    // still pending: the same request is resumed, the dialog is NOT dispatched a second time
    const second = await r.broker.run(r.req())

    expect(second).toMatchObject({ ok: false, code: 'UNRESOLVED' })
    expect(r.agent.state.dialogs).toBe(1)

    // the person finally pressed Yes: the same request now completes on the recorded receipt
    r.server.confirm('hi-000000000000000000000001')

    const third = ok(await r.broker.run(r.req()))

    expect(third.intents[0].status).toBe('confirmed')
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
  })

  it('a timeout after the person pressed Yes is settled by the server receipt: one dialog, one write', async () => {
    const r = rig()

    r.agent.state.dialog = 'confirm-then-timeout'

    const result = ok(await r.broker.run(r.req()))

    expect(result.intents[0].status).toBe('confirmed')
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
    expect(r.agent.methods()).toEqual(['degram.mapping.advanced.confirmIntent', 'degram.mapping.advanced.answer'])
  })

  it('a timeout with no receipt is unresolved and writes nothing', async () => {
    const r = rig()

    r.agent.state.dialog = 'timeout'

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })
    r.noNativeWrite()
  })

  it('already dispatched at the connector reads the status instead of failing', async () => {
    const r = rig()

    r.agent.state.dialog = 'confirm'
    ok(await r.broker.run(r.req({ requestId: 'req-disp-001' })))

    // another request, same challenge key space is separate: simulate the connector refusing a second dispatch
    r.agent.state.failMethod = { method: 'degram.mapping.advanced.confirmIntent', code: 'INTENT_ALREADY_DISPATCHED' }
    r.server.addDefinition(2)

    const result = await r.broker.run(r.req({ requestId: 'req-disp-002', items: [tupleOf(2)] }))

    expect(result).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })
    expect(r.agent.state.nativeWrites).toBe(1)
  })

  it('a refused native dialog (no adapter) is a refusal, not a proof', async () => {
    const r = rig()

    r.agent.state.failMethod = { method: 'degram.mapping.advanced.confirmIntent', code: 'REVIT_ADAPTER_NOT_CONNECTED' }

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'NATIVE_REFUSED', serverCode: 'REVIT_ADAPTER_NOT_CONNECTED' })
    r.noNativeWrite()
  })

  it('no scope on the backend (a coded-less error) is NOT_READY and nothing is written', async () => {
    const r = rig()

    const broker = createMappingIntentBroker({
      environment: ENV,
      origin: r.dg.origin,
      fetch: r.server.fetch,
      callAgent: async () => {
        throw new Error('degram: no project scope is ready')
      },
      auth: () => r.ctx.auth,
      scope: () => r.ctx.scope,
      isCurrent: () => true,
      logger: r.logger
    })

    expect(await broker.run(r.req())).toMatchObject({ ok: false, code: 'NOT_READY' })
    expect(r.agent.state.nativeWrites).toBe(0)
  })
})

describe('one-shot: a proof that reached the protected operation is never offered again', () => {
  it.each([
    ['degram.mapping.advanced.answer', 'approve', {}],
    ['degram.mapping.advanced.preview', 'preview', {}],
    ['degram.mapping.apply', 'commit', {}]
  ])('a timeout of %s is unresolved; a retry reads the status and never calls it again', async (method, action) => {
    const r = rig()

    const extra: Record<string, unknown> =
      action === 'commit'
        ? ((r.server.session.advanced.commit = { batchManifestHash: resultHash(77) }),
          {
            items: undefined,
            commit: { batchManifestHash: resultHash(77), revision: r.server.session.revision, answerIds: ['a-1'] }
          })
        : {}

    r.agent.state.hang.add(method)

    const first = await r.broker.run(r.req({ action, requestId: 'req-once-001', ...extra }))

    expect(first).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })
    expect(first.ok ? [] : first.intents).toHaveLength(1)

    const calls = r.agent.calls.filter(c => c.method === method).length
    const retry = await r.broker.run(r.req({ action, requestId: 'req-once-001', ...extra }))

    expect(retry).toMatchObject({ ok: false, code: 'UNRESOLVED' })
    expect(r.agent.calls.filter(c => c.method === method).length).toBe(calls)
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(0)

    // the status read is the recovery path
    const status = await r.broker.status(r.statusReq({ requestId: 'req-once-001' }))

    expect(status).toMatchObject({ ok: true, intents: [{ status: 'confirmed' }] })
  })

  it('a protected operation the server refuses (stale proof) is a failure with the server code', async () => {
    const r = rig()

    r.agent.state.failMethod = { method: 'degram.mapping.advanced.answer', code: 'ADVANCED_ANSWER_STALE' }

    expect(await r.broker.run(r.req())).toMatchObject({ ok: false, code: 'FAILED', serverCode: 'ADVANCED_ANSWER_STALE' })
    expect(r.agent.state.nativeWrites).toBe(0)
  })
})

describe('a generation or scope switch during the confirmation', () => {
  it('refuses an account change while the native dialog is open', async () => {
    const r = rig()

    r.agent.state.onDialog = () => {
      r.ctx.auth = { ...r.ctx.auth, username: 'bob' } as AuthState
    }

    expect(await r.broker.run(r.req())).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    r.noNativeWrite()
  })

  it('drops the request after the dialog: no protected operation is called', async () => {
    const r = rig()

    r.agent.state.onDialog = () => {
      r.ctx.current = false
    }

    const result = await r.broker.run(r.req())

    expect(result).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    r.noNativeWrite()
    expect(r.agent.state.dialogs).toBe(1)
  })

  it('drops the request when the scope epoch or project moves during the dialog', async () => {
    const r = rig()

    r.agent.state.onDialog = () => {
      r.ctx.scope = { ...r.ctx.scope, epoch: 6 }
    }

    expect(await r.broker.run(r.req())).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    r.noNativeWrite()

    const second = rig()

    second.agent.state.onDialog = () => {
      second.ctx.scope = { ...second.ctx.scope, project: 'beta' }
    }

    expect(await second.broker.run(second.req())).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    second.noNativeWrite()
  })

  it('a delayed reply of environment A is never believed by environment B', async () => {
    const a = rig({ timeoutMs: 5000 })
    let release: () => void = () => undefined

    a.agent.state.gate = new Promise<void>(resolve => {
      release = resolve
    })

    const pending = a.broker.run(a.req())

    await vi.waitFor(() => expect(a.agent.state.dialogs).toBe(1))
    // the environment switched to B: A's runtime is obsolete
    a.ctx.current = false
    release()

    expect(await pending).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    a.noNativeWrite()

    // B has its own broker over its own lanes: a request stamped with A's generation is refused there
    const b = rig()

    expect(await b.broker.run(b.req({ environment: { ...ENV, generation: 2 } }))).toMatchObject({ code: 'STALE_ENVIRONMENT' })
    b.nothingHappened()
  })
})

describe('status', () => {
  it('reads the challenges of a known request over the member lane and refuses unknown ones', async () => {
    const r = rig()

    ok(await r.broker.run(r.req()))

    const status = await r.broker.status(r.statusReq())

    expect(status).toEqual({
      ok: true,
      requestId: 'req-0001',
      intents: [{ intentId: 'hi-000000000000000000000001', action: 'advanced-approve', status: 'consumed', definitionId: definitionId(1) }]
    })
    expect(await r.broker.status(r.statusReq({ requestId: 'req-never-01' }))).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' })
    expect(await r.broker.status(r.statusReq({ sessionId: 'ms-other' }))).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' })
    expect(await r.broker.status(r.statusReq({ environment: { ...ENV, generation: 9 } }))).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    noSecrets(status)
  })
})
