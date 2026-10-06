import fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDgSession, DEGRAM_HEARTBEAT_S, DEGRAM_TOKEN_RENEW_S } from './dg-session'
import { type BackendHandle, createScopeController, type DegramEvent, type ScopeKey } from './scope'
import {
  createFakeClock,
  createFakeDg,
  createFakePairing,
  createLog,
  PAIRING_TOKEN,
  TOKEN_A,
  TOKEN_B
} from './test-support'

afterEach(() => {
  vi.restoreAllMocks()
})

type LogFn = ReturnType<typeof vi.fn<(...args: unknown[]) => void>>

interface Rig {
  dg: ReturnType<typeof createFakeDg>
  clock: ReturnType<typeof createFakeClock>
  log: ReturnType<typeof createLog>
  events: DegramEvent[]
  logger: { info: LogFn; warn: LogFn; error: LogFn }
  rpcCalls: { profile: string; method: string; params: Record<string, unknown> }[]
  purged: ScopeKey[]
  ensured: ScopeKey[]
  released: string[]
  viewResets: number
  storageClears: number
  storageOptions: unknown[]
  session: ReturnType<typeof createDgSession>
  scope: ReturnType<typeof createScopeController>
  rpcFail: Map<string, Error>
  backendGate: { promise: Promise<void> | null }
  /** `hook` runs at the start of every view reset (observe state mid-clearing). */
  viewGate: { hook: (() => void) | null }
  purgeFail: { error: Error | null }
}

function profileFor(scope: ScopeKey): string {
  return `scope-${scope.user}-${scope.company ?? 'none'}-${scope.project}`
}

function rig(
  memberships: { project: string; company?: string | null; role?: string }[] = [{ project: 'alpha' }],
  pairing?: ReturnType<typeof createFakePairing>
): Rig {
  const dg = createFakeDg()
  const clock = createFakeClock()
  const log = createLog()

  const logger = {
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>()
  }

  const events: DegramEvent[] = []
  const rpcCalls: Rig['rpcCalls'] = []
  const purged: ScopeKey[] = []
  const ensured: ScopeKey[] = []
  const released: string[] = []
  const rpcFail = new Map<string, Error>()
  const backendGate: Rig['backendGate'] = { promise: null }
  const viewGate: Rig['viewGate'] = { hook: null }
  const purgeFail: Rig['purgeFail'] = { error: null }

  dg.setMe({
    status: 200,
    body: {
      username: 'alice',
      isAdmin: false,
      memberships: memberships.map(m => ({
        project: m.project,
        role: m.role ?? 'viewer',
        company: 'company' in m ? m.company : 'ACME'
      }))
    }
  })

  const session = createDgSession({ origin: dg.origin, fetch: dg.fetch, clock, logger, pairing })

  const out = {
    dg,
    clock,
    log,
    events,
    logger,
    rpcCalls,
    purged,
    ensured,
    released,
    viewResets: 0,
    storageClears: 0,
    storageOptions: [] as unknown[],
    session,
    rpcFail,
    backendGate,
    viewGate,
    purgeFail
  } as unknown as Rig

  out.scope = createScopeController({
    session,
    origin: dg.origin,
    clock,
    logger,
    emit: event => {
      log.push(`event:${event.type}`)
      events.push(event)
    },
    profiles: {
      ensure: async scope => {
        log.push(`profiles.ensure:${scope.project}`)
        ensured.push(scope)

        return { profile: profileFor(scope) }
      },
      purge: async scope => {
        if (purgeFail.error) {
          throw purgeFail.error
        }

        log.push(`profiles.purge:${scope.project}`)
        purged.push(scope)
      }
    },
    backend: {
      ensure: async (profile: string): Promise<BackendHandle> => {
        log.push(`backend.ensure:${profile}`)

        if (backendGate.promise) {
          await backendGate.promise
        }

        return {
          call: async (method, params) => {
            log.push(`rpc:${profile}:${method}`)
            rpcCalls.push({ profile, method, params: params as Record<string, unknown> })

            const failure = rpcFail.get(method)

            if (failure) {
              throw failure
            }

            return { status: 'ok' }
          }
        }
      },
      release: async profile => {
        log.push(`backend.release:${profile}`)
        released.push(profile)
      }
    },
    view: {
      reset: async () => {
        viewGate.hook?.()
        log.push('view.reset')
        out.viewResets += 1
      },
      clearStorage: async options => {
        log.push('view.clearStorage')
        out.storageClears += 1
        out.storageOptions.push(options)
      }
    }
  })

  return out
}

