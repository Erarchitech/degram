// @vitest-environment jsdom
// sidebar.test.tsx — the DeGram sidebar set, routing and scoped pins (Phase 1301-34, D-41, D-42).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatSidebar } from '@/app/chat/sidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { registry } from '@/contrib/registry'
import { $degramEnabled } from '@/store/degram-flag'
import { $pinnedSessionIds, pinSession } from '@/store/layout'
import { $sessions } from '@/store/session'
import { SIDEBAR_NAV_PREFS_AREA } from '@/store/sidebar-nav'
import { makeSessionInfo } from '@/test/session-info'

import { SIDEBAR_NAV_AREA } from '../app/routes'
import type { SidebarNavItem } from '../app/types'

import { degramEn, degramRu } from './i18n'
import { $degramNavRegion, DEGRAM_MODELS_PATH, DEGRAM_NAV_IDS, degramSidebarNav, DG_PAGE_PATH } from './sidebar-nav'
import { install, makeState, noScope } from './test-harness'
import { resetDegramStore } from './use-degram-state'

const noop = () => {}

const noopAsync = async () => {}

let view: ReturnType<typeof render>

function renderSidebar(pathname: string, onNavigate: (item: SidebarNavItem) => void = noop) {
  view = render(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarProvider>
        <ChatSidebar
          currentView="extension"
          onArchiveSession={noop}
          onBranchSession={noop}
          onDeleteSession={noop}
          onLoadMoreSessions={noop}
          onManageCronJob={noop}
          onNavigate={onNavigate}
          onNewSessionInWorkspace={noop}
          onNewSessionSplit={noop}
          onResumeSession={noop}
          onRetrySessions={noopAsync}
          onTriggerCronJob={noopAsync}
        />
      </SidebarProvider>
    </MemoryRouter>
  )

  return view
}

const navLabels = () =>
  [...view.baseElement.querySelectorAll('[data-tour^="sidebar-nav-"]')].map(node => node.textContent?.trim() ?? '')

const ready = (project: string, over: { company?: null | string; user?: string } = {}) => {
  const state = makeState({
    scope: {
      status: 'ready',
      project,
      company: over.company === undefined ? 'Acme' : over.company,
      profile: `scope-${project}`,
      epoch: 1,
      error: null
    }
  })

  return over.user ? { ...state, auth: { ...state.auth, username: over.user } } : state
}

beforeEach(() => {
  $sessions.set([makeSessionInfo({ id: 's1', last_active: 2, started_at: 1, title: 'History row' })])
  $degramNavRegion.set('landing')
})

afterEach(() => {
  cleanup()
  resetDegramStore()
  $degramEnabled.set(false)
  $sessions.set([])
  $pinnedSessionIds.set([])
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
})

