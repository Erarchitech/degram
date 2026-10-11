// models-page.test.tsx — the DeGram «Модели» screen (Phase 1301-35, D-43): per connector its status and the documents
// it exposes, with pin / unpin / refresh and the pinned state (one document per bridge, D-29). The strip keeps only the
// statuses. The picker's behaviour suite (D-29, unpin, empty state, search) lives in chat.test.tsx against this page.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contributedRoutes } from '@/app/routes'
import { registry } from '@/contrib'
import { I18nProvider } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile } from '@/store/profile'
import { stubMenuDomApis } from '@/test/jsdom'

import { ConnectedScopeStrip } from './connected-scope-strip'
import { $documents, pinRow, resetDocuments } from './documents-store'
import { ModelsPage } from './models-page'
import { registerDgPage } from './register-dg-page'
import { DEGRAM_MODELS_PATH } from './sidebar-nav'
import { install, makeState, withActions } from './test-harness'
import { setDegramGatewayForTests } from './use-degram-gateway'
import { resetDegramStore } from './use-degram-state'

type Handler = (params: Record<string, any>) => unknown

const READY = { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null } as const

const REVIT_ROW = {
  app: 'revit',
  name: 'Tower.rvt',
  path: 'C:\\Projects\\Tower.rvt',
  unsaved: false,
  identity: { creationGuid: 'aaaaaaaa-1111-2222', pathName: 'C:\\Projects\\Tower.rvt' },
  pinned: false
}

const GH_ROW = {
  app: 'grasshopper',
  name: 'tower.gh',
  path: 'C:/work/tower.gh',
  unsaved: false,
  identity: { documentId: '11111111-aaaa-bbbb', filePath: 'C:/work/tower.gh' },
  pinned: false
}

const group = (app: string, state: string, documents: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 'ok',
  groups: [{ app, state, documents, ...extra }],
  pinned: {}
})

function fakeGateway(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Record<string, any> }> = []

  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params: params as Record<string, any> })
    const handler = handlers[method]

    if (!handler) {
      throw new Error(`unexpected RPC ${method}`)
    }

    return handler(params as Record<string, any>)
  })

  setDegramGatewayForTests(request as never)

  return { calls, count: (method: string) => calls.filter(c => c.method === method).length }
}

/** A scripted backend with one pin per bridge (D-29): `list` reports the pins, `pin` and `unpin` change them. */
const bothBridges = (over: Record<string, Handler> = {}): Record<string, Handler> => {
  const pins: Record<string, Record<string, unknown>> = {}

  return {
    'degram.documents.list': ({ app }) => {
      const row = app === 'revit' ? REVIT_ROW : GH_ROW
      const mine = { ...row, pinned: Boolean(pins[app]) }

      return { ...group(app, 'ready', [mine]), pinned: { ...pins } }
    },
    'degram.documents.pin': ({ app, identity }) => {
      pins[app] = { app, name: app === 'revit' ? REVIT_ROW.name : GH_ROW.name, path: null, unsaved: false, identity }

      return { status: 'ok', pinned: pins[app] }
    },
    'degram.documents.unpin': ({ app }) => {
      for (const key of app === null ? Object.keys(pins) : [app]) {
        delete pins[key]
      }

      return { status: 'ok', pinned: { ...pins } }
    },
    ...over
  }
}

const ready = async (project = 'Alpha', epoch = 1) => {
  const state = makeState({ scope: { ...READY, project, epoch } as never })
  const h = install(state)

  $activeGatewayProfile.set(READY.profile)
  h.emitState(state)
  await act(async () => undefined)

  return h
}

