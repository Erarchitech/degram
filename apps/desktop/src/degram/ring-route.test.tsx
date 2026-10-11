// @vitest-environment jsdom
// ring-route.test.tsx — a newly ready scope stays on the DG page; the pill and the history open chats
// (Phase 1301-34, D-41).

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NEW_CHAT_ROUTE } from '@/app/routes'
import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile, $freshSessionPreserveRoute, $freshSessionRequest } from '@/store/profile'

import { DegramShellHost } from './shell-host'
import { DG_PAGE_PATH } from './sidebar-nav'
import { install, makeState, noScope } from './test-harness'
import { resetDegramStore } from './use-degram-state'

vi.mock('@/lib/query-client', () => ({
  invalidateProfileScopedQueries: vi.fn()
}))

vi.mock(import('@/store/profile'), async importOriginal => {
  const actual = await importOriginal()

  return {
    ...actual,
    ensureGatewayProfile: vi.fn(async (name?: null | string) => {
      actual.$activeGatewayProfile.set(actual.normalizeProfileKey(name))
    }),
    invalidateProfileListFetches: vi.fn(),
    pinNewChatProfile: vi.fn((name: string) => name)
  }
})

function Where() {
  const location = useLocation()

  return <span data-testid="where">{location.pathname}</span>
}

const ready = (epoch = 1) =>
  makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'scope-alpha', epoch, error: null } })

const where = () => screen.getByTestId('where').textContent

beforeEach(() => {
  $activeGatewayProfile.set('old')
})

afterEach(() => {
  cleanup()
  resetDegramStore()
  $degramEnabled.set(false)
  $activeGatewayProfile.set('default')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

function mount(route = NEW_CHAT_ROUTE) {
  const h = install(makeState({ scope: { ...noScope } }))

  render(
    <MemoryRouter initialEntries={[route]}>
      <DegramShellHost>
        <Where />
      </DegramShellHost>
    </MemoryRouter>
  )

  return h
}

describe('a newly ready scope lands on the DG ring (D-41)', () => {
  it('navigates to /dg, resets the draft with the route preserved, and does not open a chat', async () => {
    const h = mount()

    await act(async () => undefined)
    expect(where()).toBe(NEW_CHAT_ROUTE)

    const before = $freshSessionRequest.get()

    h.emitState(ready())

    await waitFor(() => expect(where()).toBe(DG_PAGE_PATH))
    expect($freshSessionRequest.get()).toBe(before + 1)
    expect($freshSessionPreserveRoute.get()).toBe(true)
  })

  it('a boot restore of an already open scope keeps the current route', async () => {
    install(ready())
    render(
      <MemoryRouter initialEntries={['/somewhere']}>
        <DegramShellHost>
          <Where />
        </DegramShellHost>
      </MemoryRouter>
    )

    await act(async () => undefined)
    expect(where()).toBe('/somewhere')
  })
})

describe('the DG page pill opens a chat in the active scope (D-41, T-1301-34-01)', () => {
  it('new-session-requested starts a fresh chat on the chat route while a scope is ready', async () => {
    const h = mount(DG_PAGE_PATH)

    await act(async () => undefined)
    h.emitState(ready())
    await waitFor(() => expect($activeGatewayProfile.get()).toBe('scope-alpha'))
    await act(async () => undefined)
    expect(where()).toBe(DG_PAGE_PATH)

    const before = $freshSessionRequest.get()

    h.emitEvent({ type: 'new-session-requested' })

    await waitFor(() => expect(where()).toBe(NEW_CHAT_ROUTE))
    expect($freshSessionRequest.get()).toBe(before + 1)
    expect($freshSessionPreserveRoute.get()).toBe(false)
  })

  it('the event is ignored in the renderer while no scope is ready', async () => {
    const h = mount(DG_PAGE_PATH)

    await act(async () => undefined)

    const before = $freshSessionRequest.get()

    h.emitEvent({ type: 'new-session-requested' })
    await act(async () => undefined)

    expect(where()).toBe(DG_PAGE_PATH)
    expect($freshSessionRequest.get()).toBe(before)
  })

  it('sends the DeGram locale to main when the shell mounts', async () => {
    const h = mount()

    await act(async () => undefined)
    expect(h.bridge.setLocale).toHaveBeenCalledWith(expect.stringMatching(/^(ru|en)$/))
  })
})
