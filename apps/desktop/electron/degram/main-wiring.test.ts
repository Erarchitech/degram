// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { DEGRAM_CHANNELS } from './ipc'
import { configuredDgTargets, environmentIdForOrigin } from './dg-target-config'
import { createDegramEnvironmentWiring, createDegramMainWiring } from './main-wiring'
import type { BackendHandle } from './scope'
import { createFakeClock, createFakeDg, createFakeViewFactory } from './test-support'

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
