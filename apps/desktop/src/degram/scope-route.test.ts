// scope-route.test.ts — the chat follows the ready scope's profile (Phase 1301-18, G-7, G-3, D-19, DGCL-02).

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { filterSessionsByProfileScope } from '@/app/chat/sidebar/profile-scope'
import { useSessionListActions } from '@/app/session/hooks/use-session-list-actions'
import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile, $freshSessionPreserveRoute, $profileScope, requestFreshSession } from '@/store/profile'
import { $sessions, setSessions } from '@/store/session'

import type { DegramState } from '../../electron/degram/ipc'

import { degramScopeTag, followScopeRoute, handleNewScope, routeDisagreesWithScope } from './scope-route'
import { makeState, noScope } from './test-harness'
import { setDegramGatewayForTests } from './use-degram-gateway'
import { $degram, resetDegramStore } from './use-degram-state'

vi.mock('@/lib/query-client', () => ({
  invalidateProfileScopedQueries: vi.fn()
}))

vi.mock(import('@/store/profile'), async importOriginal => {
  const actual = await importOriginal()

  return {
    ...actual,
    ensureGatewayProfile: vi.fn(async () => undefined),
    invalidateProfileListFetches: vi.fn(),
    pinNewChatProfile: vi.fn((name: string) => name)
  }
})

const profile = await import('@/store/profile')

const ready = (name: null | string, epoch = 1): DegramState =>
  makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: name, epoch, error: null } })

beforeEach(() => {
  vi.mocked(profile.ensureGatewayProfile).mockReset()
  vi.mocked(profile.ensureGatewayProfile).mockImplementation(async name => {
    $activeGatewayProfile.set(profile.normalizeProfileKey(name))
  })
  vi.mocked(profile.pinNewChatProfile).mockClear()
  $activeGatewayProfile.set('old')
  setSessions([{ id: 's1', title: 'previous project', profile: 'old' } as never])
})

afterEach(() => {
  $activeGatewayProfile.set('default')
  setSessions([])
  vi.restoreAllMocks()
})

describe('routeDisagreesWithScope', () => {
  it('is false without a ready scope, whatever the route is', () => {
    expect(routeDisagreesWithScope(null)).toBe(false)
    expect(routeDisagreesWithScope(makeState({ scope: { ...noScope } }))).toBe(false)
    expect(routeDisagreesWithScope(makeState({ scope: { ...noScope, status: 'opening', epoch: 1 } }))).toBe(false)
  })

  it('is true while the route is on another profile than the ready scope, false once they agree', () => {
    expect(routeDisagreesWithScope(ready('new'))).toBe(true)
    $activeGatewayProfile.set('new')
    expect(routeDisagreesWithScope(ready('new'))).toBe(false)
  })

  it('compares the normalized key, so an empty route is the default profile', () => {
    $activeGatewayProfile.set('  ')
    expect(routeDisagreesWithScope(ready('default'))).toBe(false)
  })

  it('a ready scope without a profile cannot be followed and counts as a disagreement', () => {
    expect(routeDisagreesWithScope(ready(null))).toBe(true)
  })
})

describe('followScopeRoute', () => {
  it('wipes the session lists, then moves the route to the scope profile, then pins the next chat to it', async () => {
    const order: string[] = []

    vi.mocked(profile.ensureGatewayProfile).mockImplementation(async name => {
      order.push(`ensure:${$sessions.get().length}`)
      $activeGatewayProfile.set(profile.normalizeProfileKey(name))
    })
    vi.mocked(profile.pinNewChatProfile).mockImplementation(name => {
      order.push('pin')

      return name
    })

    await expect(followScopeRoute(ready('new'), { fresh: true })).resolves.toBe('switched')

    // The previous scope's rows are gone BEFORE the new route is activated (G-3, T-1301-18-01).
    expect(order).toEqual(['ensure:0', 'pin'])
    expect(profile.ensureGatewayProfile).toHaveBeenCalledWith('new')
    expect(profile.pinNewChatProfile).toHaveBeenCalledWith('new')
    expect($activeGatewayProfile.get()).toBe('new')
    expect($sessions.get()).toEqual([])
  })

  it('leaves the lists alone when the route already serves the scope profile', async () => {
    $activeGatewayProfile.set('new')

    await expect(followScopeRoute(ready('new'), { fresh: true })).resolves.toBe('agreed')
    expect($sessions.get()).toHaveLength(1)
  })

  it('does nothing for a scope that is not ready', async () => {
    await expect(followScopeRoute(makeState({ scope: { ...noScope } }), { fresh: false })).resolves.toBe('agreed')
    expect(profile.ensureGatewayProfile).not.toHaveBeenCalled()
    expect($sessions.get()).toHaveLength(1)
  })

  it('reports failed, without the profile name in the log, when the route cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    vi.mocked(profile.ensureGatewayProfile).mockRejectedValueOnce(new Error('socket down'))

    await expect(followScopeRoute(ready('secret-profile-name'), { fresh: true })).resolves.toBe('failed')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).not.toContain('secret-profile-name')
    expect(profile.pinNewChatProfile).not.toHaveBeenCalled()
    // The route is still the old one: Send stays blocked by the guard.
    expect(routeDisagreesWithScope(ready('secret-profile-name'))).toBe(true)
  })

  it('reports failed when the activation resolved but did not land on the scope profile', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(profile.ensureGatewayProfile).mockImplementation(async () => undefined)

    await expect(followScopeRoute(ready('new'), { fresh: true })).resolves.toBe('failed')
    expect(profile.pinNewChatProfile).not.toHaveBeenCalled()
  })

  it('a newer call supersedes an older one that is still opening its route', async () => {
    let releaseFirst: () => void = () => undefined

    vi.mocked(profile.ensureGatewayProfile)
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseFirst = () => {
              $activeGatewayProfile.set('b')
              resolve()
            }
          })
      )
      .mockImplementationOnce(async () => {
        $activeGatewayProfile.set('c')
      })

    const first = followScopeRoute(ready('b', 1), { fresh: true })
    const second = followScopeRoute(ready('c', 2), { fresh: true })

    await expect(second).resolves.toBe('switched')
    releaseFirst()
    await expect(first).resolves.toBe('superseded')
  })
})

