// test-support.ts — injected fakes shared by the electron/degram vitest suites (Phase 1301-12).
//
// Nothing here touches Electron, the network, the filesystem or real timers: every dependency of
// dg-session / scope / dg-view is a plain function so the suites run in the `electron` vitest project.

import { vi } from 'vitest'

import type { PartitionFetch, PartitionRequest, PartitionResponse } from './dg-session'

export const TOKEN_A = 'dgd_TOKEN-A-never-leaks-0123456789abcdef'
export const TOKEN_B = 'dgd_TOKEN-B-never-leaks-fedcba9876543210'

/** Ordered log shared by fakes so a test can assert cross-component ordering. */
export function createLog(): { entries: string[]; push: (entry: string) => void; indexOf: (entry: string) => number } {
  const entries: string[] = []

  return {
    entries,
    push: (entry: string): void => {
      entries.push(entry)
    },
    indexOf: (entry: string): number => entries.indexOf(entry)
  }
}

interface Interval {
  id: number
  everyMs: number
  nextAt: number
  fn: () => void
}

/** A manual clock: intervals fire only when the test advances time. */
export function createFakeClock(start = 1_000_000): {
  now: () => number
  setInterval: (fn: () => void, ms: number) => number
  clearInterval: (handle: number) => void
  advance: (ms: number) => Promise<void>
  activeIntervals: () => number
} {
  let current = start
  let seq = 0
  let intervals: Interval[] = []

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  return {
    now: (): number => current,
    setInterval: (fn: () => void, ms: number): number => {
      seq += 1
      intervals.push({ id: seq, everyMs: ms, nextAt: current + ms, fn })

      return seq
    },
    clearInterval: (handle: number): void => {
      intervals = intervals.filter(interval => interval.id !== handle)
    },
    advance: async (ms: number): Promise<void> => {
      const target = current + ms

      for (;;) {
        const due = intervals.filter(interval => interval.nextAt <= target).sort((a, b) => a.nextAt - b.nextAt)[0]

        if (!due) {
          break
        }

        current = due.nextAt
        due.nextAt += due.everyMs
        due.fn()
        await flush()
      }

      current = target
      await flush()
    },
    activeIntervals: (): number => intervals.length
  }
}

export interface FakeDgOptions {
  /** Origin the fake DG answers for. */
  origin?: string
}

export interface FakeDgResponse {
  status: number
  body?: unknown
}

type Responder = FakeDgResponse | ((request: PartitionRequest) => FakeDgResponse) | 'network-error'

/** A scripted DG server behind a PartitionFetch; every request is recorded. */
export function createFakeDg(options: FakeDgOptions = {}): {
  origin: string
  fetch: PartitionFetch
  requests: PartitionRequest[]
  setMe: (responder: Responder) => void
  setMint: (responder: Responder) => void
  setLogout: (responder: Responder) => void
  mintCount: () => number
  meCount: () => number
  signedInMe: (project: string, company?: string | null, role?: string) => FakeDgResponse
} {
  const origin = options.origin ?? 'http://dg.test:8080'
  const requests: PartitionRequest[] = []
  let mintCalls = 0
  let meCalls = 0
  let tokenSeq = 0

  let me: Responder = { status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } }

  let mint: Responder = (request): FakeDgResponse => {
    tokenSeq += 1

    const project = (JSON.parse(request.body ?? '{}') as { project?: string }).project ?? ''

    return {
      status: 201,
      body: {
        token: tokenSeq === 1 ? TOKEN_A : tokenSeq === 2 ? TOKEN_B : `dgd_TOKEN-${tokenSeq}-never-leaks`,
        project,
        company: 'ACME',
        expiresAt: new Date(Date.UTC(2030, 0, 1, 0, 15, 0)).toISOString().replace('.000Z', 'Z'),
        expiresInSeconds: 900
      }
    }
  }

  let logout: Responder = { status: 204 }

  const respond = (responder: Responder, request: PartitionRequest): PartitionResponse => {
    if (responder === 'network-error') {
      throw new Error('ECONNREFUSED')
    }

    const resolved = typeof responder === 'function' ? responder(request) : responder

    return { status: resolved.status, body: resolved.body === undefined ? '' : JSON.stringify(resolved.body) }
  }

  const fetch: PartitionFetch = async (request): Promise<PartitionResponse> => {
    requests.push(request)

    const url = new URL(request.url)

    if (url.origin !== origin) {
      throw new Error(`unexpected origin ${url.origin}`)
    }

    if (request.method === 'GET' && url.pathname === '/data-service/auth/me') {
      meCalls += 1

      return respond(me, request)
    }

    if (request.method === 'POST' && url.pathname === '/data-service/auth/delegated-token') {
      mintCalls += 1

      return respond(mint, request)
    }

    if (request.method === 'POST' && url.pathname === '/data-service/auth/logout') {
      return respond(logout, request)
    }

    return { status: 404, body: '' }
  }

  return {
    origin,
    fetch,
    requests,
    setMe: (responder): void => {
      me = responder
    },
    setMint: (responder): void => {
      mint = responder
    },
    setLogout: (responder): void => {
      logout = responder
    },
    mintCount: (): number => mintCalls,
    meCount: (): number => meCalls,
    signedInMe: (project, company = 'ACME', role = 'viewer'): FakeDgResponse => ({
      status: 200,
      body: { username: 'alice', isAdmin: false, memberships: [{ project, role, company }] }
    })
  }
}

