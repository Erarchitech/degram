// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createDegramRuntime, DEGRAM_CHANNELS, type DegramRuntime, registerDegramIpc } from './ipc'
import type { BackendHandle, ScopeKey } from './scope'
import {
  createFakeClock,
  createFakeDg,
  createFakePairing,
  createFakeViewFactory,
  createLog,
  PAIRING_TOKEN,
  TOKEN_A
} from './test-support'

type Sent = { channel: string; payload: unknown }

function rig(
  options: {
    signedIn?: boolean
    memberships?: { project: string; company?: string | null }[]
    pairing?: ReturnType<typeof createFakePairing> | null
  } = {}
) {
  const log = createLog()
  const dg = createFakeDg()
  const clock = createFakeClock()
  const viewFactory = createFakeViewFactory(log)
  const sent: Sent[] = []
  const rpcCalls: { method: string; params: unknown }[] = []
  const openExternal = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const memberships = options.memberships ?? [{ project: 'alpha', company: 'ACME' }]
  const trayChanged = vi.fn()

  if (options.signedIn !== false) {
    dg.setMe({
      status: 200,
      body: {
        username: 'alice',
        isAdmin: false,
        memberships: memberships.map(m => ({ project: m.project, role: 'viewer', company: m.company ?? null }))
      }
    })
  }

  dg.setLogout(() => {
    log.push('dg.logout')

    return { status: 204 }
  })

  const handle: BackendHandle = {
    call: async (method, params) => {
      log.push(`rpc:${method}`)
      rpcCalls.push({ method, params })

      return { ok: true }
    }
  }

  const runtime = createDegramRuntime({
    origin: dg.origin,
    fetch: dg.fetch,
    clock,
    logger,
    createView: viewFactory.factory,
    openExternal,
    profiles: {
      ensure: async (scope: ScopeKey) => ({ profile: `scope-${scope.project}` }),
      purge: async scope => {
        log.push(`profiles.purge:${scope.project}`)
      },
      purgeProject: async (_user: string, project: string) => {
        log.push(`profiles.purgeProject:${project}`)

        return []
      },
      cleanupLegacy: async () => ({ ran: false, failed: [] })
    },
    backend: { ensure: async () => handle, release: async () => undefined },
    pairing: options.pairing === null ? undefined : (options.pairing ?? createFakePairing()),
    onTrayLabelsChanged: trayChanged,
    send: (channel, payload) => {
      log.push(`send:${channel}${channel === DEGRAM_CHANNELS.event ? `:${(payload as { type: string }).type}` : ''}`)
      sent.push({ channel, payload })
    }
  })

  return {
    log,
    dg,
    clock,
    viewFactory,
    fake: viewFactory.fake,
    sent,
    rpcCalls,
    openExternal,
    runtime,
    logger,
    trayChanged
  }
}

const states = (sent: Sent[]) => sent.filter(s => s.channel === DEGRAM_CHANNELS.stateChanged).map(s => s.payload as any)
const eventsOf = (sent: Sent[]) => sent.filter(s => s.channel === DEGRAM_CHANNELS.event).map(s => s.payload as any)

describe('degram runtime: sign-in page and initial state', () => {
  it('starts on the DG login page when signed out and exposes no project', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])
    expect(r.runtime.getState()).toMatchObject({
      auth: { kind: 'signed-out', username: null, memberships: [] },
      scope: { status: 'no-project', project: null },
      dg: { page: 'sign-in', mode: 'graph', reachable: true }
    })
  })

  it('starts on the graph slice when signed in and still selects no project implicitly', async () => {
    const r = rig()

    await r.runtime.start()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/#degram`])
    expect(r.runtime.getState().auth).toMatchObject({
      kind: 'signed-in',
      username: 'alice',
      memberships: [{ project: 'alpha', role: 'viewer', company: 'ACME' }]
    })
    expect(r.runtime.getState().scope.status).toBe('no-project')
    expect(r.rpcCalls).toEqual([])
  })

  it('probes a stored pairing once on start and publishes revoked status after a refused probe', async () => {
    const pairing = createFakePairing(PAIRING_TOKEN)
    const r = rig({ pairing })
    r.dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })

    await r.runtime.start()

    expect(r.dg.exchangeCount()).toBe(1)
    expect(pairing.get()).toBeNull()
    expect(r.runtime.getState().pairing.status).toBe('revoked')
    expect(eventsOf(r.sent)).toContainEqual({ type: 'pairing-revoked' })
    expect(r.runtime.getState().scope.status).toBe('no-project')
  })

  it('a sign-in completed inside the DG page is picked up from the cookie change and opens the DG page', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()

    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.runtime.onAuthCookieChanged()

    expect(r.runtime.getState().auth.kind).toBe('signed-in')
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/#degram`)
    expect(states(r.sent).pop().auth.kind).toBe('signed-in')
  })

  it('an unreachable DG server on start reports it at once, loads nothing and publishes reachable false (G-16)', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()

    expect(r.fake.loaded).toEqual([])
    expect(r.runtime.getState().dg.reachable).toBe(false)
    expect(r.runtime.getState().auth.kind).toBe('unknown')
    expect(eventsOf(r.sent)).toContainEqual({ type: 'dg-unreachable' })
    expect(states(r.sent).pop().dg.reachable).toBe(false)
  })
})

