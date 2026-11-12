// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { DEGRAM_CHANNELS } from './ipc'
import { configuredDgTargets, environmentIdForOrigin } from './dg-target-config'
import { createGatewayRpc } from './gateway-rpc'
import { createDegramEnvironmentWiring, createDegramMainWiring } from './main-wiring'
import {
  createFakeAgent,
  createFakeGatewaySocket,
  createFakeMappingServer,
  definitionId,
  LEAKED_COOKIE,
  LEAKED_TOKEN,
  PROOF_SECRET,
  resultHash,
  tupleOf
} from './mapping-intent-test-support'
import type { BackendHandle } from './scope'
import { createFakeClock, createFakeDg, createFakeViewFactory, TOKEN_A, TOKEN_B } from './test-support'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

function fakeWindow() {
  const listeners = new Map<string, (() => void)[]>()
  const sent: { channel: string; payload: unknown }[] = []
  const children: unknown[] = []

  const webContents = {
    id: 1,
    isDestroyed: (): boolean => false,
    send: (channel: string, payload: unknown): void => {
      sent.push({ channel, payload })
    }
  }

  return {
    window: {
      webContents,
      isDestroyed: (): boolean => false,
      contentView: {
        addChildView: (view: unknown): void => void children.push(view),
        removeChildView: (view: unknown): void => {
          const index = children.indexOf(view)

          if (index >= 0) {
            children.splice(index, 1)
          }
        }
      },
      on: (event: string, listener: () => void): void => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: () => void): void => {
        listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener))
      }
    },
    webContents,
    sent,
    children,
    fire: (event: string): void => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    }
  }
}

