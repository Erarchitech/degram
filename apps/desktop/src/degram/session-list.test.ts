import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listScopeSessions } from './session-list'

describe('listScopeSessions', () => {
  let activeProfile = 'scope-a'
  const route = { get: () => activeProfile }

  beforeEach(() => {
    activeProfile = 'scope-a'
  })

  it('lists only the active scope through session.list and strips scope-sensitive fields', async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe('session.list')

      return {
        status: 'ok',
        sessions: [
          {
            id: 'a-1',
            title: 'Scope A chat',
            started_at: 10,
            last_active: 20,
            preview: 'Only A can see this',
            profile: 'scope-a',
            model: 'private-model',
            provider: 'private-provider'
          }
        ]
      }
    })
    const result = await listScopeSessions(40, undefined, route, { request: request as never })

    expect(request).toHaveBeenCalledWith('session.list', { include_hidden: false, limit: 40 })
    expect(result).toMatchObject({
      sessions: [
        {
          id: 'a-1',
          title: 'Scope A chat',
          started_at: 10,
          last_active: 20,
          preview: 'Only A can see this'
        }
      ]
    })
    expect(result.sessions[0]).not.toHaveProperty('profile')
    expect(result.sessions[0].model).toBeNull()
  })

  it('returns a failed slice when the allowed gateway request fails', async () => {
    const request = vi.fn(async () => {
      throw new Error('gateway unavailable')
    })

    await expect(listScopeSessions(40, undefined, route, { request: request as never })).resolves.toEqual({
      failed: true,
      sessions: []
    })
  })

  it('does not call the gateway while the route disagrees with the ready scope', async () => {
    const request = vi.fn()
    const result = await listScopeSessions(
      40,
      { scope: { status: 'ready', profile: 'scope-b' } } as never,
      route,
      { request }
    )

    expect(result).toEqual({ failed: true, sessions: [] })
    expect(request).not.toHaveBeenCalled()
  })

  it('reads earlier rows again after A -> B -> A without mixing the two backends', async () => {
    const sessions = {
      'scope-a': [{ id: 'a-1', title: 'A earlier', started_at: 1, last_active: 3, preview: 'A' }],
      'scope-b': [{ id: 'b-1', title: 'B only', started_at: 2, last_active: 4, preview: 'B' }]
    }
    const request = vi.fn(async () => ({ status: 'ok', sessions: sessions[activeProfile as 'scope-a' | 'scope-b'] }))
    const requester = { request: request as never }
    await expect(listScopeSessions(40, undefined, route, requester)).resolves.toMatchObject({ sessions: [{ id: 'a-1' }] })
    activeProfile = 'scope-b'
    await expect(listScopeSessions(40, undefined, route, requester)).resolves.toMatchObject({ sessions: [{ id: 'b-1' }] })
    activeProfile = 'scope-a'
    await expect(listScopeSessions(40, undefined, route, requester)).resolves.toMatchObject({ sessions: [{ id: 'a-1' }] })
  })
})