describe('degram runtime: retryDg after DG was unreachable (G-16)', () => {
  const meRequests = (r: ReturnType<typeof rig>): number => r.dg.requests.filter(q => q.url.endsWith('/auth/me')).length

  it('re-runs /auth/me and loads the sign-in page when DG answers signed out; a finished load restores reachable', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()
    expect(r.fake.loaded).toEqual([])

    r.dg.setMe({ status: 401, body: { detail: 'not signed in' } })
    await r.runtime.retryDg()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])

    r.fake.emit('did-start-loading')
    r.fake.emit('did-finish-load')

    expect(r.runtime.getState().dg.reachable).toBe(true)
    expect(eventsOf(r.sent)).toContainEqual({ type: 'dg-reachable' })
  })

  it('loads the DG page once when DG answers signed in', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()
    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.runtime.retryDg()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/#degram`])
    expect(r.runtime.getState().auth.kind).toBe('signed-in')
  })

  it('reloads the DG page of a session that stayed signed in while DG was unreachable', async () => {
    const r = rig()

    await r.runtime.start()
    expect(r.fake.loaded).toEqual([`${r.dg.origin}/#degram`])

    r.fake.emit('did-start-loading')
    r.fake.emit('did-fail-load', {}, -101, 'ERR_CONNECTION_RESET', `${r.dg.origin}/#degram`, true)
    r.fake.emit('did-finish-load')
    expect(r.runtime.getState().dg.reachable).toBe(false)

    await r.runtime.retryDg()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/#degram`, `${r.dg.origin}/#degram`])
  })

  it('stays unreachable and loads nothing while /auth/me still fails', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()
    await r.runtime.retryDg()

    expect(r.fake.loaded).toEqual([])
    expect(r.runtime.getState().dg.reachable).toBe(false)
    expect(eventsOf(r.sent).filter(e => e.type === 'dg-unreachable')).toHaveLength(1)
  })

  it('runs at most one re-check at a time', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()

    const before = meRequests(r)

    await Promise.all([r.runtime.retryDg(), r.runtime.retryDg(), r.runtime.retryDg()])

    expect(meRequests(r) - before).toBe(1)
  })

  it('window focus re-checks only while DG is unreachable', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()

    const before = meRequests(r)

    await r.runtime.onWindowFocus()
    expect(meRequests(r)).toBeGreaterThan(before)

    const healthy = rig()

    await healthy.runtime.start()

    const healthyBefore = meRequests(healthy)

    await healthy.runtime.onWindowFocus()
    // the ordinary focus check (checkAccess) is the only request; no extra retry
    expect(meRequests(healthy) - healthyBefore).toBeLessThanOrEqual(1)
  })
})