function rig() {
  const dg = createFakeDg()
  const clock = createFakeClock()
  const viewFactory = createFakeViewFactory()
  const handlers = new Map<string, Handler>()
  const cookieListeners: ((event: unknown, cookie: { name: string }) => void)[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  dg.setMe(dg.signedInMe('alpha'))

  const handle: BackendHandle = { call: async () => ({}) }
  const showWindow = vi.fn()
  const trayChanged = vi.fn()

  const wiring = createDegramMainWiring({
    showWindow,
    onTrayLabelsChanged: trayChanged,
    origin: dg.origin,
    environmentId: environmentIdForOrigin(dg.origin),
    fetch: dg.fetch,
    clock,
    logger,
    createView: viewFactory.factory,
    openExternal: vi.fn(),
    profiles: {
      ensure: async () => ({ profile: 'p' }),
      purge: async () => undefined,
      purgeProject: async () => [],
      migrateLegacy: async () => undefined,
      cleanupLegacy: async () => ({ ran: false, failed: [] })
    },
    backend: { ensure: async () => handle, release: async () => undefined },
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
    cookieSession: {
      cookies: {
        on: (_event: 'changed', listener: (event: unknown, cookie: { name: string }) => void): void => {
          cookieListeners.push(listener)
        }
      }
    }
  })

  return { dg, wiring, handlers, cookieListeners, fake: viewFactory.fake, logger, showWindow, trayChanged }
}

describe('environment main composition', () => {
  function environmentRig() {
    const targets = configuredDgTargets({})
    const handlers = new Map<string, Handler>()
    const registrations = vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler))
    const clocks: ReturnType<typeof createFakeClock>[] = []
    const resources: { dg: ReturnType<typeof createFakeDg>; view: ReturnType<typeof createFakeViewFactory>; cookies: Set<any>; partition: string }[] = []
    const persist = vi.fn()
    let unavailable = false
    const wiring = createDegramEnvironmentWiring({
      targets, selected: targets.developer, persist,
      ipcMain: { handle: registrations },
      createDeps: descriptor => {
        const dg = createFakeDg({ origin: descriptor.origin })
        const view = createFakeViewFactory()
        const cookies = new Set<any>()
        const clock = createFakeClock()
        clocks.push(clock)
        dg.setMe(unavailable ? 'network-error' : dg.signedInMe('alpha'))
        resources.push({ dg, view, cookies, partition: descriptor.partition })
        return {
          origin: descriptor.origin, environmentId: descriptor.environmentId,
          fetch: dg.fetch, clock, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          createView: view.factory, openExternal: vi.fn(),
          profiles: { ensure: async () => ({ profile: 'p' }), purge: async () => undefined,
            purgeProject: async () => [], migrateLegacy: async () => undefined,
            cleanupLegacy: async () => ({ ran: false, failed: [] }) },
          backend: { ensure: async () => ({ call: async () => ({}) }), release: async () => undefined },
          cookieSession: { cookies: { on: (_event, listener) => cookies.add(listener),
            removeListener: (_event, listener) => cookies.delete(listener) } }
        }
      }
    })
    const w = fakeWindow()
    const stamp = () => {
      const state = wiring.controller.getState()
      return { environmentId: state.selected.environmentId, generation: state.generation }
    }
    const call = (channel: string, payload?: unknown) => handlers.get(channel)!({ sender: w.webContents }, payload)
    return { wiring, w, stamp, call, handlers, registrations, resources, clocks, persist, targets,
      setUnavailable: (value: boolean) => { unavailable = value } }
  }

  it('routes landing toggle through the controller and refuses it while an operation lease is held', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()
    await r.call(DEGRAM_CHANNELS.setDgMode, 'full')
    const generation = r.stamp().generation
    const old = r.resources[0]
    expect(old.view.fake.loaded.some(url => url.includes(`dgTarget=developer&dgGeneration=${generation}`)), JSON.stringify(old.view.fake.loaded)).toBe(true)
    const lease = await r.call(DEGRAM_CHANNELS.acquireOperation, r.stamp())
    old.view.fake.emit('did-navigate-in-page', {}, `${old.dg.origin}/?host=degram#degram-target=demo:${generation}`, true)
    await new Promise(resolve => setImmediate(resolve))
    expect(r.wiring.controller.getState().selected.mode).toBe('developer')
    expect(old.view.fake.loaded.some(url => url.endsWith('#degram-target-refused'))).toBe(true)
    await r.call(DEGRAM_CHANNELS.releaseOperation, lease)
    old.view.fake.emit('did-navigate-in-page', {}, `${old.dg.origin}/?host=degram#degram-target=demo:${generation}`, true)
    await vi.waitFor(() => expect(r.wiring.controller.getState()).toMatchObject({ status: 'ready', selected: r.targets.demo }))
    old.view.fake.emit('did-navigate-in-page', {}, `${old.dg.origin}/#degram-target=developer:${generation}`, true)
    await new Promise(resolve => setImmediate(resolve))
    expect(r.wiring.controller.getState().selected.mode).toBe('demo')
  })

  it('replaces actual runtime/view/cookie resources A→B→A without reregistering IPC or wiping storage', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()
    const old = r.resources[0]
    const staleCookie = [...old.cookies][0]
    const count = r.registrations.mock.calls.length
    const before = old.dg.meCount()
    const bounds = { x: 20, y: 30, width: 640, height: 480 }
    await r.call(DEGRAM_CHANNELS.setDgBounds, bounds)
    await r.call(DEGRAM_CHANNELS.setLocale, 'en')
    await r.call(DEGRAM_CHANNELS.setTrayLabels, { signOut: 'Sign out of DG' })
    await r.call(DEGRAM_CHANNELS.selectTarget, { ...r.stamp(), mode: 'demo' })
    expect(r.wiring.controller.getState()).toMatchObject({ status: 'ready', selected: r.targets.demo, effectiveRuntime: r.targets.demo })
    expect(old.cookies.size).toBe(0)
    expect(old.view.fake.closed()).toBe(true)
    expect(r.clocks[0].activeIntervals()).toBe(0)
    expect(r.w.children).toEqual([r.resources[1].view.fake.view])
    expect(r.resources[1].partition).toBe(r.targets.demo.partition)
    expect(r.resources[1].view.fake.visible()).toBe(true)
    expect(r.resources[1].view.fake.loaded.some(url => url.includes('lang=en'))).toBe(true)
    expect(r.wiring.trayItems()[0].label).toBe('Sign out of DG')
    expect(r.resources[1].dg.requests.every(request => request.url.startsWith(r.targets.demo.origin))).toBe(true)
    staleCookie({}, { name: 'dg_session' })
    r.w.fire('focus')
    await new Promise(resolve => setImmediate(resolve))
    expect(old.dg.meCount()).toBe(before)
    await r.call(DEGRAM_CHANNELS.selectTarget, { ...r.stamp(), mode: 'developer' })
    expect(r.w.children).toEqual([r.resources[2].view.fake.view])
    expect(r.registrations.mock.calls.length).toBe(count)
    expect(r.resources.map(item => item.cookies.size)).toEqual([0, 0, 1])
    expect(r.resources.flatMap(item => item.dg.requests).some(request => request.url.endsWith('/auth/logout'))).toBe(false)
  })

  it('keeps the locale the renderer sent before the environment was ready and loads the page in it', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    expect(r.wiring.controller.getState().status).not.toBe('ready')
    await r.call(DEGRAM_CHANNELS.setLocale, 'en')
    await r.call(DEGRAM_CHANNELS.setTrayLabels, { signOut: 'Sign out of DG' })
    await r.wiring.started()
    await r.call(DEGRAM_CHANNELS.setDgMode, 'full')
    const loaded = r.resources[0].view.fake.loaded
    expect(loaded.some(url => url.includes('lang=en')), JSON.stringify(loaded)).toBe(true)
    expect(loaded.some(url => url.includes('lang=ru')), JSON.stringify(loaded)).toBe(false)
    expect(r.wiring.trayItems()[0].label).toBe('Sign out of DG')
  })

  it('stamps composed runtime state and events with each authoritative generation', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()

    for (const mode of ['developer', 'demo', 'developer'] as const) {
      if (r.wiring.controller.getState().selected.mode !== mode) {
        await r.call(DEGRAM_CHANNELS.selectTarget, { ...r.stamp(), mode })
      }
      const stamp = r.stamp()
      expect(await r.call(DEGRAM_CHANNELS.getState)).toMatchObject({ environment: stamp })
      const stateMessages = r.w.sent.filter(message => message.channel === DEGRAM_CHANNELS.stateChanged)
      expect(stateMessages.at(-1)?.payload).toMatchObject({ environment: stamp })
      const resource = r.resources.at(-1)!
      resource.view.fake.emit('did-fail-load', {}, -105, 'unreachable', resource.dg.origin, true)
      const events = r.w.sent.filter(message => message.channel === DEGRAM_CHANNELS.event)
      expect(events.at(-1)?.payload).toMatchObject({ environment: stamp })
    }
  })

  it('retains a failed target, disposes its partial resources and retries only that target', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()
    r.setUnavailable(true)
    expect(await r.call(DEGRAM_CHANNELS.selectTarget, { ...r.stamp(), mode: 'demo' })).toMatchObject({ ok: false, code: 'START_FAILED' })
    expect(r.wiring.controller.getState()).toMatchObject({ selected: r.targets.demo, effectiveRuntime: null, status: 'error' })
    expect(r.w.children).toEqual([])
    expect(r.resources.map(item => item.cookies.size)).toEqual([0, 0])
    expect(r.clocks.every(clock => clock.activeIntervals() === 0)).toBe(true)
    r.setUnavailable(false)
    expect(await r.call(DEGRAM_CHANNELS.retryTarget, r.stamp())).toMatchObject({ ok: true })
    expect(r.resources[2].dg.origin).toBe(r.targets.demo.origin)
  })

  it('rejects forged/stale target calls and keeps a lease busy until explicit release', async () => {
    const r = environmentRig()
    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()
    const stamp = r.stamp()
    expect(() => r.handlers.get(DEGRAM_CHANNELS.selectTarget)!({ sender: {} }, { ...stamp, mode: 'demo' })).toThrow(/sender/)
    expect(() => r.call(DEGRAM_CHANNELS.selectTarget, { ...stamp, generation: -1, mode: 'demo' })).toThrow(/generation/)
    expect(() => r.call(DEGRAM_CHANNELS.selectTarget, { ...stamp, mode: 'https://other.test' })).toThrow(/target/)
    const lease = await r.call(DEGRAM_CHANNELS.acquireOperation, stamp)
    expect(await r.call(DEGRAM_CHANNELS.selectTarget, { ...stamp, mode: 'demo' })).toMatchObject({ ok: false, code: 'BUSY' })
    await r.call(DEGRAM_CHANNELS.releaseOperation, lease)
    expect(await r.call(DEGRAM_CHANNELS.selectTarget, { ...stamp, mode: 'demo' })).toMatchObject({ ok: true })
    expect(() => r.call(DEGRAM_CHANNELS.acquireOperation, stamp)).toThrow(/generation/)
  })
})