describe('handleNewScope (what the shell host runs on a new scope)', () => {
  it('moves the route before it opens the fresh chat', async () => {
    const order: string[] = []

    vi.mocked(profile.ensureGatewayProfile).mockImplementation(async name => {
      order.push('route')
      $activeGatewayProfile.set(profile.normalizeProfileKey(name))
    })

    await handleNewScope(ready('new'), { fresh: true }, () => order.push('fresh-chat'))
    expect(order).toEqual(['route', 'fresh-chat'])
  })

  it('opens no fresh chat when the route cannot be opened', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(profile.ensureGatewayProfile).mockRejectedValueOnce(new Error('socket down'))

    const open = vi.fn()

    await handleNewScope(ready('new'), { fresh: true }, open)
    expect(open).not.toHaveBeenCalled()
  })

  it('a boot restore moves the route but opens no fresh chat (UAT 6.1)', async () => {
    const open = vi.fn()

    await handleNewScope(ready('new'), { fresh: false }, open)
    expect($activeGatewayProfile.get()).toBe('new')
    expect(open).not.toHaveBeenCalled()
  })

  it('opens no fresh chat for a scope a newer one replaced meanwhile', async () => {
    let releaseFirst: () => void = () => undefined

    vi.mocked(profile.ensureGatewayProfile)
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseFirst = () => {
              $activeGatewayProfile.set('b')
              resolve()
            }
          })
      )
      .mockImplementationOnce(async () => {
        $activeGatewayProfile.set('c')
      })

    const openB = vi.fn()
    const openC = vi.fn()
    const first = handleNewScope(ready('b', 1), { fresh: true }, openB)
    const second = handleNewScope(ready('c', 2), { fresh: true }, openC)

    await second
    releaseFirst()
    await first
    expect(openB).not.toHaveBeenCalled()
    expect(openC).toHaveBeenCalledTimes(1)
  })
})

describe('degramScopeTag (the key of what the sidebar remembers per scope, D-42)', () => {
  it('differs by user, company and project, and has one fixed empty scope for every state without a ready scope', () => {
    const tag = (state: DegramState) => degramScopeTag(state)
    const alice = ready('p')
    const bob = { ...ready('p'), auth: { ...ready('p').auth, username: 'bob' } }
    const otherCompany = makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Other', profile: 'p', epoch: 1, error: null } })
    const otherProject = makeState({ scope: { status: 'ready', project: 'Beta', company: 'Acme', profile: 'p', epoch: 1, error: null } })

    expect(new Set([tag(alice), tag(bob), tag(otherCompany), tag(otherProject)]).size).toBe(4)
    expect(tag(alice)).toBe(tag(ready('other-profile', 7)))

    const none = degramScopeTag(null)

    expect(degramScopeTag(makeState({ scope: { ...noScope } }))).toBe(none)
    expect(degramScopeTag({ ...alice, auth: { ...alice.auth, kind: 'signed-out' } })).toBe(none)
    expect(degramScopeTag(makeState({ scope: { ...noScope, status: 'opening', epoch: 1 } }))).toBe(none)
    expect(none).not.toBe(tag(alice))
  })

  it('does not collide when a field contains the separator', () => {
    const a = makeState({ scope: { status: 'ready', project: 'b|c', company: 'a', profile: 'p', epoch: 1, error: null } })
    const b = makeState({ scope: { status: 'ready', project: 'c', company: 'a|b', profile: 'p', epoch: 1, error: null } })

    expect(degramScopeTag(a)).not.toBe(degramScopeTag(b))
  })
})