describe('degram runtime: project selection', () => {
  it('selecting a project opens the scope and never leaks the token to the renderer', async () => {
    const r = rig()

    await r.runtime.start()

    const result = await r.runtime.selectProject('alpha')

    expect(result.ok).toBe(true)
    expect(r.runtime.getState().scope).toMatchObject({ status: 'ready', project: 'alpha', company: 'ACME' })
    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set'])

    expect(JSON.stringify(r.sent)).not.toContain(TOKEN_A)
    expect(JSON.stringify(r.runtime.getState())).not.toContain(TOKEN_A)
    expect(JSON.stringify(result)).not.toContain(TOKEN_A)
    expect(JSON.stringify(r.logger.info.mock.calls)).not.toContain(TOKEN_A)
    expect(JSON.stringify(r.logger.warn.mock.calls)).not.toContain(TOKEN_A)
  })

  it('refuses a project the user is not a member of', async () => {
    const r = rig()

    await r.runtime.start()

    const result = await r.runtime.selectProject('beta')

    expect(result).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(r.rpcCalls).toEqual([])
  })
})

describe('degram runtime: sign-out ordering (D-05, T-1301-12-04)', () => {
  it('logs out, clears the credential, closes the scope, wipes the partition, resets the view, and only then tells the renderer', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.sent.length = 0
    r.log.entries.length = 0

    await r.runtime.signOut()

    const order = [
      'dg.logout',
      'rpc:degram.credentials.clear',
      'view.load about:blank',
      'view.clearStorageData',
      'view.clearCache',
      `view.load ${r.dg.origin}/?host=degram`
    ].map(entry => r.log.indexOf(entry))

    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    const firstSend = r.log.entries.findIndex(entry => entry.startsWith('send:'))

    expect(firstSend).toBeGreaterThan(order[order.length - 1])

    expect(states(r.sent).pop()).toMatchObject({
      auth: { kind: 'signed-out', memberships: [] },
      scope: { status: 'no-project', project: null },
      dg: { page: 'sign-in' }
    })
    expect(JSON.stringify(r.sent)).not.toContain('alpha')
  })

  it('never publishes a state that still shows the old user or project while the clearing runs', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')

    const seen: string[] = []

    // Every send observes what the DG partition and the agent have already been told.
    r.sent.length = 0

    const original = r.fake.session.clearStorageData.getMockImplementation()

    r.fake.session.clearStorageData.mockImplementation(async (...args: unknown[]) => {
      seen.push(`sentBeforeWipe=${r.sent.length}`)

      return original?.(...args)
    })

    await r.runtime.signOut()

    expect(seen).toEqual(['sentBeforeWipe=0'])
  })

  it('signs out cleanly even when the DG server is unreachable', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.dg.setLogout('network-error')

    await r.runtime.signOut()

    expect(r.runtime.getState().auth.kind).toBe('signed-out')
    expect(r.rpcCalls.map(c => c.method)).toContain('degram.credentials.clear')
    expect(r.fake.session.clearStorageData).toHaveBeenCalled()
  })
})

describe('degram runtime: DG page controls', () => {
  it('switches mode, reloads and places the view', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.setDgMode('full')

    expect(r.runtime.getState().dg.mode).toBe('full')
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/?host=degram`)

    await r.runtime.reloadDg()
    expect(r.fake.reloads()).toBe(1)

    r.runtime.setDgBounds({ x: 1, y: 2, width: 300, height: 200 })
    expect(r.fake.bounds()).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(r.fake.visible()).toBe(true)
  })

  it('shows the DG page again after a revocation blanked the view, on the renderer asking for a mode', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.dgView.reset()
    expect(r.runtime.getState().dg.page).toBe('blank')

    await r.runtime.setDgMode('graph')

    expect(r.runtime.getState().dg.page).toBe('dg')
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/#degram`)
  })

  it('does not show the DG page for a signed-out session when a mode is chosen', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()
    await r.runtime.setDgMode('full')

    expect(r.runtime.getState().dg.page).toBe('sign-in')
  })

  it('forwards a blocked external link to the renderer and opens it only on confirmation', async () => {
    const r = rig()

    await r.runtime.start()
    r.fake.emit('will-navigate', { preventDefault: () => undefined }, 'https://evil.test/x')

    expect(eventsOf(r.sent)).toContainEqual({ type: 'external-link-blocked', url: 'https://evil.test/x' })
    expect(r.openExternal).not.toHaveBeenCalled()

    expect(r.runtime.openExternalConfirmed('https://evil.test/x')).toBe(true)
    expect(r.openExternal).toHaveBeenCalledWith('https://evil.test/x')
    expect(r.runtime.openExternalConfirmed('file:///etc/passwd')).toBe(false)
  })
})

