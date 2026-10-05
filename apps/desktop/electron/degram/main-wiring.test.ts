// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { DEGRAM_CHANNELS } from './ipc'
import { createDegramMainWiring } from './main-wiring'
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

  const wiring = createDegramMainWiring({
    origin: dg.origin,
    fetch: dg.fetch,
    clock,
    logger,
    createView: viewFactory.factory,
    openExternal: vi.fn(),
    profiles: { ensure: async () => ({ profile: 'p' }), purge: async () => undefined },
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

  return { dg, wiring, handlers, cookieListeners, fake: viewFactory.fake, logger }
}

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
    expect(fake.loaded).toEqual([`${dg.origin}/#degram`])
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
    expect(fake.loaded).toEqual([`${dg.origin}/#degram`])
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
