// backend-churn.test.ts — G-25 (Phase 1301-35): switching DeGram projects must not restart the backend it just left.
//
// Observed (0.1.9 desktop.log, 2026-10-11): «Hermes backend for profile "X" exited (1)» followed within ms by
// «Starting Hermes backend for profile "X"» for the LEFT scope, filling the 3-slot pool. The requester is the
// renderer's own registry: a switch makes main release the left scope's backend, which closes the socket of the
// left scope's secondary (still wantOpen), and its reconnect ladder then dials `getConnection(left)` again; main's
// ensureBackend honours any profile and respawns it. This suite drives the REAL renderer registry (store/gateway.ts,
// fake WebSocket) against the REAL main-side scope gate (electron/degram/scope-gate.ts) with a fake pool, and records
// every ensure the renderer sends and every backend that starts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import {
  closeSecondaryGateways,
  configureGatewayRegistry,
  openGatewayForProfile,
  parkSecondariesForRetiredBackend,
  retireLocalProfileGateways,
  setPrimaryGateway
} from '@/store/gateway'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

import { createScopeBackendGate } from '../../electron/degram/scope-gate'

import { followScopeRoute } from './scope-route'
import { makeState } from './test-harness'

vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))

// The renderer's own registry is real; the spy only records that the route retired the left scope.
vi.mock(import('@/store/gateway'), async importOriginal => {
  const actual = await importOriginal()

  return { ...actual, retireLocalProfileGateways: vi.fn(actual.retireLocalProfileGateways) }
})

// The profile store's activation is the registry's own; the rest of the store is real.
vi.mock(import('@/store/profile'), async importOriginal => {
  const actual = await importOriginal()
  const gateway = await import('@/store/gateway')

  return {
    ...actual,
    ensureGatewayProfile: vi.fn(async (name: null | string | undefined) => {
      await gateway.ensureGatewayForProfile(String(name))
      actual.$activeGatewayProfile.set(actual.normalizeProfileKey(name))
    }),
    invalidateProfileListFetches: vi.fn(),
    pinNewChatProfile: vi.fn((name: string) => name)
  }
})

const hex = (n: number): string => `scope-${n.toString(16).padStart(16, '0')}`

const A = hex(0xa)
const B = hex(0xb)
const C = hex(0xc)

const sockets: NetworkSocket[] = []

class NetworkSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = NetworkSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    sockets.push(this)
    setTimeout(() => {
      if (this.readyState !== NetworkSocket.CONNECTING) {
        return
      }

      this.readyState = NetworkSocket.OPEN
      this.dispatchEvent(new Event('open'))
    }, 1)
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id: number }

    setTimeout(() => {
      if (this.readyState === NetworkSocket.OPEN) {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) })
        )
      }
    }, 1)
  }

  close(): void {
    if (this.readyState < NetworkSocket.CLOSING) {
      this.readyState = NetworkSocket.CLOSING
      setTimeout(() => this.finish(1000), 1)
    }
  }

  /** The backend died under the socket: an abnormal close, as a killed child produces. */
  drop(): void {
    setTimeout(() => this.finish(1006), 1)
  }

  private finish(code: number): void {
    if (this.readyState !== NetworkSocket.CLOSED) {
      this.readyState = NetworkSocket.CLOSED
      this.dispatchEvent(new CloseEvent('close', { code, wasClean: code === 1000 }))
    }
  }
}

const urlOf = (profile: string): string => `ws://backend.invalid/${profile}`

/** The main process side: a pool of running backends, the scope gate, and the renderer's `getConnection` door. */
function fakeMain() {
  const running = new Set<string>()
  const ensures: Array<{ profile: string; accepted: boolean }> = []
  const starts: string[] = []
  const log: string[] = []
  let primary: HermesGateway

  const gate = createScopeBackendGate({
    log: message => log.push(message),
    // What main's `hermes:pool:retiring` broadcast does in the renderer (use-gateway-boot).
    broadcastRetiring: key => void parkSecondariesForRetiredBackend(key),
    poolKeys: profile => [profile, `conn:local::${profile}`]
  })

  const start = (profile: string): void => {
    if (!running.has(profile)) {
      running.add(profile)
      starts.push(profile)
    }
  }

  const dial = async (profile: string) => {
    try {
      gate.assertCanStart(profile)
    } catch (error) {
      ensures.push({ profile, accepted: false })
      throw error
    }

    ensures.push({ profile, accepted: true })
    start(profile)

    return { baseUrl: 'http://backend.invalid', mode: 'local' as const, profile, token: 't', wsUrl: urlOf(profile) }
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection: vi.fn(async (profile: string) => dial(profile)),
    touchBackend: vi.fn(async () => undefined)
  }

  return {
    gate,
    running,
    ensures,
    starts,
    log,
    setPrimary: (gateway: HermesGateway) => {
      primary = gateway
    },
    primary: () => primary,
    /** The scope controller's own start of a scope's backend (scope.ts `backend.ensure`). */
    ownerEnsure: async (profile: string) => {
      gate.allow(profile)
      start(profile)
    },
    /** The scope controller's release of the scope it leaves (scope.ts `backend.release`). */
    release: async (profile: string) =>
      gate.release(profile, async () => {
        running.delete(profile)

        for (const socket of sockets.filter(s => s.url === urlOf(profile))) {
          socket.drop()
        }
      })
  }
}

let main: ReturnType<typeof fakeMain>
let primary: HermesGateway

