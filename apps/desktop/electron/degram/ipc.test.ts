// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import type { ConnectorInstaller, ConnectorInstallState, InstallableConnector } from './connector-install'
import { createDegramRuntime, DEGRAM_CHANNELS, type DegramRuntime, registerDegramIpc } from './ipc'
import type { BackendHandle, ScopeKey } from './scope'
import { environmentIdForOrigin } from './dg-target-config'
import {
  createFakeClock,
  createFakeDg,
  createFakeViewFactory,
  createLog,
  TOKEN_A
} from './test-support'

type Sent = { channel: string; payload: unknown }

function rig(
  options: {
    signedIn?: boolean
    generation?: number
    memberships?: { project: string; company?: string | null }[]
    connectors?: ConnectorInstaller
    confirmInstall?: (id: InstallableConnector, locale: 'ru' | 'en') => Promise<boolean>
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
    environmentId: environmentIdForOrigin(dg.origin),
    generation: options.generation,
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
      migrateLegacy: async () => undefined,
      cleanupLegacy: async () => ({ ran: false, failed: [] })
    },
    backend: { ensure: async () => handle, release: async () => undefined },
    onTrayLabelsChanged: trayChanged,
    connectors: options.connectors,
    confirmInstall: options.confirmInstall,
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
  it('stamps production state and events with the immutable runtime environment generation', async () => {
    const r = rig({ generation: 7 })
    await r.runtime.start()
    const stamp = { environmentId: environmentIdForOrigin(r.dg.origin), generation: 7 }
    expect(r.runtime.getState().environment).toEqual(stamp)
    expect(states(r.sent).every(state => JSON.stringify(state.environment) === JSON.stringify(stamp))).toBe(true)
    r.fake.emit('did-fail-load', {}, -105, 'unreachable', r.dg.origin, true)
    expect(eventsOf(r.sent).length).toBeGreaterThan(0)
    expect(eventsOf(r.sent).every(event => JSON.stringify(event.environment) === JSON.stringify(stamp))).toBe(true)
    r.runtime.dispose()
  })

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

  it('starts on the host-mode V2 app when signed in and still selects no project implicitly', async () => {
    const r = rig()

    await r.runtime.start()

    // The start screen's project choice lives in the Projects region of the host-mode app; the #degram slice
    // cannot announce one (0.1.7 live UAT: the project click opened only the compact graph).
    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])
    expect(r.runtime.getState().dg).toMatchObject({ page: 'dg', mode: 'full' })
    expect(r.runtime.getState().auth).toMatchObject({
      kind: 'signed-in',
      username: 'alice',
      memberships: [{ project: 'alpha', role: 'viewer', company: 'ACME' }]
    })
    expect(r.runtime.getState().scope.status).toBe('no-project')
    expect(r.rpcCalls).toEqual([])
  })

  it('does not mint credentials until a project is selected', async () => {
    const r = rig()

    await r.runtime.start()

    expect(r.dg.mintCount()).toBe(0)
    expect(r.runtime.getState().scope.status).toBe('no-project')
    expect(r.dg.requests.some(q => q.url.endsWith('/auth/degram/exchange'))).toBe(false)
  })

  it('a sign-in completed inside the DG page is picked up from the cookie change and opens the DG page', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()

    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.runtime.onAuthCookieChanged()

    expect(r.runtime.getState().auth.kind).toBe('signed-in')
    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/?host=degram`)
    expect(states(r.sent).pop().auth.kind).toBe('signed-in')
  })

  it('a sign-in after the user had chosen the graph slice still lands on the host-mode start page', async () => {
    const r = rig({ signedIn: false })

    await r.runtime.start()
    await r.runtime.setDgMode('graph')

    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.runtime.onAuthCookieChanged()

    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/?host=degram`)
    expect(r.runtime.getState().dg.mode).toBe('full')
  })

  it('a project chosen on the start page is announced by the page and opens the scope', async () => {
    const r = rig()

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=alpha`, true)

    await vi.waitFor(() => expect(r.runtime.getState().scope).toMatchObject({ status: 'ready', project: 'alpha' }))
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

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])
    expect(r.runtime.getState().auth.kind).toBe('signed-in')
  })

  it('reloads the start page of a session that stayed signed in without a project while DG was unreachable', async () => {
    const r = rig()

    await r.runtime.start()
    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])

    r.fake.emit('did-start-loading')
    r.fake.emit('did-fail-load', {}, -101, 'ERR_CONNECTION_RESET', `${r.dg.origin}/?host=degram`, true)
    r.fake.emit('did-finish-load')
    expect(r.runtime.getState().dg.reachable).toBe(false)

    await r.runtime.retryDg()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`, `${r.dg.origin}/?host=degram`])
  })

  it('reloads the chosen mode of a session with an open project after DG was unreachable', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    await r.runtime.setDgMode('graph')

    r.fake.emit('did-start-loading')
    r.fake.emit('did-fail-load', {}, -101, 'ERR_CONNECTION_RESET', `${r.dg.origin}/#degram`, true)
    r.fake.emit('did-finish-load')

    await r.runtime.retryDg()

    expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/#degram`)
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
        DEGRAM_CHANNELS.dgGo,
        DEGRAM_CHANNELS.setLocale,
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
    await expect(call(DEGRAM_CHANNELS.dgGo, 'aiengine')).rejects.toThrow(/region/i)
    await expect(call(DEGRAM_CHANNELS.dgGo, '#degram-go=graph')).rejects.toThrow(/region/i)
    await expect(call(DEGRAM_CHANNELS.dgGo, 7)).rejects.toThrow(/region/i)
    await expect(call(DEGRAM_CHANNELS.setLocale, 'de')).rejects.toThrow(/locale/i)
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

  it('after an access loss the start screen gets the host-mode page back, not a blank view', async () => {
    const r = rig({
      memberships: [
        { project: 'alpha', company: 'ACME' },
        { project: 'beta', company: 'ACME' }
      ]
    })

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    await r.runtime.setDgMode('graph')
    r.dg.setMe(r.dg.signedInMe('beta'))

    await r.runtime.onWindowFocus()
    await vi.waitFor(() => expect(r.fake.loaded[r.fake.loaded.length - 1]).toBe(`${r.dg.origin}/?host=degram`))

    expect(r.log.indexOf('view.load about:blank')).toBeLessThan(r.log.entries.lastIndexOf(`view.load ${r.dg.origin}/?host=degram`))
    expect(r.runtime.getState().dg).toMatchObject({ page: 'dg', mode: 'full' })
  })

  it('forwards agent outcomes to the scope controller and reports whether the code was an access signal', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')

    expect(await r.runtime.reportOutcome('DELEGATED_SESSION_ENDED')).toBe(true)
    expect(eventsOf(r.sent)).not.toContainEqual({ type: 'session-ended' })
    expect(r.runtime.getState().scope.status).toBe('ready')
    expect(r.dg.mintCount()).toBe(2)
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

describe('DeGram grant-required runtime path', () => {
  it('never exposes pairing channels, state or a pasted token field through IPC', async () => {
    const r = rig()
    const handlers = new Map<string, unknown>()
    registerDegramIpc({ handle: (channel, handler) => void handlers.set(channel, handler) }, r.runtime, () => true)
    await r.runtime.start()

    expect([...handlers.keys()].join(' ')).not.toContain('pairing')
    expect(r.runtime.getState()).not.toHaveProperty('pairing')
    expect(r.dg.requests.some(q => q.url.endsWith('/auth/degram/exchange'))).toBe(false)
  })

  it('a missing grant returns to the start screen without signing out or purging membership', async () => {
    const r = rig()
    await r.runtime.start()
    await r.runtime.setDgMode('graph')
    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })

    const result = await r.runtime.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'GRANT_REQUIRED' })
    expect(eventsOf(r.sent)).toContainEqual({ type: 'grant-required', project: 'alpha' })
    expect(r.runtime.getState().auth.kind).toBe('signed-in')
    expect(r.runtime.getState().scope.status).toBe('no-project')
    expect(r.log.entries.some(entry => entry.startsWith('profiles.purge:'))).toBe(false)
    await vi.waitFor(() => expect(r.fake.loaded.at(-1)).toBe(`${r.dg.origin}/?host=degram`))
  })

  it('a revoked grant while the scope is open returns to start with the same notice', async () => {
    const r = rig()
    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })

    await r.runtime.reportOutcome('DELEGATED_SESSION_ENDED')

    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set', 'degram.credentials.clear'])
    expect(eventsOf(r.sent)).toContainEqual({ type: 'grant-required', project: 'alpha' })
    expect(r.runtime.getState().auth.kind).toBe('signed-in')
    expect(r.runtime.getState().scope.status).toBe('no-project')
    expect(r.log.entries.some(entry => entry.startsWith('profiles.purge:'))).toBe(false)
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