describe('the DeGram row set (D-42)', () => {
  it('is exactly seven rows in the planned order, in both catalogs', () => {
    const rows = (nav: typeof degramEn.nav) => degramSidebarNav(nav).map(item => [item.id, item.label])

    expect(degramSidebarNav(degramRu.nav).map(item => item.id)).toEqual([...DEGRAM_NAV_IDS])
    expect(rows(degramRu.nav).map(row => row[1])).toEqual([
      'Новая сессия',
      'Граф проекта',
      'Валидатор',
      'Коннекторы',
      'Модели',
      'Проекты',
      'Меню'
    ])
    expect(rows(degramEn.nav).map(row => row[1])).toEqual([
      'New session',
      'Graph Viewer',
      'Model Viewer',
      'Connectors',
      'Models',
      'Projects',
      'Menu'
    ])
  })

  it('renders only those seven rows with a ready scope; upstream rows and contributed rows are not rendered', () => {
    install(ready('Alpha'))
    $degramEnabled.set(true)

    const dispose = registry.registerMany([
      { area: SIDEBAR_NAV_AREA, id: 'kanban-nav', data: { codicon: 'project', label: 'Kanban', path: '/kanban' } },
      { area: SIDEBAR_NAV_AREA, id: 'degram.nav', data: { codicon: 'globe', label: 'DG', path: DG_PAGE_PATH } }
    ])

    renderSidebar(DG_PAGE_PATH)

    expect(navLabels()).toEqual(['New session', 'Graph Viewer', 'Model Viewer', 'Connectors', 'Models', 'Projects', 'Menu'])

    for (const gone of ['Capabilities', 'Messaging', 'Artifacts', 'Scheduled jobs', 'Kanban', 'DG']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }

    // Session history of the scope stays, and so does the pinned section.
    expect(screen.getByText('History row')).toBeTruthy()
    expect(screen.getByText('Pinned')).toBeTruthy()
    dispose()
  })

  it('a sidebarNav.prefs contribution cannot bring a stock row back or hide a DeGram row', () => {
    install(ready('Alpha'))
    $degramEnabled.set(true)

    const dispose = registry.register({
      area: SIDEBAR_NAV_PREFS_AREA,
      id: 'prefs',
      data: { hide: ['dg-graph'], show: ['capabilities'] }
    })

    renderSidebar(DG_PAGE_PATH)

    expect(navLabels()).toHaveLength(7)
    expect(navLabels()).toContain('Graph Viewer')
    dispose()
  })

  it('has no «New project» button, blank state or messaging/cron section even with no sessions', () => {
    install(ready('Alpha'))
    $degramEnabled.set(true)
    $sessions.set([])

    renderSidebar(DG_PAGE_PATH)

    expect(screen.queryByText('New project')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull()
    // The nav row is the only «New session» control: the list header's «+» is not rendered.
    expect(screen.getAllByRole('button', { name: /New session/ })).toHaveLength(1)
    expect(screen.getByText('Pinned')).toBeTruthy()
  })

  it('outside variant degram the stock rows are unchanged and no DeGram row appears', () => {
    $sessions.set([])
    renderSidebar('/capabilities')

    expect(navLabels()).toEqual(expect.arrayContaining(['New session', 'Capabilities', 'Messaging']))
    expect(screen.queryByText('Graph Viewer')).toBeNull()
    expect(screen.queryByText('Menu')).toBeNull()
    // Positive control for the degram assertions: the stock list header carries its own «New session» «+».
    expect(screen.getAllByRole('button', { name: /New session/ }).length).toBeGreaterThan(1)
  })
})

describe('the DeGram rows route and steer the DG page (D-42)', () => {
  it('Граф проекта / Валидатор / Коннекторы / Проекты / Меню navigate to /dg and send the matching region', () => {
    const h = install(ready('Alpha'))
    const onNavigate = vi.fn()

    $degramEnabled.set(true)
    renderSidebar(DG_PAGE_PATH, onNavigate)

    for (const [label, id, region] of [
      ['Graph Viewer', 'dg-graph', 'graph'],
      ['Model Viewer', 'dg-model', 'model'],
      ['Connectors', 'dg-connectors', 'connectors'],
      ['Projects', 'dg-projects', 'projects'],
      ['Menu', 'dg-menu', 'landing']
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id, route: DG_PAGE_PATH }))
      expect(h.bridge.dgGo).toHaveBeenLastCalledWith(region)
    }

    expect(h.bridge.dgGo).toHaveBeenCalledTimes(5)
  })

  it('Новая сессия is the stock new-session action and sends no region; Модели opens its own route', () => {
    const h = install(ready('Alpha'))
    const onNavigate = vi.fn()

    $degramEnabled.set(true)
    renderSidebar(DG_PAGE_PATH, onNavigate)

    fireEvent.click(screen.getByRole('button', { name: /New session/ }))
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'new-session', action: 'new-session' }))

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'models', route: DEGRAM_MODELS_PATH }))

    expect(h.bridge.dgGo).not.toHaveBeenCalled()
  })

  it('highlights the row of the last region sent while the DG page is shown', () => {
    install(ready('Alpha'))
    $degramEnabled.set(true)
    renderSidebar(DG_PAGE_PATH)

    const active = () =>
      screen
        .getAllByRole('button')
        .filter(button => button.classList.contains('bg-(--ui-control-active-background)'))
        .map(button => button.textContent?.trim())

    expect(active()).toEqual(['Menu'])

    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }))
    expect(active()).toEqual(['Connectors'])
  })

  it('highlights Модели on its own route and no DG row there', () => {
    install(ready('Alpha'))
    $degramEnabled.set(true)
    renderSidebar(DEGRAM_MODELS_PATH)

    const active = screen
      .getAllByRole('button')
      .filter(button => button.classList.contains('bg-(--ui-control-active-background)'))
      .map(button => button.textContent?.trim())

    expect(active).toEqual(['Models'])
  })
})