describe('createScopeController: explicit project selection (D-19)', () => {
  it('never selects a project implicitly, even with a single membership', async () => {
    const r = rig([{ project: 'alpha' }])
    await r.session.refresh()

    expect(r.scope.getState()).toMatchObject({ status: 'no-project', project: null, profile: null })
    expect(r.ensured).toHaveLength(0)
    expect(r.dg.mintCount()).toBe(0)
    expect(r.rpcCalls).toHaveLength(0)
  })

  it('rejects a project that is not in the memberships and touches nothing', async () => {
    const r = rig([{ project: 'alpha' }])

    const result = await r.scope.selectProject('beta')

    expect(result).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(r.ensured).toHaveLength(0)
    expect(r.dg.mintCount()).toBe(0)
    expect(r.rpcCalls).toHaveLength(0)
  })

  it('refuses to open any scope while signed out', async () => {
    const r = rig()
    r.dg.setMe({ status: 401, body: {} })

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'NOT_SIGNED_IN' })
    expect(r.ensured).toHaveLength(0)
    expect(r.dg.mintCount()).toBe(0)
  })

  it('opens the profile, starts the backend, mints, and hands the token over BEFORE reporting ready', async () => {
    const r = rig([{ project: 'alpha', company: 'ACME' }])

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: true })
    expect(r.ensured).toEqual([{ user: 'alice', company: 'ACME', project: 'alpha' }])

    const profile = 'scope-alice-ACME-alpha'

    expect(r.log.entries.filter(e => !e.startsWith('event:'))).toEqual([
      'profiles.ensure:alpha',
      `backend.ensure:${profile}`,
      `rpc:${profile}:degram.credentials.set`
    ])
    expect(r.rpcCalls[0].params).toEqual({
      token: TOKEN_A,
      expiresAt: '2030-01-01T00:15:00Z',
      relayBaseUrl: `${r.dg.origin}/data-service`,
      user: 'alice',
      company: 'ACME',
      project: 'alpha'
    })
    expect(r.scope.getState()).toMatchObject({
      status: 'ready',
      project: 'alpha',
      company: 'ACME',
      profile,
      epoch: 1
    })
  })

  it('sends a null company for a project without one', async () => {
    const r = rig([{ project: 'alpha', company: null }])

    await r.scope.selectProject('alpha')

    expect(r.ensured[0].company).toBeNull()
    expect(r.rpcCalls[0].params.company).toBeNull()
  })

  it('keeps the token out of emitted state, logger calls and every filesystem write', async () => {
    const writes = [
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'appendFileSync'),
      vi.spyOn(fs.promises, 'writeFile'),
      vi.spyOn(fs.promises, 'appendFile')
    ]

    const r = rig()
    const seen: unknown[] = []

    r.scope.onState(state => seen.push(state))
    await r.scope.selectProject('alpha')

    const everything = JSON.stringify([
      seen,
      r.scope.getState(),
      r.events,
      r.logger.info.mock.calls,
      r.logger.warn.mock.calls,
      r.logger.error.mock.calls
    ])

    expect(everything).not.toContain(TOKEN_A)
    expect(everything).not.toContain('dgd_')
    expect(seen.length).toBeGreaterThan(0)

    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})