describe('degram main wiring: tray entry (G-17)', () => {
  it('offers one sign-out entry that shows the window, then asks the renderer to run its sign-out flow', async () => {
    const { wiring, showWindow } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()

    const items = wiring.trayItems()

    expect(items.map(item => item.label)).toEqual(['Выйти из DG'])

    const requests = (): number => w.sent.filter(s => s.channel === DEGRAM_CHANNELS.requestSignOut).length
    let requestsWhenShown = -1

    showWindow.mockImplementation(() => {
      requestsWhenShown = requests()
    })

    items[0]!.click()

    expect(showWindow).toHaveBeenCalledTimes(1)
    expect(requestsWhenShown).toBe(0) // the window is shown first
    expect(requests()).toBe(1)
    // asking is not signing out: the renderer owns the confirmation
    expect(w.sent.some(s => s.channel === DEGRAM_CHANNELS.signOut)).toBe(false)
  })

  it('a label sent by the renderer replaces the default and asks for the native menu to be rebuilt', async () => {
    const { wiring, handlers, trayChanged } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()
    await handlers.get(DEGRAM_CHANNELS.setTrayLabels)!({ sender: w.webContents }, { signOut: 'Sign out of DG' })

    expect(wiring.trayItems()[0]!.label).toBe('Sign out of DG')
    expect(trayChanged).toHaveBeenCalledTimes(1)
  })
})