describe('pinned sessions are keyed by the active scope (D-42, T-1301-34-02)', () => {
  it('a pin of one project never shows in another project or for another user, and returns with its scope', async () => {
    const h = install(ready('Alpha'))

    await act(async () => undefined)

    act(() => pinSession('s1'))
    expect($pinnedSessionIds.get()).toEqual(['s1'])

    h.emitState(ready('Beta'))
    expect($pinnedSessionIds.get()).toEqual([])

    h.emitState(ready('Alpha', { user: 'bob' }))
    expect($pinnedSessionIds.get()).toEqual([])

    h.emitState(ready('Alpha', { company: 'OtherCo' }))
    expect($pinnedSessionIds.get()).toEqual([])

    h.emitState(ready('Alpha'))
    expect($pinnedSessionIds.get()).toEqual(['s1'])
  })

  it('a state without a ready scope has its own empty pin scope, and a pin made there is not shared', async () => {
    const h = install(ready('Alpha'))

    await act(async () => undefined)

    act(() => pinSession('s1'))
    h.emitState(makeState({ scope: { ...noScope } }))
    expect($pinnedSessionIds.get()).toEqual([])

    act(() => pinSession('x1'))
    h.emitState(ready('Alpha'))
    expect($pinnedSessionIds.get()).toEqual(['s1'])
  })

  it('persists each scope under its own storage key', async () => {
    const h = install(ready('Alpha'))

    await act(async () => undefined)

    act(() => pinSession('s1'))
    h.emitState(ready('Beta'))
    act(() => pinSession('b1'))

    const keys = Object.keys(window.localStorage).filter(key => key.includes('scope.'))

    expect(keys).toHaveLength(2)
    expect(new Set(keys.map(key => window.localStorage.getItem(key)))).toEqual(
      new Set([JSON.stringify(['s1']), JSON.stringify(['b1'])])
    )
  })
})

describe('variant gates are pinned at their source', () => {
  const root = resolve(__dirname, '..')
  const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n')

  it('the sidebar gates messaging, cron, blank state and profile rail under $degramEnabled', () => {
    const sidebar = read('app/chat/sidebar/index.tsx')

    expect(sidebar).toContain('degramSidebarNav(t.degram.nav)')
    expect(sidebar).toContain('!degramEnabled &&\n              messagingGroups.map')
    expect(sidebar).toMatch(/!worktreeGroupingActive && !degramEnabled && showsAdvancedChrome && cronJobs\.length > 0/)
    expect(sidebar).toContain('!showSessionSections && !degramEnabled && <SidebarBlankState')
    expect(sidebar).toContain('profileRailVisible && !degramEnabled')
    expect(sidebar).toContain("const agentsGrouped = !degramEnabled && grouping === 'project'")
  })

  it('the shell host lands a ready scope on the DG page and the pill opens the chat', () => {
    const host = read('degram/shell-host.tsx')

    expect(host).toContain('requestFreshSession({ preserveRoute: true })')
    expect(host).toContain('navigateToWorkspacePage(navigate, DG_PAGE_PATH)')
    expect(host).toContain('handleNewScope(state, opts, actions.showRing)')
    expect(host).toContain('actions.startNewChat')
    expect(read('app/contrib/wiring.tsx')).toContain('$freshSessionPreserveRoute.get()')
  })
})