describe('createScopeController: scope switch fully resets context', () => {
  it('clears the old scope credentials, opens a different profile and bumps the epoch', async () => {
    const r = rig([
      { project: 'alpha', company: 'ACME' },
      { project: 'beta', company: 'GLOBEX' }
    ])

    await r.scope.selectProject('alpha')
    r.log.entries.length = 0

    const result = await r.scope.selectProject('beta')

    expect(result).toMatchObject({ ok: true })

    const order = r.log.entries.filter(e => !e.startsWith('event:'))

    expect(order.indexOf('rpc:scope-alice-ACME-alpha:degram.credentials.clear')).toBe(0)
    expect(order.indexOf('profiles.ensure:beta')).toBeGreaterThan(0)
    expect(order).toContain('rpc:scope-alice-GLOBEX-beta:degram.credentials.set')
    expect(r.scope.getState()).toMatchObject({
      status: 'ready',
      project: 'beta',
      company: 'GLOBEX',
      profile: 'scope-alice-GLOBEX-beta',
      epoch: 2
    })
    // Two different scopes never share a profile, and no backend of the other scope is addressed for beta.
    expect(r.rpcCalls.filter(c => c.method === 'degram.credentials.set').map(c => c.profile)).toEqual([
      'scope-alice-ACME-alpha',
      'scope-alice-GLOBEX-beta'
    ])
    expect(r.rpcCalls.find(c => c.profile === 'scope-alice-GLOBEX-beta')!.params.token).toBe(TOKEN_B)
  })

  it('re-selecting the same project reopens it (fresh epoch) rather than reusing silently', async () => {
    const r = rig()

    await r.scope.selectProject('alpha')
    await r.scope.selectProject('alpha')

    expect(r.scope.getState().epoch).toBe(2)
    expect(r.dg.mintCount()).toBe(2)
  })

  it('a selection superseded while the backend starts never receives a credential', async () => {
    const r = rig([
      { project: 'alpha', company: 'ACME' },
      { project: 'beta', company: 'GLOBEX' }
    ])

    let release!: () => void

    r.backendGate.promise = new Promise<void>(resolve => {
      release = resolve
    })

    const first = r.scope.selectProject('alpha')

    await new Promise<void>(resolve => setImmediate(resolve))
    r.backendGate.promise = null

    const second = await r.scope.selectProject('beta')

    release()

    const firstResult = await first

    expect(second).toMatchObject({ ok: true })
    expect(firstResult).toMatchObject({ ok: false, code: 'SUPERSEDED' })
    expect(r.rpcCalls.some(c => c.profile === 'scope-alice-ACME-alpha' && c.method === 'degram.credentials.set')).toBe(
      false
    )
    expect(r.scope.getState()).toMatchObject({ status: 'ready', project: 'beta' })
  })
})

describe('createScopeController: failures before the credential exists', () => {
  it('reports DG_UNREACHABLE when the mint cannot reach DG and sets no credential', async () => {
    const r = rig()
    r.dg.setMint('network-error')

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'DG_UNREACHABLE' })
    expect(r.rpcCalls.some(c => c.method === 'degram.credentials.set')).toBe(false)
    expect(r.scope.getState()).toMatchObject({ status: 'error', error: 'DG_UNREACHABLE' })
  })

  it('reports the profile failure and starts no backend', async () => {
    const r = rig()

    const ensure = vi.fn(async () => {
      throw new Error('python exploded')
    })

    const broken = createScopeController({
      session: r.session,
      origin: r.dg.origin,
      clock: r.clock,
      logger: r.logger,
      emit: () => undefined,
      profiles: { ensure, purge: async () => undefined },
      backend: { ensure: vi.fn(), release: vi.fn() },
      view: { reset: async () => undefined, clearStorage: async () => undefined }
    })

    expect(await broken.selectProject('alpha')).toMatchObject({ ok: false, code: 'PROFILE_FAILED' })
  })

  it('reports CREDENTIALS_REJECTED when the agent refuses the handoff and keeps the token out of the error', async () => {
    const r = rig()
    r.rpcFail.set('degram.credentials.set', Object.assign(new Error('CREDENTIALS_INVALID'), { code: -32602 }))

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'CREDENTIALS_REJECTED' })
    expect(JSON.stringify(result)).not.toContain(TOKEN_A)
    expect(r.scope.getState().status).toBe('error')
  })
})

// ─── Task 3: renewal, heartbeat, focus and revocation clearing (D-08, D-19) ─────────────────────────

const RENEW_MS = DEGRAM_TOKEN_RENEW_S * 1000
const HEARTBEAT_MS = DEGRAM_HEARTBEAT_S * 1000
const CLEAR_ALPHA = 'rpc:scope-alice-ACME-alpha:degram.credentials.clear'