describe('requestFreshSession route preservation (D-41)', () => {
  it('is off by default and on only when asked, per call', () => {
    requestFreshSession()
    expect($freshSessionPreserveRoute.get()).toBe(false)

    requestFreshSession({ preserveRoute: true })
    expect($freshSessionPreserveRoute.get()).toBe(true)

    requestFreshSession()
    expect($freshSessionPreserveRoute.get()).toBe(false)
  })
})

// F-04 (0.1.10 live recheck): the sidebar said «Сеансов пока нет» in v12 after returning to it while the member's scope
// profile held 2 stored sessions. The sequences below drive the REAL route follow, the REAL session list request and
// the REAL refresh the sidebar's effect runs, against a fake backend that answers per active route.
describe('F-04: the list of a project is back whenever the project is reopened', () => {
  const PA = 'scope-00000000000000aa'
  const PB = 'scope-00000000000000bb'

  /** The stored sessions per scope profile, newest first, as `session.list` returns them (no profile field). */
  const stored: Record<string, Array<{ id: string; last_active: number }>> = {
    [PA]: [
      { id: 'a-2233', last_active: 2233 },
      { id: 'a-2210', last_active: 2210 }
    ],
    [PB]: [{ id: 'b-1', last_active: 1 }]
  }

  const asked: string[] = []

  const readyOf = (name: string): DegramState =>
    makeState({ scope: { status: 'ready', project: name, company: null, profile: name, epoch: 1, error: null } })

  const setState = (state: DegramState): void => {
    $degram.set({ ...$degram.get(), loaded: true, state })
  }

  /** What the sidebar's effect does once the route moved: one refresh with the profile scope the sidebar reads. */
  async function refreshLikeTheSidebar(): Promise<void> {
    const { result, unmount } = renderHook(() => useSessionListActions({ profileScope: $profileScope.get() }))

    await act(async () => {
      await result.current.refreshSessions()
    })
    unmount()
  }

  const visible = (): string[] => filterSessionsByProfileScope($sessions.get(), $profileScope.get()).map(row => row.id)

  /** Open a scope the way the shell host does: the state turns ready, the route follows, the sidebar refreshes. */
  async function open(name: string): Promise<void> {
    const state = readyOf(name)

    setState(state)
    await followScopeRoute(state, { fresh: false })
    await refreshLikeTheSidebar()
  }

  beforeEach(() => {
    asked.length = 0
    resetDegramStore()
    $degramEnabled.set(true)
    setSessions([])
    setDegramGatewayForTests(async <T,>(method: string) => {
      asked.push(normalizeRoute())

      if (method !== 'session.list') {
        throw new Error(`unexpected ${method}`)
      }

      return { status: 'ok', sessions: stored[$activeGatewayProfile.get() ?? ''] ?? [] } as T
    })
  })

  afterEach(() => {
    setDegramGatewayForTests(null)
    $degramEnabled.set(false)
    resetDegramStore()
  })

  const normalizeRoute = (): string => profile.normalizeProfileKey($activeGatewayProfile.get())

  it('F-04 fresh open: the member sees the stored sessions of the project, newest first', async () => {
    await open(PA)

    expect(visible()).toEqual(['a-2233', 'a-2210'])
  })

  it('F-04 A -> B -> A: the list of A is back, with no row of B', async () => {
    await open(PA)
    await open(PB)
    expect(visible()).toEqual(['b-1'])

    await open(PA)

    expect(visible()).toEqual(['a-2233', 'a-2210'])
    expect($sessions.get().some(row => row.id === 'b-1')).toBe(false)
  })

  it('F-04 A -> refused C -> A: the open project keeps its list and a re-follow refills it', async () => {
    await open(PA)
    // A refused pick leaves A open (plan 37): the state stays ready for A, the route stays on A, nothing is wiped.
    await open(PA)

    expect(visible()).toEqual(['a-2233', 'a-2210'])
  })

  it('F-04 A -> Menu -> A: the scope is released (route back on the primary, state idle) and re-opened', async () => {
    await open(PA)

    // main released the scope; the renderer's registry restored the active route to the primary profile.
    setState(makeState({ scope: { ...noScope } }))
    $activeGatewayProfile.set('default')

    await open(PA)

    expect(visible()).toEqual(['a-2233', 'a-2210'])
  })

  it('F-04 only the ready scope route is asked (G-25): no request while the route disagrees with the scope', async () => {
    await open(PA)
    await open(PB)

    expect(asked.every(route => route === PA || route === PB)).toBe(true)
    expect(asked[asked.length - 1]).toBe(PB)
  })
})