beforeEach(async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('WebSocket', NetworkSocket)
  sockets.length = 0
  main = fakeMain()
  configureGatewayRegistry({ activeConnectionId: () => 'local', foregroundScopes: () => new Set(), onEvent: vi.fn() })
  primary = new HermesGateway()
  const connected = primary.connect('ws://primary.invalid/api/ws')

  await vi.advanceTimersByTimeAsync(1)
  await connected
  setPrimaryGateway(primary, 'default')
  $activeGatewayProfile.set('default')
  vi.mocked(retireLocalProfileGateways).mockClear()
})

afterEach(() => {
  closeSecondaryGateways()
  primary.close()
  setPrimaryGateway(null)
  $activeGatewayProfile.set('default')
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const settle = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(1)
}

/** Await a registry call while the fake clock runs (sockets open on a timer). */
async function run<T>(work: Promise<T>): Promise<T> {
  let settled = false
  let value: T | undefined
  let failure: unknown

  work.then(
    result => {
      settled = true
      value = result
    },
    error => {
      settled = true
      failure = error
    }
  )

  for (let tick = 0; tick < 200 && !settled; tick += 1) {
    await vi.advanceTimersByTimeAsync(5)
    await vi.dynamicImportSettled()
  }

  if (!settled) {
    throw new Error('the registry call never settled')
  }

  if (failure !== undefined) {
    throw failure
  }

  return value as T
}

/** One project switch as the scope controller runs it: release the left scope, mint (slow), start the new one, then the renderer follows. */
async function switchTo(from: string | null, to: string): Promise<{ afterRelease: number }> {
  if (from) {
    await main.release(from)
  }

  const afterRelease = main.ensures.length

  // Minting a credential and preparing the profile take seconds: this is the window the left backend was respawned in.
  await settle(3_000)
  await main.ownerEnsure(to)

  // The renderer's reaction to the new ready scope (shell host): move the route, which activates the new profile.
  const ready = makeState({
    scope: { status: 'ready', project: to, company: null, profile: to, epoch: 1, error: null }
  })

  await run(followScopeRoute(ready, { fresh: true }))
  await settle(30_000)

  return { afterRelease }
}

const ensuresFor = (profile: string, from: number) => main.ensures.slice(from).filter(call => call.profile === profile)

describe('G-25: a project switch does not restart the scope it left', () => {
  it('A -> B -> C -> A: each left profile gets no ensure after its release, each backend starts once per selection', async () => {
    await switchTo(null, A)
    expect(main.running).toEqual(new Set([A]))

    const toB = await switchTo(A, B)

    expect(ensuresFor(A, toB.afterRelease)).toEqual([])
    expect(main.running).toEqual(new Set([B]))

    const toC = await switchTo(B, C)

    expect(ensuresFor(B, toC.afterRelease)).toEqual([])
    expect(main.running).toEqual(new Set([C]))

    const toA = await switchTo(C, A)

    expect(ensuresFor(C, toA.afterRelease)).toEqual([])
    expect(main.running).toEqual(new Set([A]))

    // Exactly one start per selection: nothing was started for a scope that was not the active one.
    expect(main.starts).toEqual([A, B, C, A])
  })

  it('the route retires the left scope in the renderer registry once the new scope is active, and only a scope profile', async () => {
    await switchTo(null, A)
    // The route came from the stock default profile: not a DeGram scope, never retired.
    expect(retireLocalProfileGateways).not.toHaveBeenCalled()

    await switchTo(A, B)
    expect(retireLocalProfileGateways).toHaveBeenCalledTimes(1)
    expect(retireLocalProfileGateways).toHaveBeenCalledWith(A)

    // Following the same scope again (the route reconcile) retires nothing.
    const ready = makeState({ scope: { status: 'ready', project: B, company: null, profile: B, epoch: 1, error: null } })

    await run(followScopeRoute(ready, { fresh: false }))
    expect(retireLocalProfileGateways).toHaveBeenCalledTimes(1)
    expect(normalizeProfileKey($activeGatewayProfile.get())).toBe(B)
  })

  it('the active scope keeps its backend through the whole sequence (never below one running, never another one)', async () => {
    await switchTo(null, A)
    await switchTo(A, B)

    expect(main.running.has(B)).toBe(true)
    expect(main.running.has(A)).toBe(false)
    expect(main.starts.filter(profile => profile === A)).toHaveLength(1)
  })

  it('main refuses a renderer request for a scope profile that is not the active scope, and the renderer stops asking', async () => {
    await switchTo(null, A)
    await switchTo(A, B)
    const before = main.ensures.length

    // A stale surface (a session list or roster read of the left project) dials A on a user-style foreground request.
    await expect(run(openGatewayForProfile(A, { spawnPriority: 'foreground' }))).rejects.toThrow(/no longer exists/)
    await settle(60_000)

    const refused = ensuresFor(A, before)

    expect(main.running.has(A)).toBe(false)
    expect(main.starts).toEqual([A, B])
    // The request's own probe and dial are both refused; nothing was accepted.
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every(call => !call.accepted)).toBe(true)

    // The registry fail-stops the entry on «no longer exists»: no retry ladder follows, however long it waits.
    await settle(10 * 60_000)
    expect(ensuresFor(A, before)).toHaveLength(refused.length)
    // The refusal is logged once, without the profile name.
    expect(main.log).toHaveLength(1)
    expect(main.log[0]).not.toContain(A)
  })

  it('refuses a scope profile before any scope is open (a boot-restored route of the previous run)', async () => {
    await expect(run(openGatewayForProfile(A, { spawnPriority: 'foreground' }))).rejects.toThrow(/no longer exists/)
    expect(main.starts).toEqual([])
  })

  it('does not touch profiles that are not DeGram scope profiles', async () => {
    await switchTo(null, A)
    await run(openGatewayForProfile('default-ish', { spawnPriority: 'foreground' }))

    expect(main.starts).toEqual([A, 'default-ish'])
  })
})