async function openAlpha(r: Rig): Promise<void> {
  const result = await r.scope.selectProject('alpha')

  expect(result.ok).toBe(true)
  r.log.entries.length = 0
  r.events.length = 0
  r.rpcCalls.length = 0
  r.dg.requests.length = 0
}

const meRequests = (r: Rig): number => r.dg.requests.filter(req => req.url.endsWith('/auth/me')).length
const mintRequests = (r: Rig): number => r.dg.requests.filter(req => req.url.endsWith('/auth/delegated-token')).length

function expectOrdered(r: Rig, entries: string[]): void {
  const order = entries.map(entry => r.log.indexOf(entry))

  expect(order.every(index => index >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
}

function freshMint(): () => { status: number; body: unknown } {
  return () => ({
    status: 201,
    body: {
      token: TOKEN_B,
      project: 'alpha',
      company: 'ACME',
      expiresAt: '2030-01-01T00:15:00Z',
      expiresInSeconds: 900
    }
  })
}

describe('token renewal', () => {
  it('re-mints every 600 s while a scope is open and hands each new token to the agent', async () => {
    const r = rig()

    await openAlpha(r)
    await r.clock.advance(RENEW_MS)

    expect(mintRequests(r)).toBe(1)
    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set'])
    expect(r.rpcCalls[0]!.params.token).toBe(TOKEN_B)

    await r.clock.advance(RENEW_MS)
    expect(mintRequests(r)).toBe(2)
  })

  it('does not mint anything while no scope is open', async () => {
    const r = rig()

    await r.session.refresh()
    await r.clock.advance(RENEW_MS * 2)

    expect(r.dg.mintCount()).toBe(0)
  })

  it('stops renewing a scope once a switch closed it and renews only the new one', async () => {
    const r = rig([{ project: 'alpha' }, { project: 'beta' }])

    await openAlpha(r)
    await r.scope.selectProject('beta')
    r.rpcCalls.length = 0
    r.dg.requests.length = 0

    await r.clock.advance(RENEW_MS)

    const mints = r.dg.requests.filter(req => req.url.endsWith('/auth/delegated-token'))

    expect(mints).toHaveLength(1)
    expect(JSON.parse(mints[0]!.body ?? '{}')).toEqual({ project: 'beta' })
  })

  it('a 401 from minting ends the session: clear credential, scope and view, then tell the renderer', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMint({ status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } })
    r.dg.setMe({ status: 401 })

    await r.clock.advance(RENEW_MS)

    expectOrdered(r, [CLEAR_ALPHA, 'view.reset', 'view.clearStorage', 'event:session-ended'])
    expect(r.scope.getState()).toMatchObject({ status: 'no-project', project: null, profile: null })
    expect(r.events).toEqual([{ type: 'session-ended' }])
  })

  it('an unreachable DG on renewal keeps the credential and retries on the next heartbeat tick only', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMint('network-error')

    await r.clock.advance(RENEW_MS)
    expect(mintRequests(r)).toBe(1)
    expect(r.rpcCalls.map(c => c.method)).not.toContain('degram.credentials.clear')
    expect(r.scope.getState().status).toBe('ready')

    r.dg.requests.length = 0
    await r.clock.advance(HEARTBEAT_MS)

    // one heartbeat and exactly one renewal retry: no burst
    expect(meRequests(r)).toBe(1)
    expect(mintRequests(r)).toBe(1)
  })

  it('a renewal pending after an outage succeeds on the first healthy heartbeat tick', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMint('network-error')
    await r.clock.advance(RENEW_MS)

    r.dg.setMint(freshMint())
    r.rpcCalls.length = 0

    await r.clock.advance(HEARTBEAT_MS)

    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set'])
  })
})