describe('registerDegramIpc', () => {
  function register(runtime: DegramRuntime, trusted: (sender: unknown) => boolean = () => true) {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()

    registerDegramIpc({ handle: (channel, handler) => void handlers.set(channel, handler as never) }, runtime, trusted)

    return handlers
  }

  const trustedEvent = { sender: 'main' }

  it('registers one handler per request channel and none that can read a credential', () => {
    const r = rig()
    const handlers = register(r.runtime)

    expect([...handlers.keys()].sort()).toEqual(
      [
        DEGRAM_CHANNELS.getState,
        DEGRAM_CHANNELS.selectProject,
        DEGRAM_CHANNELS.signOut,
        DEGRAM_CHANNELS.setDgMode,
        DEGRAM_CHANNELS.reloadDg,
        DEGRAM_CHANNELS.retryDg,
        DEGRAM_CHANNELS.setTrayLabels,
        DEGRAM_CHANNELS.setDgBounds,
        DEGRAM_CHANNELS.reportOutcome,
        DEGRAM_CHANNELS.openExternalConfirmed,
        DEGRAM_CHANNELS.setPairing,
        DEGRAM_CHANNELS.clearPairing
      ].sort()
    )

    for (const channel of Object.values(DEGRAM_CHANNELS)) {
      expect(channel.startsWith('degram:')).toBe(true)
      expect(channel).not.toMatch(/token|credential|secret/i)
    }
  })

  it('rejects calls from a sender that is not the DeGram main window', async () => {
    const r = rig()
    const handlers = register(r.runtime, sender => sender === 'main')

    await expect(handlers.get(DEGRAM_CHANNELS.signOut)!({ sender: 'a webview' })).rejects.toThrow(/sender/i)
    await expect(handlers.get(DEGRAM_CHANNELS.getState)!({ sender: 'a webview' })).rejects.toThrow(/sender/i)
    expect(r.dg.requests.some(req => req.url.endsWith('/auth/logout'))).toBe(false)
  })

  it('validates every payload before touching the runtime', async () => {
    const r = rig()
    const handlers = register(r.runtime)
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(trustedEvent, ...args)

    await r.runtime.start()

    await expect(call(DEGRAM_CHANNELS.selectProject, '')).rejects.toThrow(/project/i)
    await expect(call(DEGRAM_CHANNELS.selectProject, 7)).rejects.toThrow(/project/i)
    await expect(call(DEGRAM_CHANNELS.selectProject, 'x'.repeat(300))).rejects.toThrow(/project/i)
    await expect(call(DEGRAM_CHANNELS.setDgMode, 'bogus')).rejects.toThrow(/mode/i)
    await expect(call(DEGRAM_CHANNELS.setDgBounds, { x: 'a' })).rejects.toThrow(/bounds/i)
    await expect(call(DEGRAM_CHANNELS.reportOutcome, 'NOT_A_REAL_CODE')).rejects.toThrow(/outcome/i)
    await expect(call(DEGRAM_CHANNELS.reportOutcome, 7)).rejects.toThrow(/outcome/i)
    await expect(call(DEGRAM_CHANNELS.openExternalConfirmed, 5)).rejects.toThrow(/url/i)

    expect(r.rpcCalls).toEqual([])
  })

  it('serves the happy paths', async () => {
    const r = rig()
    const handlers = register(r.runtime)
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(trustedEvent, ...args)

    await r.runtime.start()

    expect(await call(DEGRAM_CHANNELS.getState)).toMatchObject({ auth: { kind: 'signed-in' } })
    expect(await call(DEGRAM_CHANNELS.selectProject, 'alpha')).toMatchObject({ ok: true })
    await call(DEGRAM_CHANNELS.setDgMode, 'full')
    await call(DEGRAM_CHANNELS.setDgBounds, null)
    expect(await call(DEGRAM_CHANNELS.reportOutcome, 'CREDENTIALS_EXPIRED')).toBe(true)
    expect(await call(DEGRAM_CHANNELS.openExternalConfirmed, 'https://example.test/')).toBe(true)
    await call(DEGRAM_CHANNELS.signOut)

    expect(r.runtime.getState().auth.kind).toBe('signed-out')
  })
})