describe('degram main wiring', () => {
  it('registers the degram IPC handlers once, at construction', () => {
    const { handlers } = rig()

    expect(handlers.has(DEGRAM_CHANNELS.getState)).toBe(true)
    expect(handlers.has(DEGRAM_CHANNELS.signOut)).toBe(true)
  })

  it('mounts the DG view into the window hidden, starts the runtime and pushes state to that window', async () => {
    const { wiring, fake, dg } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()

    expect(w.children).toEqual([fake.view])
    expect(fake.visible()).toBe(false)
    expect(fake.loaded).toEqual([`${dg.origin}/?host=degram`])
    expect(w.sent.some(s => s.channel === DEGRAM_CHANNELS.stateChanged)).toBe(true)
  })

  it('answers IPC only for the attached window', async () => {
    const { wiring, handlers } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()

    const getState = handlers.get(DEGRAM_CHANNELS.getState)!

    await expect(getState({ sender: w.webContents })).resolves.toMatchObject({ auth: { kind: 'signed-in' } })
    await expect(getState({ sender: { id: 99 } })).rejects.toThrow(/sender/i)
  })

  it('a dg_session cookie change re-checks the session; other cookies do not', async () => {
    const { wiring, cookieListeners, dg } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()

    const before = dg.meCount()

    cookieListeners.forEach(listener => listener({}, { name: 'theme' }))
    await new Promise(resolve => setImmediate(resolve))
    expect(dg.meCount()).toBe(before)

    cookieListeners.forEach(listener => listener({}, { name: 'dg_session' }))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(dg.meCount()).toBe(before + 1)
  })

  it('a window focus checks the DG session; a lost session clears and notifies', async () => {
    const { wiring, dg } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()
    await wiring.runtime.selectProject('alpha')

    const before = dg.meCount()

    w.fire('focus')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(dg.meCount()).toBe(before + 1)

    dg.setMe({ status: 401 })
    wiring.runtime.scope.checkAccess('heartbeat').catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(
      w.sent.some(s => s.channel === DEGRAM_CHANNELS.event && (s.payload as { type: string }).type === 'session-ended')
    ).toBe(true)
  })

  it('unmounts the view when the window closes and re-mounts it on a new window without a second start', async () => {
    const { wiring, fake, dg } = rig()
    const first = fakeWindow()

    wiring.attachWindow(first.window as never)
    await wiring.started()
    first.fire('closed')

    expect(first.children).toEqual([])
    expect(fake.closed()).toBe(false)

    const second = fakeWindow()

    wiring.attachWindow(second.window as never)

    expect(second.children).toEqual([fake.view])
    expect(fake.loaded).toEqual([`${dg.origin}/?host=degram`])
  })

  it('does not send to a window that is gone', async () => {
    const { wiring } = rig()
    const w = fakeWindow()

    wiring.attachWindow(w.window as never)
    await wiring.started()
    w.fire('closed')
    w.sent.length = 0

    wiring.runtime.dgView.getState()
    wiring.runtime.setDgMode('full').catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))

    expect(w.sent).toEqual([])
  })
})

// ─── 1303-35 Task 2: the human-intent broker through the actual composition ──────────────────────────
//
// main-wiring -> runtime -> registerDegramIpc -> broker, with injected seams only: the DG partition fetch (the member
// lane with cookie/CSRF/role rules), the native/agent lane (the connector's dialog and protected operations behind the
// REAL gateway-rpc) and the window. Every assertion about "no native write" counts writes the fake connector performed.