describe('heartbeat and focus check', () => {
  it('calls GET /auth/me every 60 s while signed in', async () => {
    const r = rig()

    await openAlpha(r)
    await r.clock.advance(HEARTBEAT_MS * 3)

    expect(meRequests(r)).toBe(3)
  })

  it('does not heartbeat while signed out', async () => {
    const r = rig()

    r.dg.setMe({ status: 401 })
    await r.session.refresh()
    r.dg.requests.length = 0

    await r.clock.advance(HEARTBEAT_MS * 5)

    expect(meRequests(r)).toBe(0)
    expect(r.clock.activeIntervals()).toBe(0)
  })

  it('checks on window focus and coalesces focus bursts within 5 s', async () => {
    const r = rig()

    await openAlpha(r)

    await r.scope.checkAccess('focus')
    expect(meRequests(r)).toBe(1)

    await r.scope.checkAccess('focus')
    await r.scope.checkAccess('focus')
    expect(meRequests(r)).toBe(1)

    await r.clock.advance(5_000)
    await r.scope.checkAccess('focus')
    expect(meRequests(r)).toBe(2)
  })

  it('a 401 on the heartbeat clears credential, scope and view before session-ended and stops every timer', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMe({ status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } })

    await r.clock.advance(HEARTBEAT_MS)

    expectOrdered(r, [CLEAR_ALPHA, 'view.reset', 'view.clearStorage', 'event:session-ended'])
    expect(r.purged).toEqual([])
    expect(r.scope.getState().status).toBe('no-project')
    expect(r.clock.activeIntervals()).toBe(0)
    expect(r.events.filter(e => e.type === 'session-ended')).toHaveLength(1)
  })

  it('never reports session-ended when it was signed out all along', async () => {
    const r = rig()

    r.dg.setMe({ status: 401 })
    await r.scope.checkAccess('focus')
    await r.scope.checkAccess('heartbeat')

    expect(r.events).toEqual([])
  })

  it('a lost session is not settled between the 401 and the end of the clearing', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMe({ status: 401 })

    const settledAtReset: boolean[] = []

    r.viewGate.hook = () => settledAtReset.push(r.scope.isSettled())

    expect(r.scope.isSettled()).toBe(true)
    await r.scope.checkAccess('heartbeat')

    expect(settledAtReset).toEqual([false])
    expect(r.scope.isSettled()).toBe(true)
  })

  it('a network failure marks DG unreachable without clearing anything, once, and recovery is announced', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMe('network-error')

    await r.clock.advance(HEARTBEAT_MS)
    await r.clock.advance(HEARTBEAT_MS)

    expect(r.events).toEqual([{ type: 'dg-unreachable' }])
    expect(r.rpcCalls.map(c => c.method)).not.toContain('degram.credentials.clear')
    expect(r.viewResets).toBe(0)
    expect(r.scope.getState().status).toBe('ready')
    // exactly one attempt per tick, no retry burst
    expect(meRequests(r)).toBe(2)

    r.dg.setMe(r.dg.signedInMe('alpha'))
    await r.clock.advance(HEARTBEAT_MS)

    expect(r.events).toEqual([{ type: 'dg-unreachable' }, { type: 'dg-reachable' }])
  })
})

