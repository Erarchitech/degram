// @vitest-environment node
import { expect, it, vi } from 'vitest'

import { DEGRAM_CHANNELS } from './ipc'

// The preload bridge is the renderer's whole view of DeGram main. This suite pins what it exposes: a typed
// `degram` namespace, one invoke per request channel, one subscription per push channel, and no way at all
// to read a credential (T-1301-12-03).

const host = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>()

  return {
    handlers,
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    send: vi.fn(),
    sendSync: vi.fn((_channel: string): unknown => ({})),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      handlers.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: host.exposeInMainWorld },
  ipcRenderer: {
    invoke: host.invoke,
    send: host.send,
    sendSync: host.sendSync,
    on: host.on,
    removeListener: host.removeListener
  },
  webFrame: {},
  webUtils: {}
}))

async function degramBridge(): Promise<Record<string, any>> {
  await import('../preload')

  const registration = host.exposeInMainWorld.mock.calls.find(([name]): boolean => name === 'hermesDesktop')

  expect(registration).toBeDefined()

  const bridge = registration![1] as { degram?: Record<string, any> }

  expect(bridge.degram).toBeDefined()

  return bridge.degram!
}

it('exposes a typed degram namespace with exactly the capability bridge and no token or credential getter', async () => {
  const degram = await degramBridge()

  expect(Object.keys(degram).sort()).toEqual(
    [
      'getState',
      'onState',
      'onEvent',
      'selectProject',
      'signOut',
      'setDgMode',
      'reloadDg',
      'retryDg',
      'setDgBounds',
      'setTrayLabels',
      'onRequestSignOut',
      'reportOutcome',
      'openExternalConfirmed',
      'setPairing',
      'clearPairing'
    ].sort()
  )

  for (const key of Object.keys(degram)) {
    expect(key).not.toMatch(/token|credential|secret|cookie|password/i)
  }
})

it('maps every method to its degram: channel and passes the argument through', async () => {
  const degram = await degramBridge()

  host.invoke.mockClear()

  await degram.getState()
  await degram.selectProject('alpha')
  await degram.signOut()
  await degram.setDgMode('full')
  await degram.reloadDg()
  await degram.retryDg()
  await degram.setDgBounds({ x: 1, y: 2, width: 3, height: 4 })
  await degram.setDgBounds(null)
  await degram.setTrayLabels({ signOut: 'Sign out of DG' })
  await degram.reportOutcome('CREDENTIALS_EXPIRED')
  await degram.openExternalConfirmed('https://example.test/')
  await degram.setPairing('dgp_x')
  await degram.clearPairing()

  expect(host.invoke.mock.calls).toEqual([
    [DEGRAM_CHANNELS.getState],
    [DEGRAM_CHANNELS.selectProject, 'alpha'],
    [DEGRAM_CHANNELS.signOut],
    [DEGRAM_CHANNELS.setDgMode, 'full'],
    [DEGRAM_CHANNELS.reloadDg],
    [DEGRAM_CHANNELS.retryDg],
    [DEGRAM_CHANNELS.setDgBounds, { x: 1, y: 2, width: 3, height: 4 }],
    [DEGRAM_CHANNELS.setDgBounds, null],
    [DEGRAM_CHANNELS.setTrayLabels, { signOut: 'Sign out of DG' }],
    [DEGRAM_CHANNELS.reportOutcome, 'CREDENTIALS_EXPIRED'],
    [DEGRAM_CHANNELS.openExternalConfirmed, 'https://example.test/'],
    [DEGRAM_CHANNELS.setPairing, 'dgp_x'],
    [DEGRAM_CHANNELS.clearPairing]
  ])
})

it('subscribes to state and event pushes and returns a working unsubscribe', async () => {
  const degram = await degramBridge()
  const states: unknown[] = []
  const events: unknown[] = []

  const offState = degram.onState((state: unknown) => states.push(state))
  const offEvent = degram.onEvent((event: unknown) => events.push(event))

  host.handlers.get(DEGRAM_CHANNELS.stateChanged)?.({}, { auth: { kind: 'signed-out' } })
  host.handlers.get(DEGRAM_CHANNELS.event)?.({}, { type: 'session-ended' })

  expect(states).toEqual([{ auth: { kind: 'signed-out' } }])
  expect(events).toEqual([{ type: 'session-ended' }])

  offState()
  offEvent()

  expect(host.handlers.has(DEGRAM_CHANNELS.stateChanged)).toBe(false)
  expect(host.handlers.has(DEGRAM_CHANNELS.event)).toBe(false)
})

it('subscribes to the tray sign-out request and returns a working unsubscribe', async () => {
  const degram = await degramBridge()
  const requests: unknown[] = []

  const off = degram.onRequestSignOut(() => requests.push('asked'))

  host.handlers.get(DEGRAM_CHANNELS.requestSignOut)?.({})
  expect(requests).toEqual(['asked'])

  off()
  expect(host.handlers.has(DEGRAM_CHANNELS.requestSignOut)).toBe(false)
})
