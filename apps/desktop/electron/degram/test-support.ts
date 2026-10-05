// test-support.ts — injected fakes shared by the electron/degram vitest suites (Phase 1301-12).
//
// Nothing here touches Electron, the network, the filesystem or real timers: every dependency of
// dg-session / scope / dg-view is a plain function so the suites run in the `electron` vitest project.

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