describe('access revoked for the active project (403 / membership loss)', () => {
  it('purges only that scope: credential clear, backend release, profile purge, view reset, then access-revoked', async () => {
    const r = rig([{ project: 'alpha' }, { project: 'beta' }])

    await openAlpha(r)
    r.dg.setMe(r.dg.signedInMe('beta'))

    await r.clock.advance(HEARTBEAT_MS)

    expectOrdered(r, [
      CLEAR_ALPHA,
      'backend.release:scope-alice-ACME-alpha',
      'profiles.purge:alpha',
      'view.reset',
      'event:access-revoked'
    ])
    expect(r.purged).toEqual([{ user: 'alice', company: 'ACME', project: 'alpha' }])
    expect(r.events).toEqual([{ type: 'access-revoked', project: 'alpha', purged: true }])
    expect(r.scope.getState()).toMatchObject({ status: 'no-project', project: null })
    // tenant storage of the view is wiped, the DG sign-in cookie and the session are kept
    expect(r.storageOptions).toEqual([{ keepCookies: true }])
    expect(r.session.state().kind).toBe('signed-in')
    // heartbeat keeps running, renewal stopped
    expect(r.clock.activeIntervals()).toBe(1)
  })

  it('a 403 DELEGATED_SCOPE_CHANGED from the renewal mint purges the scope', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMint({ status: 403, body: { detail: { code: 'DELEGATED_SCOPE_CHANGED' } } })

    await r.clock.advance(RENEW_MS)

    expect(r.purged).toHaveLength(1)
    expect(r.events).toEqual([{ type: 'access-revoked', project: 'alpha', purged: true }])
  })

  it('a changed company for the project is a scope change and purges the old scope', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMe({
      status: 200,
      body: { username: 'alice', isAdmin: false, memberships: [{ project: 'alpha', role: 'viewer', company: 'OTHER' }] }
    })

    await r.clock.advance(HEARTBEAT_MS)

    expect(r.purged).toEqual([{ user: 'alice', company: 'ACME', project: 'alpha' }])
  })

  it('reports purged:false when the profile purge fails but still clears credential, scope and view', async () => {
    const r = rig([{ project: 'alpha' }, { project: 'beta' }])

    await openAlpha(r)
    r.purgeFail.error = new Error('profile directory is locked')
    r.dg.setMe(r.dg.signedInMe('beta'))

    await r.clock.advance(HEARTBEAT_MS)

    expect(r.events).toEqual([{ type: 'access-revoked', project: 'alpha', purged: false }])
    expect(r.rpcCalls.map(c => c.method)).toContain('degram.credentials.clear')
    expect(r.scope.getState().status).toBe('no-project')
  })

  it('a revoke during an in-flight selection supersedes it, so no credential reaches the agent', async () => {
    const r = rig([{ project: 'alpha' }, { project: 'beta' }])
    let release!: () => void

    r.backendGate.promise = new Promise<void>(resolve => {
      release = resolve
    })

    const selecting = r.scope.selectProject('alpha')

    await new Promise(resolve => setImmediate(resolve))
    r.dg.setMe(r.dg.signedInMe('beta'))

    await r.scope.checkAccess('heartbeat')
    release()

    expect(await selecting).toMatchObject({ ok: false, code: 'SUPERSEDED' })
    expect(r.rpcCalls.map(c => c.method)).not.toContain('degram.credentials.set')
  })
})

describe('forwarded agent outcomes', () => {
  it('DELEGATED_SESSION_ENDED ends the session', async () => {
    const r = rig()

    await openAlpha(r)

    expect(await r.scope.reportOutcome('DELEGATED_SESSION_ENDED')).toBe(true)
    expect(r.events).toEqual([{ type: 'session-ended' }])
    expect(r.scope.getState().status).toBe('no-project')
  })

  it('CREDENTIALS_EXPIRED ends the session only when DG confirms 401', async () => {
    const r = rig()

    await openAlpha(r)
    r.dg.setMe({ status: 401 })
    await r.scope.reportOutcome('CREDENTIALS_EXPIRED')

    expect(r.events).toEqual([{ type: 'session-ended' }])
  })

  it('CREDENTIALS_EXPIRED on a healthy session re-mints instead of signing the user out', async () => {
    const r = rig()

    await openAlpha(r)
    await r.scope.reportOutcome('CREDENTIALS_EXPIRED')

    expect(r.events).toEqual([])
    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set'])
    expect(r.scope.getState().status).toBe('ready')
  })

  it.each(['DELEGATED_SCOPE_CHANGED', 'ACCESS_DENIED'])('%s revokes the active scope', async code => {
    const r = rig()

    await openAlpha(r)

    expect(await r.scope.reportOutcome(code)).toBe(true)
    expect(r.events).toEqual([{ type: 'access-revoked', project: 'alpha', purged: true }])
  })

  it('ignores a code it does not know', async () => {
    const r = rig()

    await openAlpha(r)

    expect(await r.scope.reportOutcome('SOMETHING_ELSE')).toBe(false)
    expect(r.events).toEqual([])
    expect(r.scope.getState().status).toBe('ready')
  })

  it('an outcome with no open scope changes nothing', async () => {
    const r = rig()

    await r.session.refresh()

    expect(await r.scope.reportOutcome('DELEGATED_SCOPE_CHANGED')).toBe(true)
    expect(r.events).toEqual([])
    expect(r.purged).toEqual([])
  })
})