const SESSION_ID = 'ms-000000000001'

describe('1303-35 human-intent broker: actual main-wiring composition', () => {
  function intentRig(options: { role?: string; timeoutMs?: number } = {}) {
    const dg = createFakeDg()
    const server = createFakeMappingServer({ origin: dg.origin, project: 'alpha', sessionId: SESSION_ID, base: dg.fetch })
    const agent = createFakeAgent(server)
    const environmentId = environmentIdForOrigin(dg.origin)
    const stamp = { environmentId, generation: 3 }
    const rpc = createGatewayRpc({ WebSocketImpl: createFakeGatewaySocket(agent), timeoutMs: options.timeoutMs ?? 40 })
    const handlers = new Map<string, Handler>()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const state = { current: true }

    dg.setMe(dg.signedInMe('alpha', 'ACME', options.role ?? 'editor'))

    // The backend handle main builds: the generation stamp rides on every delegated call (main.ts, createDeps).
    const handle: BackendHandle = {
      call: async () => ({ ok: true }),
      callSlow: (method, params) =>
        rpc('ws://127.0.0.1/api/ws?token=session', method, { ...(params as object), _degram_environment: stamp })
    }

    const wiring = createDegramMainWiring({
      origin: dg.origin,
      environmentId,
      generation: 3,
      isCurrent: () => state.current,
      fetch: server.fetch,
      clock: createFakeClock(),
      logger,
      createView: createFakeViewFactory().factory,
      openExternal: vi.fn(),
      profiles: {
        ensure: async () => ({ profile: 'p' }),
        purge: async () => undefined,
        purgeProject: async () => [],
        migrateLegacy: async () => undefined,
        cleanupLegacy: async () => ({ ran: false, failed: [] })
      },
      backend: { ensure: async () => handle, release: async () => undefined },
      ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
      cookieSession: { cookies: { on: () => undefined } }
    })

    const w = fakeWindow()

    return { dg, server, agent, stamp, wiring, handlers, w, state, logger }
  }

  async function ready(r: ReturnType<typeof intentRig>) {
    r.wiring.attachWindow(r.w.window as never)
    await r.wiring.started()
    expect(await r.wiring.runtime.selectProject('alpha')).toMatchObject({ ok: true })

    const scope = r.wiring.runtime.getState().scope
    const payload = (over: Record<string, unknown> = {}) => ({
      environment: r.stamp,
      project: 'alpha',
      scopeEpoch: scope.epoch,
      sessionId: SESSION_ID,
      requestId: 'req-0001',
      action: 'approve',
      items: [tupleOf(1)],
      ...over
    })
    const call = (channel: string, body: unknown, sender: unknown = r.w.webContents) =>
      r.handlers.get(channel)!({ sender }, body)

    return { payload, call, epoch: scope.epoch }
  }

  const mappingRequests = (r: ReturnType<typeof intentRig>) => r.server.requests.length

  const noLeak = (value: unknown): void => {
    const text = JSON.stringify(value)

    for (const secret of [PROOF_SECRET, LEAKED_TOKEN, LEAKED_COOKIE, TOKEN_A, TOKEN_B, 'dg_session']) {
      expect(text).not.toContain(secret)
    }
  }

  it('serves a protected approve end to end: IPC, runtime, member challenge, native dialog, server receipt, operation', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)
    const result = (await call(DEGRAM_CHANNELS.mappingIntent, payload())) as { ok: boolean; intents: unknown[]; session: unknown }

    expect(result).toMatchObject({ ok: true, requestId: 'req-0001', action: 'approve' })
    expect(r.agent.methods()).toEqual(['degram.mapping.advanced.confirmIntent', 'degram.mapping.advanced.answer'])
    expect(r.agent.calls[0].params._degram_environment).toEqual(r.stamp)
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
    expect(r.server.challenges()[0].headers['X-DG-CSRF']).toBe('1')
    // the preload-safe shape: structured-cloneable, no credential anywhere the renderer can look
    expect(structuredClone(result)).toEqual(result)
    noLeak(result)
    noLeak(r.w.sent)
  })

  it('refuses a wrong sender and a forged payload before any request or native step', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)
    const before = mappingRequests(r)

    await expect(Promise.resolve(call(DEGRAM_CHANNELS.mappingIntent, payload(), { id: 99 }))).rejects.toThrow(/sender/i)
    await expect(Promise.resolve(call(DEGRAM_CHANNELS.mappingIntentStatus, payload(), { id: 99 }))).rejects.toThrow(/sender/i)

    for (const forged of [
      payload({ confirmed: true }),
      payload({ byAgent: false, source: 'desktop' }),
      payload({ intentId: 'hi-000000000000000000000001' }),
      payload({ scope: tupleOf(1) }),
      payload({ url: 'http://127.0.0.1:1/', method: 'POST', body: '{}' }),
      payload({ token: LEAKED_TOKEN }),
      payload({ action: 'confirmIntent' })
    ]) {
      await expect(Promise.resolve(call(DEGRAM_CHANNELS.mappingIntent, forged))).rejects.toThrow(/invalid mapping intent/i)
    }

    expect(mappingRequests(r)).toBe(before)
    expect(r.agent.calls).toEqual([])
    expect(r.agent.state.nativeWrites).toBe(0)
  })

  it('missing editor role or a lost sign-in: nothing is requested and nothing is written', async () => {
    const viewer = intentRig({ role: 'viewer' })
    const a = await ready(viewer)

    expect(await a.call(DEGRAM_CHANNELS.mappingIntent, a.payload())).toMatchObject({ ok: false, code: 'NOT_EDITOR' })
    expect(viewer.server.requests).toEqual([])
    expect(viewer.agent.calls).toEqual([])

    const signedOut = intentRig()
    const b = await ready(signedOut)

    signedOut.dg.setMe({ status: 401 })
    await signedOut.wiring.runtime.session.refresh()
    expect(await b.call(DEGRAM_CHANNELS.mappingIntent, b.payload({ requestId: 'req-0002' }))).toMatchObject({
      ok: false,
      code: 'NOT_SIGNED_IN'
    })
    expect(signedOut.server.requests).toEqual([])
    expect(signedOut.agent.state.nativeWrites).toBe(0)
  })

  it('a server that refuses the CSRF/cookie lane creates no challenge: no dialog, no write', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)

    r.server.flags.refuseChallenge = { status: 403, code: 'CSRF_REQUIRED' }

    const result = await call(DEGRAM_CHANNELS.mappingIntent, payload())

    expect(result).toMatchObject({ ok: false, code: 'CHALLENGE_REFUSED', serverCode: 'CSRF_REQUIRED' })
    expect(r.agent.state.dialogs).toBe(0)
    expect(r.agent.state.nativeWrites).toBe(0)
    noLeak(result)
  })

  it('a cancelled native dialog creates no proof and no write; a duplicate request replays, never a second dialog', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)

    r.agent.state.dialog = 'cancel'

    const first = await call(DEGRAM_CHANNELS.mappingIntent, payload())
    const duplicate = await call(DEGRAM_CHANNELS.mappingIntent, payload())

    expect(first).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(duplicate).toMatchObject({ ok: false, code: 'CANCELLED', replayed: true })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(0)
    expect(r.agent.methods()).toEqual(['degram.mapping.advanced.confirmIntent'])
  })

  it('two clicks at once share one dialog; a different request meanwhile is busy', async () => {
    const r = intentRig({ timeoutMs: 5000 })
    const { payload, call } = await ready(r)
    let release: () => void = () => undefined

    r.agent.state.gate = new Promise<void>(resolve => {
      release = resolve
    })

    const first = call(DEGRAM_CHANNELS.mappingIntent, payload()) as Promise<unknown>
    const second = call(DEGRAM_CHANNELS.mappingIntent, payload()) as Promise<unknown>

    await vi.waitFor(() => expect(r.agent.state.dialogs).toBe(1))
    expect(await call(DEGRAM_CHANNELS.mappingIntent, payload({ requestId: 'req-0009' }))).toMatchObject({
      ok: false,
      code: 'BUSY'
    })
    release()
    await Promise.all([first, second])

    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
  })

  it('timeout after the native confirm is settled by the server receipt; a hung operation is never called twice', async () => {
    const r = intentRig()
    const { payload, call, epoch } = await ready(r)

    r.agent.state.dialog = 'confirm-then-timeout'
    expect(await call(DEGRAM_CHANNELS.mappingIntent, payload())).toMatchObject({ ok: true })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)

    r.server.addDefinition(2)
    r.agent.state.hang.add('degram.mapping.advanced.preview')
    r.agent.state.dialog = 'confirm'

    const preview = payload({ requestId: 'req-prev-01', action: 'preview', items: [tupleOf(2)] })

    expect(await call(DEGRAM_CHANNELS.mappingIntent, preview)).toMatchObject({ ok: false, code: 'UNRESOLVED', unresolved: true })

    const previews = (): number => r.agent.methods().filter(m => m === 'degram.mapping.advanced.preview').length
    const once = previews()

    expect(await call(DEGRAM_CHANNELS.mappingIntent, preview)).toMatchObject({ ok: false, code: 'UNRESOLVED' })
    expect(previews()).toBe(once)
    expect(
      await call(DEGRAM_CHANNELS.mappingIntentStatus, {
        environment: r.stamp,
        project: 'alpha',
        scopeEpoch: epoch,
        sessionId: SESSION_ID,
        requestId: 'req-prev-01'
      })
    ).toMatchObject({ ok: true, intents: [{ status: 'confirmed' }] })
  })

  it('a generation switch during the confirmation drops the request: the operation is never called', async () => {
    const r = intentRig({ timeoutMs: 5000 })
    const { payload, call } = await ready(r)
    let release: () => void = () => undefined

    r.agent.state.gate = new Promise<void>(resolve => {
      release = resolve
    })

    const pending = call(DEGRAM_CHANNELS.mappingIntent, payload()) as Promise<unknown>

    await vi.waitFor(() => expect(r.agent.state.dialogs).toBe(1))
    // the environment coordinator replaced this runtime while the person was looking at the dialog
    r.state.current = false
    release()

    expect(await pending).toMatchObject({ ok: false, code: 'STALE_ENVIRONMENT' })
    expect(r.agent.methods()).toEqual(['degram.mapping.advanced.confirmIntent'])
    expect(r.agent.state.nativeWrites).toBe(0)
  })

  it('a request stamped with another environment generation or scope epoch is refused without a request', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)
    const before = mappingRequests(r)

    expect(await call(DEGRAM_CHANNELS.mappingIntent, payload({ environment: { ...r.stamp, generation: 2 } }))).toMatchObject({
      ok: false,
      code: 'STALE_ENVIRONMENT'
    })
    expect(await call(DEGRAM_CHANNELS.mappingIntent, payload({ requestId: 'req-0003', scopeEpoch: 99 }))).toMatchObject({
      ok: false,
      code: 'STALE_ENVIRONMENT'
    })
    expect(mappingRequests(r)).toBe(before)
    expect(r.agent.calls).toEqual([])
  })

  it('bulk approve through the composition is atomic on a stale tuple', async () => {
    const r = intentRig()
    const { payload, call } = await ready(r)

    r.server.addDefinition(2)

    const stale = payload({ requestId: 'req-bulk-01', items: [tupleOf(1), { ...tupleOf(2), resultHash: resultHash(99) }] })

    expect(await call(DEGRAM_CHANNELS.mappingIntent, stale)).toMatchObject({
      ok: false,
      code: 'STALE_TUPLE',
      stale: [definitionId(2)],
      completed: []
    })
    expect(r.server.challenges()).toEqual([])
    expect(r.agent.calls).toEqual([])

    const fresh = payload({ requestId: 'req-bulk-02', items: [tupleOf(1), tupleOf(2)] })

    expect(await call(DEGRAM_CHANNELS.mappingIntent, fresh)).toMatchObject({ ok: true })
    expect(r.agent.state.dialogs).toBe(1)
    expect(r.agent.state.nativeWrites).toBe(1)
  })
})

