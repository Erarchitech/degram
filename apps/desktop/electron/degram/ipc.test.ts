// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createDegramRuntime, DEGRAM_CHANNELS, type DegramRuntime, registerDegramIpc } from './ipc'
import type { BackendHandle, ScopeKey } from './scope'
import { createFakeClock, createFakeDg, createFakeViewFactory, createLog, TOKEN_A } from './test-support'

type Sent = { channel: string; payload: unknown }

function rig(options: { signedIn?: boolean; memberships?: { project: string; company?: string | null }[] } = {}) {
  const log = createLog()
  const dg = createFakeDg()
  const clock = createFakeClock()
  const viewFactory = createFakeViewFactory(log)
  const sent: Sent[] = []
  const rpcCalls: { method: string; params: unknown }[] = []
  const openExternal = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const memberships = options.memberships ?? [{ project: 'alpha', company: 'ACME' }]

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
      }
    },
    backend: { ensure: async () => handle, release: async () => undefined },
    send: (channel, payload) => {
      log.push(`send:${channel}${channel === DEGRAM_CHANNELS.event ? `:${(payload as { type: string }).type}` : ''}`)
      sent.push({ channel, payload })
    }
  })

  return { log, dg, clock, viewFactory, fake: viewFactory.fake, sent, rpcCalls, openExternal, runtime, logger }
}

const states = (sent: Sent[]) => sent.filter(s => s.channel === DEGRAM_CHANNELS.stateChanged).map(s => s.payload as any)
const eventsOf = (sent: Sent[]) => sent.filter(s => s.channel === DEGRAM_CHANNELS.event).map(s => s.payload as any)

describe('degram runtime: sign-in page and initial state', () => {
  it('starts on the DG login page when signed out and exposes no project', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/`])
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

  it('a sign-in completed inside the DG page is picked up from the cookie change and opens the DG page', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()

    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.runtime.onAuthCookieChanged()

    expect(r.runtime.getState().auth.kind).toBe('signed-in')
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/#degram`)
    expect(states(r.sent).pop().auth.kind).toBe('signed-in')
  })

  it('an unreachable DG server on start still loads the sign-in page and reports unreachable', async () => {
    const r = rig({ signedIn: false })

    r.dg.setMe('network-error')
    await r.runtime.start()
    r.fake.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', `${r.dg.origin}/`, true)

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/`])
    expect(r.runtime.getState().dg.reachable).toBe(false)
    expect(eventsOf(r.sent)).toContainEqual({ type: 'dg-unreachable' })

    r.fake.emit('did-finish-load')
    expect(r.runtime.getState().dg.reachable).toBe(true)
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
      `view.load ${r.dg.origin}/`
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
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/`)

    await r.runtime.reloadDg()
    expect(r.fake.reloads()).toBe(1)

    r.runtime.setDgBounds({ x: 1, y: 2, width: 300, height: 200 })
    expect(r.fake.bounds()).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(r.fake.visible()).toBe(true)
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
        DEGRAM_CHANNELS.setDgBounds,
        DEGRAM_CHANNELS.reportOutcome,
        DEGRAM_CHANNELS.openExternalConfirmed
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
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/`)
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
