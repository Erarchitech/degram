import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationStack } from '@/components/notifications'
import { I18nProvider, useI18n } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $busy } from '@/store/session'
import { stubMenuDomApis } from '@/test/jsdom'

import type { DegramState } from '../../electron/degram/ipc'

import { DegramGate } from './degram-gate'
import { DgPage } from './dg-page'
import { IsolationBootFailure } from './isolation-boot-failure'
import { ProjectPicker } from './project-picker'
import { ScopeStrip } from './scope-strip'
import { SignInState } from './sign-in-state'
import { install, makeState, noScope, withActions } from './test-harness'
import { resetDegramStore, startDegramSync } from './use-degram-state'

beforeEach(() => {
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  resetDegramStore()
  $busy.set(false)
  $notifications.set([])
  $degramEnabled.set(false)
  $activeGatewayProfile.set('default')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('sign-in state (D-05, UI loading/error E7)', () => {
  it('renders the wordmark and the Connecting to DG loader until the login page paints', async () => {
    const h = install(makeState({ dg: { mode: 'graph', page: 'blank', reachable: true } }))

    // The window attached before the first load: the view is still blank, so nothing has painted yet.
    h.emitState({
      ...makeState({ dg: { mode: 'graph', page: 'blank', reachable: true } }),
      auth: { kind: 'signed-out', username: null, isAdmin: false, memberships: [] }
    })
    render(<SignInState />)

    expect(screen.getByText('DeGram')).toBeTruthy()
    expect(screen.getByText('Connecting to DG')).toBeTruthy()

    h.emitEvent({ type: 'dg-reachable' })
    await waitFor(() => expect(screen.queryByText('Connecting to DG')).toBeNull())
  })

  it('shows the session-ended copy above the login view after a 401', async () => {
    const h = install(makeState())

    h.emitEvent({ type: 'session-ended' })
    h.emitState({ ...makeState(), auth: { kind: 'signed-out', username: null, isAdmin: false, memberships: [] } })
    render(<SignInState />)

    expect(
      screen.getByText(
        'Your DG session has ended. Sign in again to continue; project data was cleared from this window.'
      )
    ).toBeTruthy()
  })

  it('shows the unreachable ErrorState with Retry request when the DG server cannot be reached', async () => {
    const h = install(makeState())

    h.emitState({
      ...makeState(),
      auth: { kind: 'unknown', username: null, isAdmin: false, memberships: [] },
      dg: { mode: 'graph', page: 'sign-in', reachable: false }
    })
    render(<SignInState />)

    expect(
      screen.getByText("The DG server can't be reached. Check your network or VPN, then retry the request.")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }))
    // G-16: Retry re-checks DG (/auth/me) and reloads the view in main, not a bare page reload
    expect(h.bridge.retryDg).toHaveBeenCalledTimes(1)
    expect(h.bridge.reloadDg).not.toHaveBeenCalled()
  })

  it('reports the placeholder rectangle to main so the sign-in view can be shown, and hides it on unmount', async () => {
    const h = install(makeState())

    h.emitState({ ...makeState(), auth: { kind: 'signed-out', username: null, isAdmin: false, memberships: [] } })
    const { unmount } = render(<SignInState />)

    await waitFor(() => expect(h.bridge.setDgBounds).toHaveBeenCalled())
    unmount()
    expect(h.bridge.setDgBounds).toHaveBeenLastCalledWith(null)
  })
})