beforeEach(() => {
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  resetDegramStore()
  resetDocuments()
  setDegramGatewayForTests(null)
  $degramEnabled.set(false)
  $activeGatewayProfile.set('default')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('models page (D-43)', () => {
  it('has a route at /degram/models that the sidebar row opens', () => {
    const dispose = registerDgPage()

    try {
      expect(DEGRAM_MODELS_PATH).toBe('/degram/models')
      expect(contributedRoutes(registry.getArea('routes')).map(route => route.path)).toEqual(
        expect.arrayContaining(['/dg', DEGRAM_MODELS_PATH])
      )
    } finally {
      dispose()
    }

    expect(contributedRoutes(registry.getArea('routes')).map(route => route.path)).not.toContain(DEGRAM_MODELS_PATH)
  })

  it('shows the title and one section per connector with its status and the documents it exposes', async () => {
    await ready()
    const gw = fakeGateway(bothBridges())

    render(withActions(<ModelsPage />))

    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy()
    await screen.findByText('Tower.rvt')
    await screen.findByText('tower.gh')

    const revit = window.document.querySelector('[data-bridge="revit"]') as HTMLElement
    const gh = window.document.querySelector('[data-bridge="grasshopper"]') as HTMLElement

    expect(within(revit).getByText('Revit')).toBeTruthy()
    expect(within(revit).getByText('Tower.rvt')).toBeTruthy()
    expect(within(gh).getByText('Grasshopper')).toBeTruthy()
    expect(within(gh).getByText('tower.gh')).toBeTruthy()
    // Each section names its connector's status.
    expect(revit.querySelector('[data-bridge-state="ready"]')).toBeTruthy()
    expect(gh.querySelector('[data-bridge-state="ready"]')).toBeTruthy()
    // Two parallel per-bridge reads on mount, never one combined read.
    expect(gw.calls.filter(c => c.method === 'degram.documents.list').map(c => c.params)).toEqual(
      expect.arrayContaining([{ app: 'revit' }, { app: 'grasshopper' }])
    )
  })

  it('reads «Модели» and Russian status labels in Russian', async () => {
    await ready()
    fakeGateway(
      bothBridges({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? group('revit', 'ready', [REVIT_ROW])
            : group('grasshopper', 'off', [], { code: 'BRIDGE_OFF' })
      })
    )

    render(
      <I18nProvider configClient={null} initialLocale="ru">
        {withActions(<ModelsPage />)}
      </I18nProvider>
    )

    expect(screen.getByRole('heading', { name: 'Модели' })).toBeTruthy()
    await screen.findByText('Tower.rvt')
    await screen.findByText('выкл')
    expect(screen.getByText('готов')).toBeTruthy()
  })

  it('names an off connector and its diagnostic while the other connector stays usable', async () => {
    await ready()
    fakeGateway(
      bothBridges({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? group('revit', 'ready', [REVIT_ROW])
            : group('grasshopper', 'off', [], { code: 'BRIDGE_OFF' })
      })
    )

    render(withActions(<ModelsPage />))
    await screen.findByText('Tower.rvt')

    const gh = window.document.querySelector('[data-bridge="grasshopper"]') as HTMLElement

    expect(gh.querySelector('[data-bridge-state="off"]')).toBeTruthy()
    expect(within(gh).getByText(/Grasshopper isn't responding/)).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('pins on click and unpins per connector; the strip keeps only statuses and shows the pinned names', async () => {
    await ready()
    const gw = fakeGateway(bothBridges())

    render(withActions(<ModelsPage />))
    render(withActions(<ConnectedScopeStrip />))
    const row = (await screen.findByText('tower.gh')).closest('[role="option"]') as HTMLElement

    fireEvent.click(row)
    await waitFor(() => expect($documents.get().pinned.grasshopper?.name).toBe('tower.gh'))
    expect(gw.calls.find(c => c.method === 'degram.documents.pin')?.params).toEqual({
      app: 'grasshopper',
      identity: GH_ROW.identity
    })

    // The pinned state shows on the page (the unpin control) and in the strip's bridge segment.
    const ghGroup = window.document.querySelector('[data-bridge="grasshopper"]') as HTMLElement

    expect(within(ghGroup).getByTestId('degram-unpin')).toBeTruthy()
    expect(window.document.querySelector('[data-bridge-status="pinned"]')?.textContent).toContain('tower.gh')

    fireEvent.click(within(ghGroup).getByTestId('degram-unpin'))
    await waitFor(() => expect(gw.count('degram.documents.unpin')).toBe(1))
    expect($documents.get().pinned).toEqual({})
  })

  it('keeps the page open after Unpin (it is a screen, not a popover)', async () => {
    await ready()
    fakeGateway(bothBridges())

    render(withActions(<ModelsPage />))
    await screen.findByText('tower.gh')
    await act(async () => {
      await pinRow(GH_ROW as never)
    })

    const ghGroup = window.document.querySelector('[data-bridge="grasshopper"]') as HTMLElement

    fireEvent.click(within(ghGroup).getByTestId('degram-unpin'))
    await waitFor(() => expect($documents.get().pinned).toEqual({}))
    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy()
    expect(screen.getByText('tower.gh')).toBeTruthy()
  })

  it('re-reads every connector from the refresh button', async () => {
    await ready()
    const gw = fakeGateway(bothBridges())

    render(withActions(<ModelsPage />))
    await screen.findByText('tower.gh')
    const before = gw.count('degram.documents.list')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh the document list' }))
    await waitFor(() => expect(gw.count('degram.documents.list')).toBe(before + 2))
  })

  it('shows the empty state with its instructions when no connector has an open document', async () => {
    await ready()
    fakeGateway(bothBridges({ 'degram.documents.list': ({ app }) => group(app, 'ready', []) }))

    render(withActions(<ModelsPage />))

    expect(await screen.findByText('No open documents')).toBeTruthy()
    expect(screen.getByText(/Open a model in Revit 2024 or a definition in Grasshopper/)).toBeTruthy()
  })

  it('without a ready project shows the project choice and reads nothing from a bridge', async () => {
    const h = install(makeState())
    const gw = fakeGateway(bothBridges())

    await act(async () => undefined)
    render(withActions(<ModelsPage />))

    expect(screen.getByTestId('degram-first-screen')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Models' })).toBeNull()
    expect(gw.count('degram.documents.list')).toBe(0)
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
  })

  it('never shows the documents of the scope that was left (documents-store is scope-tagged, T-1301-35-02)', async () => {
    const h = await ready('Alpha', 1)

    fakeGateway(bothBridges())
    render(withActions(<ModelsPage />))
    await screen.findByText('tower.gh')

    const next = makeState({ scope: { ...READY, project: 'Beta', epoch: 2 } as never })

    // The next scope's reads never answer: the page must not keep painting Alpha's rows meanwhile.
    fakeGateway({ 'degram.documents.list': () => new Promise(() => undefined) })
    h.emitState(next)
    await act(async () => undefined)

    expect(screen.queryByText('tower.gh')).toBeNull()
    expect(screen.queryByText('Tower.rvt')).toBeNull()
  })
})

describe('scope strip without the document segment (D-43)', () => {
  it('shows company, project and both bridge statuses and no document segment', async () => {
    await ready()
    fakeGateway(bothBridges())

    render(withActions(<ConnectedScopeStrip />))
    await waitFor(() => expect(window.document.querySelectorAll('[data-bridge-status="ready"]')).toHaveLength(2))

    const strip = screen.getByTestId('degram-scope-strip')

    expect(within(strip).getByText('Acme')).toBeTruthy()
    expect(within(strip).getByRole('button', { name: 'Project: Alpha' })).toBeTruthy()
    expect(within(strip).getByText('Revit')).toBeTruthy()
    expect(within(strip).getByText('Grasshopper')).toBeTruthy()
    expect(within(strip).queryByRole('button', { name: /^Document:/ })).toBeNull()
    expect(within(strip).queryByText('Select document')).toBeNull()
    expect(within(strip).queryByText(/^Documents: \d+/)).toBeNull()
  })

  it('shows no «Документы: n» in Russian either, with a document pinned', async () => {
    await ready()
    fakeGateway(bothBridges())

    render(
      <I18nProvider configClient={null} initialLocale="ru">
        {withActions(<ConnectedScopeStrip />)}
      </I18nProvider>
    )
    await waitFor(() => expect(window.document.querySelectorAll('[data-bridge-status="ready"]')).toHaveLength(2))
    await act(async () => {
      await pinRow(GH_ROW as never)
    })
    await waitFor(() => expect(window.document.querySelector('[data-bridge-status="pinned"]')).toBeTruthy())

    const strip = screen.getByTestId('degram-scope-strip')

    expect(within(strip).queryByText(/Документы: \d+/)).toBeNull()
    expect(within(strip).queryByText('Выбрать документ')).toBeNull()
    // The pinned name still shows in the connector's own segment.
    expect(window.document.querySelector('[data-bridge-status="pinned"]')?.textContent).toContain('tower.gh')
  })
})
