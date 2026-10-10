import { describe, expect, it, vi } from 'vitest'

import { createDgSession, createNetPartitionFetch, type NetLike, type PartitionRequest } from './dg-session'
import { createFakeClock, createFakeDg, createFakePairing, PAIRING_TOKEN, TOKEN_A } from './test-support'

function build() {
  const dg = createFakeDg()
  const clock = createFakeClock()

  const logger = {
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>()
  }

  const session = createDgSession({ origin: dg.origin, fetch: dg.fetch, clock, logger })

  return { dg, clock, logger, session }
}

describe('createDgSession: signed-in detection (GET /data-service/auth/me through the partition)', () => {
  it('200 with memberships means signed in', async () => {
    const { dg, session } = build()
    dg.setMe(dg.signedInMe('alpha', 'ACME', 'editor'))

    const me = await session.refresh()

    expect(me).toEqual({
      kind: 'signed-in',
      username: 'alice',
      isAdmin: false,
      memberships: [{ project: 'alpha', role: 'editor', company: 'ACME' }]
    })
    expect(session.state().kind).toBe('signed-in')
    expect(dg.requests[0]).toMatchObject({ method: 'GET', url: `${dg.origin}/data-service/auth/me` })
  })

  it('401 means signed out and clears the remembered memberships', async () => {
    const { dg, session } = build()
    dg.setMe(dg.signedInMe('alpha'))
    await session.refresh()
    dg.setMe({ status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } })

    expect(await session.refresh()).toEqual({ kind: 'signed-out', status: 401 })
    expect(session.state()).toMatchObject({ kind: 'signed-out', username: null, memberships: [] })
  })

  it('a network failure is unreachable and does not forget a known sign-in', async () => {
    const { dg, session } = build()
    dg.setMe(dg.signedInMe('alpha'))
    await session.refresh()
    dg.setMe('network-error')

    expect(await session.refresh()).toEqual({ kind: 'unreachable' })
    expect(session.state()).toMatchObject({ kind: 'unreachable', username: 'alice' })
    expect(session.state().memberships).toHaveLength(1)
  })

  it('a malformed 200 body is treated as signed out, never as signed in', async () => {
    const { dg, session } = build()
    dg.setMe({ status: 200, body: { nope: true } })

    expect((await session.refresh()).kind).toBe('signed-out')
  })

  it('coalesces a refresh requested while one is in flight', async () => {
    const { dg, session } = build()
    dg.setMe(dg.signedInMe('alpha'))

    const [a, b] = await Promise.all([session.refresh(), session.refresh()])

    expect(a).toEqual(b)
    expect(dg.meCount()).toBe(1)
  })
})

describe('createDgSession: delegated token mint', () => {
  it('POSTs {project} with X-DG-CSRF: 1 and returns the token and its expiry', async () => {
    const { dg, session } = build()

    const minted = await session.mint('alpha')

    expect(minted).toMatchObject({ kind: 'ok', token: TOKEN_A, project: 'alpha', company: 'ACME' })
    expect(minted.kind === 'ok' && minted.expiresAt).toBe('2030-01-01T00:15:00Z')

    const request = dg.requests.find((r: PartitionRequest) => r.method === 'POST')!

    expect(request.url).toBe(`${dg.origin}/data-service/auth/delegated-token`)
    expect(request.headers).toMatchObject({ 'X-DG-CSRF': '1', 'Content-Type': 'application/json' })
    expect(JSON.parse(request.body!)).toEqual({ project: 'alpha' })
    // The mint rides the partition cookie only: no Authorization header is ever attached.
    expect(Object.keys(request.headers ?? {}).map(k => k.toLowerCase())).not.toContain('authorization')
  })

  it('maps 401 to signed-out, 403 to forbidden with the server code, and a network failure to unreachable', async () => {
    const { dg, session } = build()

    dg.setMint({ status: 401, body: { detail: { code: 'AUTH_REQUIRED' } } })
    expect(await session.mint('alpha')).toEqual({ kind: 'signed-out', status: 401 })

    dg.setMint({ status: 403, body: { detail: { code: 'PROJECT_FORBIDDEN' } } })
    expect(await session.mint('alpha')).toEqual({ kind: 'forbidden', status: 403, code: 'PROJECT_FORBIDDEN' })

    dg.setMint({ status: 403, body: { code: 'DELEGATED_SCOPE_CHANGED' } })
    expect(await session.mint('alpha')).toEqual({ kind: 'forbidden', status: 403, code: 'DELEGATED_SCOPE_CHANGED' })

    dg.setMint('network-error')
    expect(await session.mint('alpha')).toEqual({ kind: 'unreachable' })
  })

  it('rejects a mint reply without a usable token', async () => {
    const { dg, session } = build()
    dg.setMint({ status: 201, body: { token: 'not-a-delegated-token', project: 'alpha', expiresAt: 'x' } })

    expect((await session.mint('alpha')).kind).toBe('error')
  })

  it('never logs or exposes the token', async () => {
    const { dg, logger, session } = build()
    dg.setMe(dg.signedInMe('alpha'))
    await session.refresh()
    await session.mint('alpha')

    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])

    expect(logged).not.toContain(TOKEN_A)
    expect(JSON.stringify(session.state())).not.toContain(TOKEN_A)
  })
})