// ─── Electron WebContentsView fake (dg-view / ipc suites) ───────────────────────────────────────────

type Listener = (...args: any[]) => void

export interface FakeNavigationEvent {
  prevented: boolean
  preventDefault: () => void
}

export function createFakeNavigationEvent(): FakeNavigationEvent {
  const event: FakeNavigationEvent = {
    prevented: false,
    preventDefault: (): void => {
      event.prevented = true
    }
  }

  return event
}

/** A scripted stand-in for Electron's WebContentsView. Nothing is created, loaded or painted. */
export function createFakeWebView(log?: { push: (entry: string) => void }): {
  view: any
  loaded: string[]
  emit: (name: string, ...args: any[]) => void
  windowOpenHandler: () => ((details: { url: string }) => { action: string }) | null
  session: { clearStorageData: any; clearCache: any; setPermissionRequestHandler: any }
  bounds: () => unknown
  visible: () => boolean
  closed: () => boolean
  reloads: () => number
  failNextLoad: () => void
} {
  const listeners = new Map<string, Listener[]>()
  const loaded: string[] = []
  let handler: ((details: { url: string }) => { action: string }) | null = null
  let bounds: unknown = null
  let visible = false
  let closed = false
  let reloads = 0
  let failLoad = false

  const session = {
    clearStorageData: vi.fn(async (): Promise<void> => {
      log?.push('view.clearStorageData')
    }),
    clearCache: vi.fn(async (): Promise<void> => {
      log?.push('view.clearCache')
    }),
    setPermissionRequestHandler: vi.fn()
  }

  const webContents = {
    session,
    loadURL: vi.fn(async (url: string): Promise<void> => {
      loaded.push(url)
      log?.push(`view.load ${url}`)

      if (failLoad) {
        failLoad = false
        throw new Error('ERR_CONNECTION_REFUSED')
      }
    }),
    reload: (): void => {
      reloads += 1
      log?.push('view.reload')
    },
    on: (name: string, listener: Listener): unknown => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])

      return webContents
    },
    setWindowOpenHandler: (next: (details: { url: string }) => { action: string }): void => {
      handler = next
    },
    getURL: (): string => loaded[loaded.length - 1] ?? '',
    isDestroyed: (): boolean => closed,
    close: (): void => {
      closed = true
    }
  }

  const view = {
    webContents,
    setBounds: (next: unknown): void => {
      bounds = next
    },
    setVisible: (next: boolean): void => {
      visible = next
    }
  }

  return {
    view,
    loaded,
    emit: (name: string, ...args: any[]): void => {
      for (const listener of listeners.get(name) ?? []) {
        listener(...args)
      }
    },
    windowOpenHandler: () => handler,
    session,
    bounds: () => bounds,
    visible: () => visible,
    closed: () => closed,
    reloads: () => reloads,
    failNextLoad: (): void => {
      failLoad = true
    }
  }
}

/** The `createView` factory createDgView receives: records the webPreferences it was asked for. */
export function createFakeViewFactory(log?: { push: (entry: string) => void }): {
  fake: ReturnType<typeof createFakeWebView>
  factory: (webPreferences: Record<string, unknown>) => any
  preferences: () => Record<string, unknown> | null
  created: () => number
} {
  const fake = createFakeWebView(log)
  let prefs: Record<string, unknown> | null = null
  let count = 0

  return {
    fake,
    factory: (webPreferences): unknown => {
      prefs = webPreferences
      count += 1

      return fake.view
    },
    preferences: () => prefs,
    created: () => count
  }
}