describe('degram runtime: revocation reaches the renderer only after clearing (Task 3)', () => {
  it('a 401 on the focus check clears credential, scope and view, then sends session-ended and a signed-out state', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')

    r.sent.length = 0
    r.log.entries.length = 0
    r.dg.setMe({ status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } })

    await r.runtime.onWindowFocus()

    const order = [
      'rpc:degram.credentials.clear',
      'view.load about:blank',
      'view.clearStorageData',
      'view.clearCache',
      'send:degram:event:session-ended'
    ].map(entry => r.log.indexOf(entry))

    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // nothing at all reached the renderer before the wipe finished
    const firstSend = r.log.entries.findIndex(entry => entry.startsWith('send:'))

    expect(firstSend).toBeGreaterThan(r.log.indexOf('view.clearCache'))

    expect(states(r.sent).pop()).toMatchObject({
      auth: { kind: 'signed-out', memberships: [] },
      scope: { status: 'no-project', project: null },
      dg: { page: 'sign-in' }
    })
    expect(eventsOf(r.sent)).toContainEqual({ type: 'session-ended' })
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/?host=degram`)
    expect(JSON.stringify(r.sent)).not.toContain('alpha')
  })

  it('losing the membership of the active project purges that scope and sends access-revoked with the empty-project state', async () => {
    const r = rig({
      memberships: [
        { project: 'alpha', company: 'ACME' },
        { project: 'beta', company: 'ACME' }
      ]
    })

    await r.runtime.start()
    await r.runtime.selectProject('alpha')

    r.sent.length = 0
    r.log.entries.length = 0
    r.dg.setMe(r.dg.signedInMe('beta'))

    await r.runtime.onWindowFocus()

    expect(r.log.indexOf('profiles.purge:alpha')).toBeGreaterThanOrEqual(0)
    expect(r.log.indexOf('profiles.purge:alpha')).toBeLessThan(r.log.indexOf('send:degram:event:access-revoked'))
    expect(eventsOf(r.sent)).toContainEqual({ type: 'access-revoked', project: 'alpha', purged: true })

    const last = states(r.sent).pop()

    expect(last.auth.kind).toBe('signed-in')
    expect(last.scope).toMatchObject({ status: 'no-project', project: null })
    expect(JSON.stringify(last.scope)).not.toContain('alpha')
  })

  it('forwards agent outcomes to the scope controller and reports whether the code was an access signal', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')

    expect(await r.runtime.reportOutcome('DELEGATED_SESSION_ENDED')).toBe(true)
    expect(eventsOf(r.sent)).toContainEqual({ type: 'session-ended' })
    expect(await r.runtime.reportOutcome('NOT_AN_ACCESS_CODE')).toBe(false)
  })

  it('a dg_session cookie change that turns out to be a lost session also ends it cleanly', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.sent.length = 0
    r.dg.setMe({ status: 401 })

    await r.runtime.onAuthCookieChanged()

    expect(eventsOf(r.sent)).toContainEqual({ type: 'session-ended' })
    expect(r.runtime.getState().auth.kind).toBe('signed-out')
  })

  it('an explicit sign-out is not followed by a session-ended event from the cookie wipe', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.sent.length = 0
    await r.runtime.signOut()

    // the partition wipe makes the cookie change; DG then answers 401 to the re-check
    r.dg.setMe({ status: 401 })
    await r.runtime.onAuthCookieChanged()

    expect(eventsOf(r.sent).filter(e => e.type === 'session-ended')).toEqual([])
  })
})

describe('DeGram pairing over IPC (Phase 1301-17, D-25)', () => {
  function register(runtime: DegramRuntime) {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()

    registerDegramIpc(
      { handle: (channel, handler) => void handlers.set(channel, handler as never) },
      runtime,
      () => true
    )

    return handlers
  }

  const event = { sender: 'main' }

  it('state carries the pairing status and never the token', async () => {
    const r = rig()

    await r.runtime.start()

    expect(r.runtime.getState().pairing).toEqual({ status: 'none', company: null, available: true })

    const handlers = register(r.runtime)
    const result = await handlers.get(DEGRAM_CHANNELS.setPairing)!(event, PAIRING_TOKEN)

    expect(result).toEqual({ ok: true })
    expect(r.runtime.getState().pairing.status).toBe('stored')
    expect(JSON.stringify(r.sent)).not.toContain(PAIRING_TOKEN)
    expect(JSON.stringify(r.runtime.getState())).not.toContain('dgp_')
    expect(JSON.stringify(result)).not.toContain('dgp_')
  })

  it('validates the token before it reaches the store', async () => {
    const pairing = createFakePairing()
    const r = rig({ pairing })
    const handlers = register(r.runtime)

    for (const bad of ['', 'dgd_' + 'A'.repeat(43), 'dgp_short', 7, null, `dgp_${'A'.repeat(300)}`]) {
      await expect(handlers.get(DEGRAM_CHANNELS.setPairing)!(event, bad)).rejects.toThrow(/invalid pairing/)
    }

    expect(pairing.get()).toBeNull()
  })

  it('clearPairing forgets the stored token and the state returns to none', async () => {
    const pairing = createFakePairing(PAIRING_TOKEN)
    const r = rig({ pairing })
    const handlers = register(r.runtime)

    expect(r.runtime.getState().pairing.status).toBe('stored')
    await handlers.get(DEGRAM_CHANNELS.clearPairing)!(event)

    expect(pairing.get()).toBeNull()
    expect(r.runtime.getState().pairing.status).toBe('none')
  })

  it('without a pairing store the feature reports unavailable and refuses to store', async () => {
    const r = rig({ pairing: null })
    const handlers = register(r.runtime)

    expect(r.runtime.getState().pairing).toEqual({ status: 'none', company: null, available: false })
    expect(await handlers.get(DEGRAM_CHANNELS.setPairing)!(event, PAIRING_TOKEN)).toEqual({
      ok: false,
      code: 'ENCRYPTION_UNAVAILABLE'
    })
  })

  it('a revoked pairing is published as the revoked state and announced once', async () => {
    const r = rig({ pairing: createFakePairing(PAIRING_TOKEN) })

    await r.runtime.start()
    r.dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })

    const result = await r.runtime.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'PAIRING_REVOKED' })
    expect(r.runtime.getState().pairing.status).toBe('revoked')
    expect(eventsOf(r.sent).filter(e => e.type === 'pairing-revoked')).toHaveLength(1)
    expect(states(r.sent).at(-1).pairing.status).toBe('revoked')
  })
})

describe('degram runtime: tray sign-out entry (G-17)', () => {
  function register(runtime: DegramRuntime, trusted: (sender: unknown) => boolean) {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()

    registerDegramIpc({ handle: (channel, handler) => void handlers.set(channel, handler as never) }, runtime, trusted)

    return handlers
  }

  it('starts with the Russian default label and swaps in the renderer label, rebuilding the native menu', () => {
    const r = rig()

    expect(r.runtime.getTrayLabels()).toEqual({ signOut: 'Выйти из DG' })

    r.runtime.setTrayLabels({ signOut: 'Sign out of DG' })

    expect(r.runtime.getTrayLabels()).toEqual({ signOut: 'Sign out of DG' })
    expect(r.trayChanged).toHaveBeenCalledTimes(1)
  })

  it('requestSignOut asks the renderer on the request-sign-out channel and carries no payload', () => {
    const r = rig()

    r.runtime.requestSignOut()

    expect(r.sent).toContainEqual({ channel: DEGRAM_CHANNELS.requestSignOut, payload: null })
  })

  it('the set-tray-labels handler validates its payload and refuses a stranger', async () => {
    const r = rig()
    const handlers = register(r.runtime, sender => sender === 'main')
    const set = handlers.get(DEGRAM_CHANNELS.setTrayLabels)!

    await set({ sender: 'main' }, { signOut: '  Sign out of DG  ' })
    expect(r.runtime.getTrayLabels().signOut).toBe('Sign out of DG')

    await expect(set({ sender: 'main' }, { signOut: '' })).rejects.toThrow(/tray labels/)
    await expect(set({ sender: 'main' }, { signOut: 'x'.repeat(200) })).rejects.toThrow(/tray labels/)
    await expect(set({ sender: 'main' }, { signOut: 'a\nb' })).rejects.toThrow(/tray labels/)
    await expect(set({ sender: 'main' }, null)).rejects.toThrow(/tray labels/)
    await expect(set({ sender: 'other' }, { signOut: 'ok' })).rejects.toThrow(/untrusted/)
    expect(r.runtime.getTrayLabels().signOut).toBe('Sign out of DG')
  })
})