describe('isolation boot failure (D-02, UI overflow/long-text E8)', () => {
  const longPath =
    'C:\\Users\\Admin\\AppData\\Local\\hermes\\profiles\\very-long-profile-name\\and\\a\\deeper\\folder\\tree\\here'

  it('renders the runtime-isolation copy with the full overlapping path, never truncated, with no continue action', () => {
    render(<IsolationBootFailure path={longPath} />)

    const copy = screen.getByText((_, el) => el?.tagName === 'P' && Boolean(el.textContent?.includes(longPath)))

    expect(copy.textContent).toContain("DeGram can't start: its data folder overlaps a Hermes profile at")

    const pathNode = within(copy.parentElement as HTMLElement)
      .getAllByText(longPath)
      .find(el => el.className.includes('break-all'))

    expect(pathNode).toBeTruthy()
    expect(pathNode!.className).toContain('font-mono')
    expect(pathNode!.className).not.toContain('truncate')
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('single start screen (D-33)', () => {
  it('keeps the DG view and pairing field on the signed-in start screen with no project-choice button', async () => {
    const h = install(makeState())
    await act(async () => undefined)
    render(withActions(<DegramGate />))

    expect(screen.getByTestId('degram-first-screen')).toBeTruthy()
    expect(screen.getByTestId('degram-pairing')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Choose project' })).toBeNull()
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
  })

  it('hides the pairing panel once a token is stored', async () => {
    install(makeState({ pairing: { status: 'stored', company: 'Acme', available: true } }))
    await act(async () => undefined)
    render(withActions(<DegramGate />))
    expect(screen.queryByTestId('degram-pairing')).toBeNull()
  })
})

describe('scope strip (UI loading/error/long-text E1)', () => {
  it('shows company, project, document and both bridges once a project is open, bridges neutral and checking', async () => {
    install(
      makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null } })
    )
    await act(async () => undefined)
    render(withActions(<ScopeStrip />))

    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Select document')).toBeTruthy()
    expect(screen.getByText('Revit')).toBeTruthy()
    expect(screen.getByText('Grasshopper')).toBeTruthy()
    expect(screen.getAllByText('Checking')).toHaveLength(2)
  })

  it('ellipsizes a long Cyrillic project label at 24 characters and keeps the full value as the accessible name', async () => {
    const long = 'Очень длинное название проекта жилого комплекса'

    install(
      makeState({
        memberships: [{ project: long, role: 'member', company: null }],
        scope: { status: 'ready', project: long, company: null, profile: 'p', epoch: 1, error: null }
      })
    )
    await act(async () => undefined)
    render(withActions(<ScopeStrip />))

    const label = screen.getByText(long)

    expect(label.className).toContain('truncate')
    expect(label.className).toContain('max-w-[24ch]')
  })
})

describe('project picker (UI E2)', () => {
  const open = async (memberships: DegramState['auth']['memberships'], actions?: Parameters<typeof withActions>[1]) => {
    const h = install(makeState({ memberships }))

    await act(async () => undefined)
    render(
      withActions(
        <ProjectPicker>
          <button type="button">pick</button>
        </ProjectPicker>,
        actions
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'pick' }))
    await screen.findByRole('listbox')

    return h
  }

  it('lists only memberships; a project without a company shows no placeholder text', async () => {
    await open([
      { project: 'Alpha', role: 'member', company: 'Acme' },
      { project: 'Beta', role: 'member', company: null }
    ])

    // the last row is the separated Sign out of DG command (G-17), not a project
    const rows = screen.getAllByRole('option').slice(0, -1)

    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Alpha')).toBeTruthy()
    expect(within(rows[0]).getByText('Acme')).toBeTruthy()
    expect(rows[1].textContent).toBe('Beta')
  })

  it('ends with a separated Sign out of DG command that signs out at once when nothing is running (G-17)', async () => {
    const h = await open([{ project: 'Alpha', role: 'member', company: 'Acme' }])
    const rows = screen.getAllByRole('option')

    expect(rows[rows.length - 1]!.textContent).toBe('Sign out of DG')
    expect(screen.getByRole('listbox').querySelector('[cmdk-separator]')).toBeTruthy()

    fireEvent.click(rows[rows.length - 1]!)
    await waitFor(() => expect(h.bridge.signOut).toHaveBeenCalledTimes(1))
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
  })

  it('keeps the Sign out of DG command visible while the search narrows the project list (G-17)', async () => {
    await open(Array.from({ length: 8 }, (_, i) => ({ project: `P${i}`, role: 'member', company: null })))

    fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'P3' } })

    await waitFor(() => expect(screen.getAllByRole('option').map(row => row.textContent)).toContain('Sign out of DG'))
  })

  it('selecting a project calls selectProject once the list is loaded', async () => {
    const h = await open([
      { project: 'Alpha', role: 'member', company: 'Acme' },
      { project: 'Beta', role: 'member', company: null }
    ])

    fireEvent.click(screen.getByRole('option', { name: /Alpha/ }))
    await waitFor(() => expect(h.bridge.selectProject).toHaveBeenCalledWith('Alpha'))
  })

  it('never auto-selects a single membership (T-1301-13-04)', async () => {
    const h = await open([{ project: 'Only', role: 'member', company: 'Acme' }])

    expect(screen.getAllByRole('option').filter(row => row.textContent?.startsWith('Only'))).toHaveLength(1)
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
  })

  it('shows a search field only above seven projects', async () => {
    await open(Array.from({ length: 7 }, (_, i) => ({ project: `P${i}`, role: 'member', company: null })))
    expect(screen.queryByPlaceholderText('Search projects')).toBeNull()
    cleanup()
    resetDegramStore()

    await open(Array.from({ length: 8 }, (_, i) => ({ project: `P${i}`, role: 'member', company: null })))
    expect(screen.getByPlaceholderText('Search projects')).toBeTruthy()
  })

  it('asks Stop and switch / Keep working when a response is running, and stops before switching', async () => {
    const actions = { stopResponse: vi.fn(async () => undefined), startNewChat: vi.fn() }

    $busy.set(true)

    const h = await open(
      [
        { project: 'Alpha', role: 'member', company: 'Acme' },
        { project: 'Beta', role: 'member', company: null }
      ],
      actions
    )

    fireEvent.click(screen.getByRole('option', { name: /Beta/ }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Switch project')).toBeTruthy()
    expect(within(dialog).getByText('The running response will be stopped. Beta opens in a new chat.')).toBeTruthy()
    expect(h.bridge.selectProject).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop and switch' }))
    await waitFor(() => expect(h.bridge.selectProject).toHaveBeenCalledWith('Beta'))
    expect(actions.stopResponse).toHaveBeenCalledTimes(1)
  })

  it('Keep working leaves the running response and the project untouched', async () => {
    const actions = { stopResponse: vi.fn(async () => undefined), startNewChat: vi.fn() }

    $busy.set(true)
    const h = await open([{ project: 'Beta', role: 'member', company: null }], actions)

    fireEvent.click(screen.getByRole('option', { name: /Beta/ }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep working' }))
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
    expect(actions.stopResponse).not.toHaveBeenCalled()
  })

  it('shows the compact unreachable ErrorState with Retry request when the project list cannot be refreshed', async () => {
    const h = install(makeState())

    ;(h.bridge.getState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    await act(async () => undefined)
    render(
      withActions(
        <ProjectPicker>
          <button type="button">pick</button>
        </ProjectPicker>
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'pick' }))

    expect(
      await screen.findByText("The DG server can't be reached. Check your network or VPN, then retry the request.")
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry request' })).toBeTruthy()
  })
})

describe('new scope opens a fresh chat (D-19)', () => {
  const ready = (epoch: number) =>
    makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch, error: null } })

  it('fires once per newly ready scope epoch and never for the scope already ready and routed at mount', async () => {
    const onNew = vi.fn()
    const h = install(makeState())

    h.stop()
    resetDegramStore()
    const stop = startDegramSync(h.bridge, onNew)

    await act(async () => undefined)
    h.emitState({ ...makeState(), scope: { ...noScope, status: 'opening', epoch: 1 } })
    expect(onNew).not.toHaveBeenCalled()
    h.emitState(ready(1))
    expect(onNew).toHaveBeenCalledTimes(1)
    // The handler gets the state of the scope (the route moves to its profile, G-7) and fresh = true.
    expect(onNew).toHaveBeenLastCalledWith(expect.objectContaining({ scope: expect.objectContaining({ profile: 'p', epoch: 1 }) }), {
      fresh: true
    })
    h.emitState(ready(1))
    expect(onNew).toHaveBeenCalledTimes(1)
    h.emitState(ready(2))
    expect(onNew).toHaveBeenCalledTimes(2)
    stop()

    // A reload while a scope is already open, with the chat already on its profile, only records it.
    resetDegramStore()
    $activeGatewayProfile.set('p')
    const onReload = vi.fn()
    const again = install(ready(5))

    again.stop()
    resetDegramStore()
    const stopAgain = startDegramSync(again.bridge, onReload)

    await act(async () => undefined)
    expect(onReload).not.toHaveBeenCalled()
    stopAgain()
  })

  it('a scope already ready at mount whose chat route is on another profile fires once, without a fresh chat (UAT 6.1)', async () => {
    // The route restored from the previous run is not the scope's profile.
    $activeGatewayProfile.set('restored-from-last-run')

    const onBoot = vi.fn()
    const h = install(ready(5))

    h.stop()
    resetDegramStore()
    const stop = startDegramSync(h.bridge, onBoot)

    await act(async () => undefined)
    expect(onBoot).toHaveBeenCalledTimes(1)
    expect(onBoot).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ epoch: 5 }) }), {
      fresh: false
    })

    // The same epoch again is not a new scope.
    h.emitState(ready(5))
    expect(onBoot).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('access revoked (D-08, D-19)', () => {
  it('toasts the project name and falls back to the project EmptyState', async () => {
    const h = install(
      makeState({ scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null } })
    )

    await act(async () => undefined)
    render(withActions(<DegramGate />))

    h.emitEvent({ type: 'access-revoked', project: 'Alpha', purged: true })
    h.emitState(makeState())

    const [toast] = $notifications.get()

    expect(toast.message).toBe(
      'You no longer have access to Alpha. Its data and local chat history were removed from this computer.'
    )
    expect(screen.getByTestId('degram-first-screen')).toBeTruthy()
  })

  it('a blocked external link toasts the notice whose action opens the system browser on a click only', async () => {
    const h = install(makeState())

    h.emitEvent({ type: 'external-link-blocked', url: 'https://example.com/x' })

    const [toast] = $notifications.get()

    expect(toast.message).toBe("This link leads outside DG and won't open inside DeGram.")
    expect(toast.action?.label).toBe('Open in browser')
    expect(h.bridge.openExternalConfirmed).not.toHaveBeenCalled()
    toast.action!.onClick()
    expect(h.bridge.openExternalConfirmed).toHaveBeenCalledWith('https://example.com/x')
  })
})