describe('degram runtime: host to page signals and new-session (D-41, D-42, D-44)', () => {
  const stateFragments = (r: ReturnType<typeof rig>) =>
    r.fake.loaded.filter(url => url.includes('#degram-state=')).map(url => url.slice(url.indexOf('#')))

  it('a project announcement signals connecting, then ready once the scope opened, with no page reload', async () => {
    const r = rig()

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=alpha`, true)

    await vi.waitFor(() => expect(r.runtime.getState().scope.status).toBe('ready'))
    await vi.waitFor(() => expect(stateFragments(r)).toEqual(['#degram-state=connecting', '#degram-state=ready']))

    expect(r.fake.loaded[0]).toBe(`${r.dg.origin}/?host=degram`)
    expect(r.fake.reloads()).toBe(0)
  })

  it('closing the scope signals idle and a refused announcement settles back to idle', async () => {
    const r = rig()

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=alpha`, true)
    await vi.waitFor(() => expect(r.runtime.getState().scope.status).toBe('ready'))

    // A grant revoked mid-scope closes it and returns to the start page, whose ring is idle again.
    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })
    await r.runtime.reportOutcome('DELEGATED_SESSION_ENDED')
    await vi.waitFor(() => expect(stateFragments(r).at(-1)).toBe('#degram-state=idle'))
    expect(r.fake.loaded.at(-1)).not.toContain('ready')

    const refused = rig()

    refused.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })
    await refused.runtime.start()
    refused.fake.emit('did-navigate-in-page', {}, `${refused.dg.origin}/?host=degram#degram-select=alpha`, true)

    await vi.waitFor(() => expect(stateFragments(refused).at(-1)).toBe('#degram-state=idle'))
    expect(stateFragments(refused)[0]).toBe('#degram-state=connecting')
  })

  // 1301-37 F-07 (D-48): a refused pick leaves the open project running and puts the DG page back on it.
  const projectFragments = (r: ReturnType<typeof rig>) =>
    r.fake.loaded.filter(url => url.includes('#degram-project=')).map(url => url.slice(url.indexOf('#')))

  const twoProjects = [
    { project: 'alpha', company: 'ACME' },
    { project: 'beta', company: 'ACME' }
  ]

  it('a pick refused for a missing grant keeps the open project and signals it back to the DG page', async () => {
    const r = rig({ memberships: twoProjects })

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=alpha`, true)
    await vi.waitFor(() => expect(r.runtime.getState().scope.status).toBe('ready'))

    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=beta`, true)

    await vi.waitFor(() => expect(projectFragments(r)).toEqual(['#degram-project=alpha']))
    await vi.waitFor(() => expect(stateFragments(r).at(-1)).toBe('#degram-state=ready'))
    expect(r.runtime.getState().scope).toMatchObject({ status: 'ready', project: 'alpha' })
    expect(r.runtime.getState().scope.profile).toBe('scope-alpha')
    // The page was never reloaded and the DG start page was not swapped for the sign-in or a blank page.
    expect(r.fake.reloads()).toBe(0)
  })

  it('a pick refused with no project open signals no project and an idle ring', async () => {
    const r = rig({ memberships: twoProjects })

    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })
    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=beta`, true)

    await vi.waitFor(() => expect(projectFragments(r)).toEqual(['#degram-project=']))
    await vi.waitFor(() => expect(stateFragments(r).at(-1)).toBe('#degram-state=idle'))
  })

  it('a refused pick through the renderer selection also signals the open project', async () => {
    const r = rig({ memberships: twoProjects })

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    r.dg.setSessionExchange({ status: 403, body: { detail: { code: 'GRANT_REQUIRED' } } })

    expect(await r.runtime.selectProject('beta')).toMatchObject({ ok: false, code: 'GRANT_REQUIRED' })
    await vi.waitFor(() => expect(projectFragments(r)).toEqual(['#degram-project=alpha']))
  })

  it('a pick that opened the requested project signals no #degram-project (the page already shows it)', async () => {
    const r = rig({ memberships: twoProjects })

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-select=alpha`, true)
    await vi.waitFor(() => expect(r.runtime.getState().scope.status).toBe('ready'))

    expect(projectFragments(r)).toEqual([])
  })

  it('a malformed or non-announcing hash signals nothing', async () => {
    const r = rig()

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/#degram-select=%E0%A4%A`, true)
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/#degram-select=Alpha`, false)
    r.fake.emit('did-navigate-in-page', {}, 'https://evil.test/#degram-select=alpha', true)
    await Promise.resolve()

    expect(r.fake.loaded).toEqual([`${r.dg.origin}/?host=degram`])
  })

  it('forwards new-session-requested only while a scope is ready', async () => {
    const r = rig()
    const newSession = () => eventsOf(r.sent).filter(e => e.type === 'new-session-requested')

    await r.runtime.start()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-new-session`, true)
    expect(newSession()).toEqual([])

    await r.runtime.selectProject('alpha')
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/?host=degram#degram-new-session`, true)
    expect(newSession()).toEqual([{ type: 'new-session-requested' }])

    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/#degram-new-session`, false)
    r.fake.emit('did-navigate-in-page', {}, 'https://evil.test/#degram-new-session', true)
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/#degram-new-session=1`, true)
    expect(newSession()).toHaveLength(1)

    await r.runtime.signOut()
    r.fake.emit('did-navigate-in-page', {}, `${r.dg.origin}/#degram-new-session`, true)
    expect(newSession()).toHaveLength(1)
  })

  it('a reload of the page while the scope is ready carries the ready state in its initial hash', async () => {
    const r = rig()

    await r.runtime.start()
    await r.runtime.selectProject('alpha')
    await r.runtime.setDgMode('full')
    await r.runtime.retryDg()
    await r.runtime.setDgMode('full')
    await r.runtime.setLocale('ru')
    await r.runtime.dgView.showDg()

    expect(r.fake.loaded.at(-1)).toBe(`${r.dg.origin}/?host=degram&lang=ru#degram-state=ready`)
  })

  it('queues a live locale signal ahead of later DG navigation', async () => {
    const r = rig()
    await r.runtime.start()

    let finishLocaleLoad!: () => void
    const localeLoad = new Promise<void>(resolve => { finishLocaleLoad = resolve })
    r.fake.view.webContents.loadURL.mockImplementationOnce(async (url: string) => {
      r.fake.loaded.push(url)
      await localeLoad
    })

    const changeLocale = r.runtime.setLocale('ru')
    await vi.waitFor(() => expect(r.fake.loaded.at(-1)).toBe(`${r.dg.origin}/?host=degram#degram-lang=ru`))
    const goProjects = r.runtime.dgGo('projects')
    await Promise.resolve()
    expect(r.fake.loaded).toHaveLength(2)

    finishLocaleLoad()
    await Promise.all([changeLocale, goProjects])
    expect(r.fake.loaded.at(-1)).toBe(`${r.dg.origin}/?host=degram#degram-go=projects`)
  })

  it('dg-go steers the page by fragment through the handler and refuses an unknown region', async () => {
    const r = rig()
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()

    registerDegramIpc({ handle: (channel, handler) => void handlers.set(channel, handler as never) }, r.runtime, () => true)
    await r.runtime.start()

    const go = handlers.get(DEGRAM_CHANNELS.dgGo)!

    await go({ sender: 'main' }, 'graph')
    await go({ sender: 'main' }, 'connectors')
    await go({ sender: 'main' }, 'projects')
    await expect(go({ sender: 'main' }, 'aiengine')).rejects.toThrow(/region/)

    expect(r.fake.loaded.slice(1)).toEqual([
      `${r.dg.origin}/?host=degram#degram-go=graph`,
      `${r.dg.origin}/?host=degram#degram-go=connectors`,
      `${r.dg.origin}/?host=degram#degram-go=projects`
    ])

    await handlers.get(DEGRAM_CHANNELS.setLocale)!({ sender: 'main' }, 'ru')
    await r.runtime.dgView.showStart()
    expect(r.fake.loaded.at(-1)).toBe(`${r.dg.origin}/?host=degram&lang=ru`)
  })
})