describe('1303-35 human-intent broker: environment coordinator A to B to A', () => {
  function environmentIntentRig(timeoutMs = 40) {
    const targets = configuredDgTargets({})
    const handlers = new Map<string, Handler>()
    const resources: {
      dg: ReturnType<typeof createFakeDg>
      server: ReturnType<typeof createFakeMappingServer>
      agent: ReturnType<typeof createFakeAgent>
      generation: number
    }[] = []

    const wiring = createDegramEnvironmentWiring({
      targets,
      selected: targets.developer,
      persist: vi.fn(),
      ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
      createDeps: descriptor => {
        const dg = createFakeDg({ origin: descriptor.origin })
        const server = createFakeMappingServer({ origin: dg.origin, project: 'alpha', sessionId: SESSION_ID, base: dg.fetch })
        const agent = createFakeAgent(server)
        const rpc = createGatewayRpc({ WebSocketImpl: createFakeGatewaySocket(agent), timeoutMs })
        const stamp = { environmentId: descriptor.environmentId, generation: descriptor.generation }

        dg.setMe(dg.signedInMe('alpha', 'ACME', 'editor'))
        resources.push({ dg, server, agent, generation: descriptor.generation })

        return {
          origin: descriptor.origin,
          environmentId: descriptor.environmentId,
          fetch: server.fetch,
          clock: createFakeClock(),
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          createView: createFakeViewFactory().factory,
          openExternal: vi.fn(),
          profiles: {
            ensure: async () => ({ profile: 'p' }),
            purge: async () => undefined,
            purgeProject: async () => [],
            migrateLegacy: async () => undefined,
            cleanupLegacy: async () => ({ ran: false, failed: [] })
          },
          backend: {
            ensure: async () => ({
              call: async () => ({ ok: true }),
              callSlow: (method: string, params: unknown) =>
                rpc('ws://x/api/ws', method, { ...(params as object), _degram_environment: stamp })
            }),
            release: async () => undefined
          },
          cookieSession: { cookies: { on: () => undefined, removeListener: () => undefined } }
        }
      }
    })

    const w = fakeWindow()
    const stampNow = () => {
      const state = wiring.controller.getState()

      return { environmentId: state.selected.environmentId, generation: state.generation }
    }
    const call = (channel: string, body?: unknown) => handlers.get(channel)!({ sender: w.webContents }, body)

    return { wiring, w, resources, stampNow, call }
  }

  it('a protected action holds the environment (a switch is busy); after it, an A-stamped request is refused by B and by A again', async () => {
    const r = environmentIntentRig(5000)

    r.wiring.attachWindow(r.w.window)
    await r.wiring.started()
    await r.call(DEGRAM_CHANNELS.selectProject, 'alpha')

    const epochOf = async () => ((await r.call(DEGRAM_CHANNELS.getState)) as { scope: { epoch: number } }).scope.epoch
    const stampA = r.stampNow()
    const request = async (stamp: unknown, requestId: string) => ({
      environment: stamp,
      project: 'alpha',
      scopeEpoch: await epochOf(),
      sessionId: SESSION_ID,
      requestId,
      action: 'approve',
      items: [tupleOf(1)]
    })
    const first = r.resources[0]
    let release: () => void = () => undefined

    first.agent.state.gate = new Promise<void>(resolve => {
      release = resolve
    })

    const running = r.call(DEGRAM_CHANNELS.mappingIntent, await request(stampA, 'req-env-001')) as Promise<unknown>

    await vi.waitFor(() => expect(first.agent.state.dialogs).toBe(1))
    // the operation lease keeps the environment: a switch while the person decides is refused
    expect(await r.call(DEGRAM_CHANNELS.selectTarget, { ...stampA, mode: 'demo' })).toMatchObject({ ok: false, code: 'BUSY' })
    release()
    expect(await running).toMatchObject({ ok: true })
    expect(first.agent.state.nativeWrites).toBe(1)

    // switch A -> B: a delayed A-stamped request meets runtime B, which refuses it without a single request
    await r.call(DEGRAM_CHANNELS.selectTarget, { ...stampA, mode: 'demo' })
    await r.call(DEGRAM_CHANNELS.selectProject, 'alpha')

    const second = r.resources[1]

    expect(await r.call(DEGRAM_CHANNELS.mappingIntent, await request(stampA, 'req-env-002'))).toMatchObject({
      ok: false,
      code: 'STALE_ENVIRONMENT'
    })
    expect(second.server.requests.filter(x => x.path.includes('/mapping/'))).toEqual([])
    expect(second.agent.calls).toEqual([])
    expect(first.agent.state.nativeWrites).toBe(1)

    // B -> A: the new A runtime has a newer generation, the first A stamp is stale for good
    await r.call(DEGRAM_CHANNELS.selectTarget, { ...r.stampNow(), mode: 'developer' })
    await r.call(DEGRAM_CHANNELS.selectProject, 'alpha')

    const third = r.resources[2]

    expect(await r.call(DEGRAM_CHANNELS.mappingIntent, await request(stampA, 'req-env-003'))).toMatchObject({
      ok: false,
      code: 'STALE_ENVIRONMENT'
    })
    expect(third.agent.calls).toEqual([])
    expect(third.agent.state.nativeWrites).toBe(0)

    // and the current stamp works against the current environment's own lanes only
    expect(await r.call(DEGRAM_CHANNELS.mappingIntent, await request(r.stampNow(), 'req-env-004'))).toMatchObject({ ok: true })
    expect(third.agent.state.nativeWrites).toBe(1)
    expect(second.agent.state.nativeWrites).toBe(0)
  })
})
