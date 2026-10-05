import fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDgSession } from './dg-session'
import { type BackendHandle, createScopeController, type DegramEvent, type ScopeKey } from './scope'
import { createFakeClock, createFakeDg, createLog, TOKEN_A, TOKEN_B } from './test-support'

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
  session: ReturnType<typeof createDgSession>
  scope: ReturnType<typeof createScopeController>
  rpcFail: Map<string, Error>
  backendGate: { promise: Promise<void> | null }
}

function profileFor(scope: ScopeKey): string {
  return `scope-${scope.user}-${scope.company ?? 'none'}-${scope.project}`
}

function rig(memberships: { project: string; company?: string | null; role?: string }[] = [{ project: 'alpha' }]): Rig {
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

  const session = createDgSession({ origin: dg.origin, fetch: dg.fetch, clock, logger })

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
    session,
    rpcFail,
    backendGate
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
        log.push('view.reset')
        out.viewResets += 1
      },
      clearStorage: async () => {
        log.push('view.clearStorage')
        out.storageClears += 1
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