describe('persistent start-screen notices (G-18, G-20, D-35)', () => {
  it('keeps an access-revoked notice until it is dismissed', async () => {
    const h = install(makeState())
    render(withActions(<DegramGate />))
    h.emitEvent({ type: 'access-revoked', project: 'Alpha', purged: true })
    expect(screen.getByText('You no longer have access to Alpha. Its data and local chat history were removed from this computer.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByText(/You no longer have access/)).toBeNull()
  })

  it('shows pairing revocation from the snapshot and focuses the field', async () => {
    install(makeState({ pairing: { status: 'revoked', company: null, available: true } }))
    await act(async () => undefined)
    render(withActions(<DegramGate />))
    expect(screen.getByText('The pairing token was revoked. Create a new one on the Connectors tab in DG (in a browser) and paste it below.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Pairing token'))
  })

  it('shows the pairing-required notice and focuses the field', async () => {
    const h = install(makeState())
    await act(async () => undefined)
    render(withActions(<DegramGate />))
    h.emitEvent({ type: 'pairing-required' })
    expect(screen.getByText('Paste a pairing token before choosing a project.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Pairing token'))
  })

  it('shows backend-start failure from the snapshot and retries that project', async () => {
    const h = install(makeState({ scope: { status: 'error', project: 'Alpha', company: 'Acme', profile: null, epoch: 1, error: 'BACKEND_START_FAILED' } }))
    await act(async () => undefined)
    render(withActions(<DegramGate />))
    expect(screen.getByText('The agent for project Alpha could not start.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }))
    expect(h.bridge.selectProject).toHaveBeenCalledWith('Alpha')
  })
})

describe('Russian is the first-run locale of variant degram (DGCL-02, UI-SPEC)', () => {
  function Probe() {
    const { t } = useI18n()

    return <span data-testid="probe">{t.degram.cta.chooseProject}</span>
  }

  const configClient = { getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }

  it('starts in ru when no language was ever saved', async () => {
    $degramEnabled.set(true)
    render(
      <I18nProvider configClient={configClient}>
        <Probe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Выбрать проект'))
  })

  it('keeps a saved language and leaves other variants on the standard resolution', async () => {
    $degramEnabled.set(true)
    render(
      <I18nProvider configClient={{ ...configClient, getConfig: async () => ({ display: { language: 'en' } }) }}>
        <Probe />
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Choose project'))
    cleanup()

    $degramEnabled.set(false)
    render(
      <I18nProvider configClient={configClient}>
        <Probe />
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Choose project'))
  })
})

describe('copy catalog', () => {
  it('never mentions the served system pair (T-1301-13-01)', async () => {
    const { degramEn, degramRu } = await import('./i18n')
    const dump = JSON.stringify([degramEn, degramRu], (_k, v) => (typeof v === 'function' ? v('x', 'y', 'z', 'w') : v))

    expect(dump.toLowerCase()).not.toContain('genpro')
    expect(dump.toLowerCase()).not.toContain('mimo')
  })
})

describe('DG page (D-07, UI E6)', () => {
  const ready = (over: Partial<DegramState['dg']> = {}) =>
    makeState({
      scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null },
      dg: { mode: 'graph', page: 'dg', reachable: true, ...over }
    })

  it('shows the shared first screen, never a blank view, before sign-in or a project', async () => {
    const h = install({ ...makeState(), auth: { kind: 'signed-out', username: null, isAdmin: false, memberships: [] } })

    await act(async () => undefined)
    render(<DgPage />)
    expect(screen.getByTestId('degram-first-screen')).toBeTruthy()
    cleanup()

    h.emitState(makeState())
    render(withActions(<DgPage />))
    expect(screen.getByTestId('degram-first-screen')).toBeTruthy()
  })

  it('renders the Project graph / Full DG control and the reload icon button with an accessible name', async () => {
    const h = install(ready())

    await act(async () => undefined)
    render(<DgPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Full DG' }))
    expect(h.bridge.setDgMode).toHaveBeenCalledWith('full')
    fireEvent.click(screen.getByRole('button', { name: 'Project graph' }))
    expect(h.bridge.setDgMode).toHaveBeenCalledWith('graph')

    fireEvent.click(screen.getByRole('button', { name: 'Reload the DG page' }))
    expect(h.bridge.reloadDg).toHaveBeenCalledTimes(1)
  })

  it('reports the placeholder rectangle once painted and hides the view when it unmounts', async () => {
    const h = install(ready())

    await act(async () => undefined)
    const { unmount } = render(<DgPage />)

    await waitFor(() => expect(h.bridge.setDgBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 0 })))
    unmount()
    expect(h.bridge.setDgBounds).toHaveBeenLastCalledWith(null)
  })

  it('shows the Loader until the first paint and keeps the view hidden meanwhile', async () => {
    const h = install(ready({ page: 'blank' }))

    await act(async () => undefined)
    render(<DgPage />)

    expect(screen.getByText('Connecting to DG')).toBeTruthy()
    expect(h.bridge.setDgBounds).not.toHaveBeenCalledWith(expect.objectContaining({ width: expect.any(Number) }))

    h.emitEvent({ type: 'dg-reachable' })
    await waitFor(() => expect(screen.queryByText('Connecting to DG')).toBeNull())
  })

  it('brings a blank view to the DG page once a project is open, but never reloads on the mode echo', async () => {
    const h = install(ready({ page: 'blank' }))

    await act(async () => undefined)
    render(<DgPage />)

    await waitFor(() => expect(h.bridge.setDgMode).toHaveBeenCalledWith('graph'))
    const calls = (h.bridge.setDgMode as ReturnType<typeof vi.fn>).mock.calls.length

    h.emitState(ready({ page: 'dg', mode: 'full' }))
    await act(async () => undefined)
    expect((h.bridge.setDgMode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  it('shows the unreachable ErrorState with Reload page when the load fails', async () => {
    const h = install(ready({ reachable: false }))

    await act(async () => undefined)
    render(<DgPage />)

    expect(
      screen.getByText("The DG server can't be reached. Check your network or VPN, then retry the request.")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect(h.bridge.retryDg).toHaveBeenCalledTimes(1)
  })

  it('has no scrolling shell: the section clips and the web view owns its own scrolling', async () => {
    install(ready())
    await act(async () => undefined)
    render(<DgPage />)

    expect(screen.getByTestId('dg-page').className).toContain('overflow-hidden')
  })
})

describe('DG unreachable at start and the revoke toast (G-15, G-16)', () => {
  it('the gate shows the DG-unreachable ErrorState, not a blank surface, when /auth/me never answered', async () => {
    const h = install(makeState())

    h.emitState({
      ...makeState(),
      auth: { kind: 'unknown', username: null, isAdmin: false, memberships: [] },
      dg: { mode: 'graph', page: 'blank', reachable: false }
    })
    render(<DegramGate />)

    expect(
      screen.getByText("The DG server can't be reached. Check your network or VPN, then retry the request.")
    ).toBeTruthy()
    // the native DG view stays hidden while the state is unreachable
    expect(h.bridge.setDgBounds).not.toHaveBeenCalledWith(expect.objectContaining({ width: expect.any(Number) }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }))
    expect(h.bridge.retryDg).toHaveBeenCalledTimes(1)
  })

  it('a project choice that failed with DG_UNREACHABLE retries through main, then re-reads the state', async () => {
    const h = install(makeState())

    h.emitState({
      ...makeState(),
      scope: { ...noScope, status: 'error', error: 'DG_UNREACHABLE' }
    })
    render(withActions(<DegramGate />))

    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }))
    await waitFor(() => expect(h.bridge.retryDg).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(h.bridge.getState).toHaveBeenCalledTimes(2))
  })

  it('the access-revoked toast is rendered above the full-window gate surface in variant degram', async () => {
    const h = install(makeState())

    $degramEnabled.set(true)
    h.emitState(makeState())
    render(
      <I18nProvider>
        <DegramGate />
        <NotificationStack />
      </I18nProvider>
    )

    h.emitEvent({ type: 'access-revoked', project: 'alpha', purged: true })

    await waitFor(() => expect(screen.getAllByText(/alpha/).some(node => node.closest('[role="region"]'))).toBe(true))
    const toast = screen.getAllByText(/alpha/).find(node => node.closest('[role="region"]'))!
    const region = toast.closest('[role="region"]')

    expect(screen.getByTestId('degram-gate').className).toContain('z-(--z-setup)')
    expect(region?.className).toContain('z-(--z-degram-toast)')
    expect(region?.className).not.toContain('z-(--z-over-modal)')
  })

  it('outside variant degram the toast stays on the over-modal rung', async () => {
    const h = install(makeState())

    $degramEnabled.set(false)
    render(
      <I18nProvider>
        <NotificationStack />
      </I18nProvider>
    )
    h.emitEvent({ type: 'access-revoked', project: 'alpha', purged: true })

    const toast = await screen.findByText(/alpha/)

    expect(toast.closest('[role="region"]')?.className).toContain('z-(--z-over-modal)')
  })
})