describe('connector install from the Connectors tab (quick 261027-sgc)', () => {
  const HOST = (origin: string) => `${origin}/?host=degram`

  function fakeInstaller(initial: Record<InstallableConnector, ConnectorInstallState>, result: ConnectorInstallState = 'ready') {
    const states = { ...initial }

    const install = vi.fn(async (id: InstallableConnector) => {
      if (result === 'ready') {
        states[id] = 'ready'
      }

      return result
    })

    const installer: ConnectorInstaller = {
      targetFor: id => `/target/${id}`,
      status: async id => states[id],
      statusAll: async () => ({ ...states }),
      install
    }

    return { installer, install }
  }

  it('answers a check with the install state of both connectors', async () => {
    const { installer } = fakeInstaller({ revit: 'install', grasshopper: 'unavailable' })
    const r = rig({ connectors: installer, confirmInstall: async () => true })
    await r.runtime.start()

    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-connectors-check`, true)

    await vi.waitFor(() =>
      expect(r.fake.loaded).toContain(`${HOST(r.dg.origin)}#degram-installed=revit:install,grasshopper:unavailable`)
    )
  })

  it('installs only after the native confirmation, in the DeGram locale, and reports installing then ready', async () => {
    const { installer, install } = fakeInstaller({ revit: 'install', grasshopper: 'ready' })
    const confirm = vi.fn(async () => true)
    const r = rig({ connectors: installer, confirmInstall: confirm })
    await r.runtime.start()
    await r.runtime.setLocale('en')

    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-install=revit`, true)

    await vi.waitFor(() => expect(r.fake.loaded).toContain(`${HOST(r.dg.origin)}#degram-installed=revit:ready,grasshopper:ready`))
    expect(confirm).toHaveBeenCalledWith('revit', 'en')
    expect(install).toHaveBeenCalledWith('revit')
    const installing = r.fake.loaded.indexOf(`${HOST(r.dg.origin)}#degram-installed=revit:installing,grasshopper:ready`)
    expect(installing).toBeGreaterThan(-1)
    expect(installing).toBeLessThan(r.fake.loaded.indexOf(`${HOST(r.dg.origin)}#degram-installed=revit:ready,grasshopper:ready`))
  })

  it('writes nothing when the user cancels, and re-reports the unchanged state', async () => {
    const { installer, install } = fakeInstaller({ revit: 'install', grasshopper: 'install' })
    const r = rig({ connectors: installer, confirmInstall: async () => false })
    await r.runtime.start()

    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-install=grasshopper`, true)

    await vi.waitFor(() => expect(r.fake.loaded).toContain(`${HOST(r.dg.origin)}#degram-installed=revit:install,grasshopper:install`))
    expect(install).not.toHaveBeenCalled()
  })

  it('keeps a locked result visible instead of re-reading install', async () => {
    const { installer } = fakeInstaller({ revit: 'ready', grasshopper: 'install' }, 'locked')
    const r = rig({ connectors: installer, confirmInstall: async () => true })
    await r.runtime.start()

    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-install=grasshopper`, true)

    await vi.waitFor(() => expect(r.fake.loaded).toContain(`${HOST(r.dg.origin)}#degram-installed=revit:ready,grasshopper:locked`))
  })

  it('a page cannot stack dialogs: requests during an open confirmation are ignored', async () => {
    const { installer, install } = fakeInstaller({ revit: 'install', grasshopper: 'install' })
    let accept: (value: boolean) => void = () => undefined
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve }))
    const r = rig({ connectors: installer, confirmInstall: confirm })
    await r.runtime.start()

    for (const id of ['revit', 'revit', 'grasshopper']) {
      r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-install=${id}`, true)
    }

    expect(confirm).toHaveBeenCalledTimes(1)

    accept(true)
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(install).toHaveBeenCalledWith('revit')
  })

  it('ignores install requests when this build has no installer', async () => {
    const r = rig()
    await r.runtime.start()
    const before = r.fake.loaded.length

    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-install=revit`, true)
    r.fake.emit('did-navigate-in-page', {}, `${HOST(r.dg.origin)}#degram-connectors-check`, true)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(r.fake.loaded.length).toBe(before)
  })
})