describe('dispose', () => {
  it('stops every timer', async () => {
    const r = rig()

    await openAlpha(r)
    expect(r.clock.activeIntervals()).toBe(2)

    r.scope.dispose()

    expect(r.clock.activeIntervals()).toBe(0)
  })
})

describe('DeGram pairing as the credential source (Phase 1301-17, D-25, D-27)', () => {
  const exchanges = (r: Rig): number => r.dg.requests.filter(q => q.url.endsWith('/auth/degram/exchange')).length

  it('a stored pairing mints through the exchange and the agent gets the same credential shape', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))

    const result = await r.scope.selectProject('alpha')

    expect(result.ok).toBe(true)
    expect(r.dg.exchangeCount()).toBe(1)
    expect(r.dg.mintCount()).toBe(0)
    expect(r.rpcCalls[0]).toMatchObject({
      method: 'degram.credentials.set',
      params: { user: 'alice', company: 'ACME', project: 'alpha' }
    })
    expect(String(r.rpcCalls[0]!.params.token)).toMatch(/^dgd_PAIRED-/)
  })

  it('renewal keeps using the pairing every 600 s', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))

    await openAlpha(r)
    await r.clock.advance(RENEW_MS)

    expect(exchanges(r)).toBe(1)
    expect(r.dg.mintCount()).toBe(0)
  })

  it('a revoked pairing at selection reports PAIRING_REVOKED, purges nothing and keeps the DG sign-in', async () => {
    const pairing = createFakePairing(PAIRING_TOKEN)
    const r = rig(undefined, pairing)
    r.dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'PAIRING_REVOKED' })
    expect(r.events).toEqual([{ type: 'pairing-revoked' }])
    expect(r.purged).toEqual([])
    expect(r.session.state().kind).toBe('signed-in')
    expect(r.rpcCalls.filter(c => c.method === 'degram.credentials.set')).toEqual([])
    expect(pairing.get()).toBeNull()
  })

  it('a pairing revoked while the scope is open closes the scope on the next renewal, without a purge or sign-out', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))

    await openAlpha(r)
    r.dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })
    await r.clock.advance(RENEW_MS)

    expect(r.log.entries).toContain(CLEAR_ALPHA)
    expect(r.scope.getState()).toMatchObject({ status: 'no-project', project: null })
    expect(r.events).toEqual([{ type: 'pairing-revoked' }])
    expect(r.purged).toEqual([])
    expect(r.storageClears).toBe(0)
    expect(r.session.state().kind).toBe('signed-in')
  })

  it('DELEGATED_SESSION_ENDED from a pairing credential checks the pairing instead of signing the user out', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))

    await openAlpha(r)
    r.dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })

    expect(await r.scope.reportOutcome('DELEGATED_SESSION_ENDED')).toBe(true)
    expect(r.events).toEqual([{ type: 'pairing-revoked' }])
    expect(r.scope.getState().status).toBe('no-project')
    expect(r.session.state().kind).toBe('signed-in')
  })

  it('DELEGATED_SESSION_ENDED from a pairing credential that is still live re-mints and keeps the scope', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))

    await openAlpha(r)

    expect(await r.scope.reportOutcome('DELEGATED_SESSION_ENDED')).toBe(true)
    expect(r.events).toEqual([])
    expect(r.scope.getState().status).toBe('ready')
    expect(r.rpcCalls.map(c => c.method)).toEqual(['degram.credentials.set'])
  })

  it('a pairing of another DG user never reaches the agent', async () => {
    const r = rig(undefined, createFakePairing(PAIRING_TOKEN))
    r.dg.setExchange(request => ({
      status: 201,
      body: {
        token: 'dgd_BOB',
        project: JSON.parse(request.body ?? '{}').project,
        company: 'ACME',
        expiresAt: '2030-01-01T00:15:00Z',
        expiresInSeconds: 900,
        username: 'bob'
      }
    }))

    const result = await r.scope.selectProject('alpha')

    expect(result).toMatchObject({ ok: false, code: 'MINT_FAILED' })
    expect(r.rpcCalls.filter(c => c.method === 'degram.credentials.set')).toEqual([])
  })
})