describe('createDgSession: logout', () => {
  it('POSTs /auth/logout with the CSRF header and ends in signed-out even when the server is unreachable', async () => {
    const { dg, session } = build()
    dg.setMe(dg.signedInMe('alpha'))
    await session.refresh()
    dg.setLogout('network-error')

    await session.logout()

    const request = dg.requests.find((r: PartitionRequest) => r.url.endsWith('/auth/logout'))!

    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({ 'X-DG-CSRF': '1' })
    expect(session.state()).toMatchObject({ kind: 'signed-out', username: null, memberships: [] })
  })
})

describe('createNetPartitionFetch (Electron net adapter)', () => {
  function fakeNet(reply: { status: number; body: string } | 'error') {
    const seen: { options: Record<string, unknown>; headers: Record<string, string>; written: string[] } = {
      options: {},
      headers: {},
      written: []
    }

    const net: NetLike = {
      request: options => {
        seen.options = options

        const handlers = new Map<string, (...args: any[]) => void>()

        return {
          setHeader: (name, value) => {
            seen.headers[name] = value
          },
          write: chunk => {
            seen.written.push(chunk)
          },
          abort: () => undefined,
          on: (event, listener) => {
            handlers.set(event, listener)

            return undefined
          },
          end: () => {
            queueMicrotask(() => {
              if (reply === 'error') {
                handlers.get('error')?.(new Error('boom'))

                return
              }

              const responseHandlers = new Map<string, (...args: any[]) => void>()

              handlers.get('response')?.({
                statusCode: reply.status,
                on: (event: string, listener: (...args: any[]) => void) => {
                  responseHandlers.set(event, listener)
                }
              })
              responseHandlers.get('data')?.(Buffer.from(reply.body))
              responseHandlers.get('end')?.()
            })
          }
        }
      }
    }

    return { net, seen }
  }

  it('session mode binds the partition, uses the session cookie jar, never follows a redirect and sends the body', async () => {
    const { net, seen } = fakeNet({ status: 201, body: '{"ok":true}' })
    const jar = { cookies: { get: async () => [] } }
    const doFetch = createNetPartitionFetch({ net, session: jar })

    const res = await doFetch({
      method: 'POST',
      url: 'http://dg.test/data-service/auth/delegated-token',
      headers: { 'X-DG-CSRF': '1' },
      body: '{"project":"a"}'
    })

    expect(res).toEqual({ status: 201, body: '{"ok":true}' })
    expect(seen.options).toMatchObject({
      method: 'POST',
      partition: 'persist:degram-dg',
      session: jar,
      redirect: 'error',
      useSessionCookies: true,
      credentials: 'include'
    })
    expect(seen.headers['X-DG-CSRF']).toBe('1')
    expect(seen.written).toEqual(['{"project":"a"}'])
    expect(seen.headers.Cookie).toBeUndefined()
  })

  it('explicit mode (SameSite=Strict fallback) reads dg_session from the jar and sets the Cookie header itself', async () => {
    const { net, seen } = fakeNet({ status: 200, body: '{}' })
    const get = vi.fn(async () => [{ name: 'dg_session', value: 'abc123' }])
    const doFetch = createNetPartitionFetch({ net, session: { cookies: { get } }, cookieMode: 'explicit' })

    await doFetch({ method: 'GET', url: 'http://dg.test/data-service/auth/me' })

    expect(get).toHaveBeenCalledWith({ url: 'http://dg.test/data-service/auth/me', name: 'dg_session' })
    expect(seen.headers.Cookie).toBe('dg_session=abc123')
    expect(seen.options).toMatchObject({ useSessionCookies: false, credentials: 'omit' })
  })

  it('a transport error rejects (HTTP statuses never do)', async () => {
    const { net } = fakeNet('error')
    const doFetch = createNetPartitionFetch({ net, session: { cookies: { get: async () => [] } } })

    await expect(doFetch({ method: 'GET', url: 'http://dg.test/x' })).rejects.toThrow('boom')
  })
})

describe('createDgSession: pairing exchange (Phase 1301-17, D-25, D-27)', () => {
  function paired(token: string | null = PAIRING_TOKEN) {
    const dg = createFakeDg()
    const clock = createFakeClock()
    const pairing = createFakePairing(token)

    const logger = {
      info: vi.fn<(...args: unknown[]) => void>(),
      warn: vi.fn<(...args: unknown[]) => void>(),
      error: vi.fn<(...args: unknown[]) => void>()
    }

    const session = createDgSession({ origin: dg.origin, fetch: dg.fetch, clock, logger, pairing })
    dg.setMe(dg.signedInMe('alpha'))

    return { dg, pairing, logger, session }
  }

  it('with a stored pairing, mint exchanges it with a Bearer header and no cookie mint', async () => {
    const { dg, session } = paired()
    await session.refresh()

    const minted = await session.mint('alpha')

    expect(minted).toMatchObject({ kind: 'ok', project: 'alpha', company: 'ACME', source: 'pairing' })
    expect(dg.mintCount()).toBe(0)
    expect(dg.exchangeCount()).toBe(1)

    const request = dg.requests.find(r => r.url.endsWith('/auth/degram/exchange'))

    expect(request).toMatchObject({ method: 'POST', url: `${dg.origin}/data-service/auth/degram/exchange` })
    expect(request?.headers?.Authorization).toBe(`Bearer ${PAIRING_TOKEN}`)
    expect(request?.headers?.['X-DG-CSRF']).toBeUndefined()
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ project: 'alpha' })
    expect(session.pairing()).toEqual({ status: 'connected', company: 'ACME' })
  })

  it('without a pairing the D-05 cookie mint applies unchanged', async () => {
    const { dg, session } = paired(null)
    await session.refresh()

    const minted = await session.mint('alpha')

    expect(minted).toMatchObject({ kind: 'ok', source: 'session' })
    expect(dg.exchangeCount()).toBe(0)
    expect(dg.mintCount()).toBe(1)
    expect(session.pairing().status).toBe('none')
  })

  it('a 401 PAIRING_AUTH_FAILED clears the store and reports the revoked state; no cookie fallback', async () => {
    const { dg, pairing, session } = paired()
    await session.refresh()
    dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })
    const seen: string[] = []
    session.onPairing(p => seen.push(p.status))

    expect(await session.mint('alpha')).toEqual({ kind: 'pairing-revoked' })
    expect(pairing.get()).toBeNull()
    expect(pairing.cleared()).toBe(1)
    expect(dg.mintCount()).toBe(0)
    expect(session.pairing().status).toBe('revoked')
    expect(seen).toEqual(['revoked'])
  })

  it('a pairing of another user than the signed-in one is refused and kept for the user to replace', async () => {
    const { dg, pairing, session } = paired()
    await session.refresh()
    dg.setExchange(request => ({
      status: 201,
      body: {
        token: 'dgd_OTHER-USER',
        project: JSON.parse(request.body ?? '{}').project,
        company: 'ACME',
        expiresAt: '2030-01-01T00:15:00Z',
        expiresInSeconds: 900,
        username: 'bob'
      }
    }))

    expect(await session.mint('alpha')).toEqual({ kind: 'error', status: 201, code: 'PAIRING_USER_MISMATCH' })
    expect(session.pairing().status).toBe('mismatch')
    expect(pairing.get()).toBe(PAIRING_TOKEN)
  })

  it('a 403 is forbidden (membership), a network failure unreachable, a 5xx unreachable', async () => {
    const { dg, session } = paired()
    await session.refresh()

    dg.setExchange({ status: 403, body: { detail: { code: 'PROJECT_FORBIDDEN' } } })
    expect(await session.mint('alpha')).toEqual({ kind: 'forbidden', status: 403, code: 'PROJECT_FORBIDDEN' })

    dg.setExchange('network-error')
    expect(await session.mint('alpha')).toEqual({ kind: 'unreachable' })

    dg.setExchange({ status: 503 })
    expect(await session.mint('alpha')).toEqual({ kind: 'unreachable' })
    expect(session.pairing().status).toBe('stored')
  })

  it('probes a stored pairing once, discards its delegated token, and does not open a scope', async () => {
    const { dg, pairing, session } = paired()
    await session.refresh()

    await session.probePairing()

    expect(session.pairing().status).toBe('connected')
    expect(dg.exchangeCount()).toBe(1)
    const discard = dg.requests.find(q => q.method === 'DELETE' && q.url.endsWith('/auth/delegated-token'))
    expect(discard?.headers?.Authorization).toMatch(/^Bearer dgd_/)
    expect(pairing.get()).toBe(PAIRING_TOKEN)
  })

  it('clears a pairing refused by the start probe and leaves network failures stored', async () => {
    const { dg, pairing, session } = paired()
    await session.refresh()
    dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })
    await session.probePairing()
    expect(pairing.get()).toBeNull()
    expect(session.pairing().status).toBe('revoked')
  })

  it('notePairingChanged reflects a newly stored or cleared pairing', () => {
    const { pairing, session } = paired(null)

    expect(session.pairing().status).toBe('none')
    pairing.set(PAIRING_TOKEN)
    session.notePairingChanged()
    expect(session.pairing().status).toBe('stored')
    pairing.clear()
    session.notePairingChanged()
    expect(session.pairing()).toEqual({ status: 'none', company: null })
  })

  it('never logs the pairing token or the exchanged token', async () => {
    const { dg, logger, session } = paired()
    await session.refresh()
    await session.mint('alpha')
    dg.setExchange({ status: 500 })
    await session.mint('alpha')
    dg.setExchange({ status: 401, body: { detail: { code: 'PAIRING_AUTH_FAILED' } } })
    await session.mint('alpha')

    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])

    expect(logged).not.toContain('dgp_')
    expect(logged).not.toContain('dgd_')
  })
})
