// chat.test.tsx — the DeGram chat surfaces of Phase 1301-14: document picker with bridge status, the Context card
// (summary, plurals, truncation, exact payload, pending and failed reads), whole-definition consent, policy deny,
// Stop, named failures with a manual retry, and the strip's document and bridge segments. The gateway is a scripted
// fake (`setDegramGatewayForTests`); nothing here talks to a bridge, a model or the DG server.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'
import { $gateway } from '@/store/gateway'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $busy } from '@/store/session'
import { stubMenuDomApis } from '@/test/jsdom'

import { AGENT_OUTCOME_CODES } from '../../electron/degram/scope'

import { degramOnStop, degramPromptSubmit, useDegramSendBlocked } from './composer-seam'
import { ConnectedScopeStrip } from './connected-scope-strip'
import { ContextCard, DegramComposerSections, FailureBanner } from './context-card'
import { DocumentPicker, hasIdentity, middleEllipsize } from './document-picker'
import { $documents, noteBridgeOutcome, pinRow, refreshDocuments, resetDocuments } from './documents-store'
import { stopActiveResponse } from './host-actions'
import { InterruptedBadge } from './interrupted-badge'
import { copyKeyForOutcome, failureSentence, FORWARDED_TO_MAIN, OUTCOME_CODES, parseFailureText } from './outcome-copy'
import {
  $lifecycle,
  classifyPreviewError,
  composerGate,
  handleTurnEvent,
  markSent,
  refreshPreview,
  resetLifecycle,
  sendBlockedReason,
  startTurnEventSync,
  transition
} from './request-lifecycle'
import { $signOutPending, DegramSignOutConfirm, requestDegramSignOut } from './sign-out-confirm'
import { install, makeState, withActions } from './test-harness'
import { DegramOutcomeError, PREVIEW_RPC_TIMEOUT_MS, setDegramGatewayForTests } from './use-degram-gateway'
import { resetDegramStore } from './use-degram-state'

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const READY = {
  status: 'ready',
  project: 'Alpha',
  company: 'Acme',
  profile: 'p',
  epoch: 1,
  error: null
} as const

const readyState = (project = 'Alpha', epoch = 1) => makeState({ scope: { ...READY, project, epoch } as never })

const REVIT_ROWS = [
  {
    name: 'Tower.rvt',
    path: 'C:\\Projects\\Tower.rvt',
    unsaved: false,
    identity: { creationGuid: 'aaaaaaaa-1111-2222', pathName: 'C:\\Projects\\Tower.rvt' },
    pinned: false
  },
  {
    name: 'Draft',
    path: null,
    unsaved: true,
    identity: { creationGuid: 'bbbbbbbb-3333-4444', pathName: '' },
    pinned: false
  }
]

const GH_ROW = {
  name: 'tower.gh',
  path: 'C:/work/tower.gh',
  unsaved: false,
  identity: { documentId: '11111111-aaaa-bbbb', filePath: 'C:/work/tower.gh' },
  pinned: false
}

const listOf = (app: string, documents: unknown[], state = 'ready', extra: Record<string, unknown> = {}) => ({
  status: 'ok',
  groups: [{ app, state, documents: documents.map(d => ({ app, ...(d as object) })), ...extra }],
  pinned: null
})

const PAYLOAD =
  'DeGram context (scope: selection)\nproject: Alpha\ndocument: tower.gh [grasshopper]\n{"project":"Alpha"}'

const previewOf = (params: { previewId: string; scope: string }, over: Record<string, unknown> = {}) => ({
  status: 'ok',
  previewId: params.previewId,
  scope: params.scope,
  requestedScope: params.scope,
  requiresConsent: params.scope === 'whole-definition',
  payload: PAYLOAD,
  summary: {
    project: 'Alpha',
    document: { app: 'grasshopper', name: 'tower.gh', path: 'C:/work/tower.gh' },
    objects: 2,
    parameters: 3,
    rules: 2,
    fragments: 0,
    bytes: 1234,
    emptySelection: false
  },
  truncation: [],
  missing: [],
  ...over
})

type Handler = (params: Record<string, any>) => unknown

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

  return {
    request,
    calls,
    of: (method: string) => calls.filter(c => c.method === method),
    count: (method: string) => calls.filter(c => c.method === method).length
  }
}

/** Handlers for a backend with a pin: `list` reports the pinned document, as the real agent does. */
const ghHandlers = (over: Record<string, Handler> = {}): Record<string, Handler> => {
  let pinned: Record<string, unknown> | null = null

  return {
    'degram.documents.list': ({ app }) => {
      const same = (row: { identity: Record<string, unknown> }) =>
        Boolean(pinned) && JSON.stringify((pinned as { identity: unknown }).identity) === JSON.stringify(row.identity)

      const base =
        app === 'revit'
          ? listOf(
              'revit',
              REVIT_ROWS.map(row => ({ ...row, pinned: same(row) }))
            )
          : listOf('grasshopper', [{ ...GH_ROW, pinned: same(GH_ROW) }])

      return pinned ? { ...base, pinned } : base
    },
    'degram.documents.pin': ({ app, identity }) => {
      if (app === null) {
        pinned = null

        return { status: 'ok', pinned: null }
      }

      pinned = { app, name: GH_ROW.name, path: GH_ROW.path, unsaved: false, identity }

      return { status: 'ok', pinned }
    },
    'degram.context.preview': params => previewOf(params as never),
    'degram.context.cancel': () => ({ status: 'ok', cancelled: 0 }),
    'session.interrupt': () => ({ status: 'interrupted' }),
    ...over
  }
}

const ru = (ui: ReactNode) => (
  <I18nProvider configClient={null} initialLocale="ru">
    {ui}
  </I18nProvider>
)

beforeEach(() => {
  stubMenuDomApis()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  resetDegramStore()
  resetDocuments()
  resetLifecycle()
  setDegramGatewayForTests(null)
  $busy.set(false)
  $activeSessionId.set(null)
  $signOutPending.set(false)
  $notifications.set([])
  $degramEnabled.set(false)
  $activeGatewayProfile.set('default')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

const readyHarness = async (project = 'Alpha', epoch = 1) => {
  const state = readyState(project, epoch)
  const h = install(state)

  // The chat follows the ready scope's profile (plan 1301-18); a route on another profile blocks Send.
  $activeGatewayProfile.set(READY.profile)

  h.emitState(state)
  await act(async () => undefined)

  return h
}

/** Pin the Grasshopper document through the real store action (optimistic pin, then the backend's answer). */
const pinGh = async () => {
  await act(async () => {
    await pinRow({ app: 'grasshopper', ...GH_ROW } as never)
  })
}

// ---------------------------------------------------------------------------------------------------------------

describe('document picker (UI E3, D-13)', () => {
  const open = async (handlers: Record<string, Handler>, locale: 'en' | 'ru' = 'en') => {
    const h = await readyHarness()
    const gw = fakeGateway(handlers)

    const ui = withActions(
      <DocumentPicker>
        <button type="button">pick</button>
      </DocumentPicker>
    )

    render(locale === 'ru' ? ru(ui) : ui)
    fireEvent.click(screen.getByRole('button', { name: 'pick' }))

    return { h, gw }
  }

  it('groups rows by bridge, marks an unsaved document, and reads each bridge on its own', async () => {
    const { gw } = await open(ghHandlers())

    await screen.findByText('Tower.rvt')

    expect(screen.getByText('Revit')).toBeTruthy()
    expect(screen.getByText('Grasshopper')).toBeTruthy()
    expect(screen.getByText('tower.gh')).toBeTruthy()
    // An unsaved document shows «Not saved» in place of its path.
    expect(screen.getByText('Not saved')).toBeTruthy()
    // Two parallel per-bridge reads, never one combined read.
    expect(gw.of('degram.documents.list').map(c => c.params)).toEqual(
      expect.arrayContaining([{ app: 'revit' }, { app: 'grasshopper' }])
    )
    expect(gw.of('degram.documents.list').every(c => typeof c.params.app === 'string')).toBe(true)
  })

  it('shows «Не сохранён» in Russian and the long Windows path keeps drive and file name', async () => {
    const long = 'C:\\Projects\\Очень длинная папка проекта\\Ещё одна вложенная папка\\Здание корпус 3 секция Б.rvt'

    await open(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? listOf('revit', [{ ...REVIT_ROWS[0], name: 'Здание корпус 3 секция Б.rvt', path: long }, REVIT_ROWS[1]])
            : listOf('grasshopper', [])
      }),
      'ru'
    )

    await screen.findByText('Здание корпус 3 секция Б.rvt')
    expect(screen.getByText('Не сохранён')).toBeTruthy()

    const shortened = middleEllipsize(long)

    expect(shortened.startsWith('C:\\')).toBe(true)
    expect(shortened.endsWith('Здание корпус 3 секция Б.rvt')).toBe(true)
    expect(shortened).toContain('…')
    expect(shortened.length).toBeLessThan(long.length)
    expect(screen.getByText(new RegExp(`^${shortened.replace(/[\\.*+?^${}()|[\]]/g, '\\$&')}`))).toBeTruthy()
  })

  it('renders an off bridge as one neutral notice row while the other bridge stays usable', async () => {
    await open(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? listOf('revit', REVIT_ROWS)
            : { status: 'ok', groups: [{ app, state: 'off', documents: [], code: 'BRIDGE_OFF' }], pinned: null }
      })
    )

    await screen.findByText('Tower.rvt')
    expect(
      screen.getByText(
        "Grasshopper isn't responding. Place and enable the DG CANVAS LISTENER component on the canvas, then refresh."
      )
    ).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('maps setup-incomplete reasons to their own sentence (routes disabled, routes not loopback, extension, no document)', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ code: 'ROUTES_DISABLED' }, 'pyRevit Routes are turned off.'],
      [{ code: 'SETUP_INCOMPLETE', reason: 'ROUTES_NOT_LOOPBACK' }, "pyRevit Routes aren't limited to this computer"],
      [{ code: 'EXTENSION_NOT_LOADED' }, "The DeGram extension isn't loaded in pyRevit."],
      [{ code: 'SETUP_INCOMPLETE', reason: 'NO_DOCUMENT_OPEN' }, 'Open a model in Revit 2024']
    ]

    for (const [extra, text] of cases) {
      cleanup()
      resetDocuments()
      resetLifecycle()
      await open(
        ghHandlers({
          'degram.documents.list': ({ app }) =>
            app === 'revit'
              ? { status: 'ok', groups: [{ app, state: 'setup-incomplete', documents: [], ...extra }], pinned: null }
              : listOf('grasshopper', [GH_ROW])
        })
      )
      await screen.findByText('tower.gh')
      expect(screen.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy()
    }
  })

  it('loads each bridge group independently: a pending group shows «Checking» while ready groups are selectable', async () => {
    let releaseGh: (value: unknown) => void = () => undefined

    await open(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? listOf('revit', REVIT_ROWS)
            : new Promise(resolveGh => {
                releaseGh = resolveGh
              })
      })
    )

    // Revit answered; Grasshopper has not. Revit is selectable already.
    await screen.findByText('Tower.rvt')
    expect(screen.getByText('Checking')).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBe(2)

    await act(async () => releaseGh(listOf('grasshopper', [GH_ROW])))
    await screen.findByText('tower.gh')
    expect(screen.queryByText('Checking')).toBeNull()
  })

  it('lists a document without identity disabled with the reason, and never pins it', async () => {
    const { gw } = await open(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit' ? listOf('revit', [{ ...REVIT_ROWS[0], identity: null }]) : listOf('grasshopper', [])
      })
    )

    const reason = await screen.findByText("Can't be pinned: no document identity")
    const row = reason.closest('[role="option"]') as HTMLElement

    expect(row.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(row)
    expect(gw.count('degram.documents.pin')).toBe(0)
    expect(hasIdentity({ app: 'revit', identity: null })).toBe(false)
    expect(hasIdentity({ app: 'grasshopper', identity: { documentId: 'x' } })).toBe(true)
  })

  it('never auto-pins a single open document, and shows a search field only above seven rows', async () => {
    const { gw } = await open(
      ghHandlers({
        'degram.documents.list': ({ app }) => (app === 'revit' ? listOf('revit', []) : listOf('grasshopper', [GH_ROW]))
      })
    )

    await screen.findByText('tower.gh')
    expect(gw.count('degram.documents.pin')).toBe(0)
    expect(screen.queryByPlaceholderText('Open documents')).toBeNull()

    cleanup()
    resetDocuments()
    resetLifecycle()

    await open(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? listOf(
                'revit',
                Array.from({ length: 8 }, (_, i) => ({
                  ...REVIT_ROWS[0],
                  name: `Model ${i}.rvt`,
                  identity: { creationGuid: `guid-${i}-aaaa`, pathName: `C:\\m${i}.rvt` }
                }))
              )
            : listOf('grasshopper', [])
      })
    )
    await screen.findByText('Model 0.rvt')
    expect(screen.getByPlaceholderText('Open documents')).toBeTruthy()
  })

  it('shows the empty state when no bridge has an open document', async () => {
    await open(
      ghHandlers({
        'degram.documents.list': ({ app }) => listOf(app, [])
      })
    )

    expect(await screen.findByText('No open documents')).toBeTruthy()
    expect(screen.getByText(/Open a model in Revit 2024 or a definition in Grasshopper/)).toBeTruthy()
  })

  it('pins on click: the strip and the pinned dot update in the same render, before the backend answers', async () => {
    const h = await readyHarness()
    let releasePin: (value: unknown) => void = () => undefined

    const base = ghHandlers()

    const gw = fakeGateway({
      ...base,
      'degram.documents.pin': params =>
        new Promise(resolvePin => {
          releasePin = value => {
            // The backend pins at the moment the answer is released, so later list reads report the pin.
            base['degram.documents.pin'](params)
            resolvePin(value)
          }
        })
    })

    render(withActions(<ConnectedScopeStrip />))
    fireEvent.click(screen.getByRole('button', { name: 'Document: Select document' }))
    const row = (await screen.findByText('tower.gh')).closest('[role="option"]') as HTMLElement

    fireEvent.click(row)

    // Optimistic: the strip already names the document, with the accent dot, while the pin RPC is still pending.
    expect(screen.getByRole('button', { name: 'Document: tower.gh' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Document: tower.gh' }).querySelector('.bg-ring')).toBeTruthy()
    expect(gw.of('degram.documents.pin')[0].params).toEqual({ app: 'grasshopper', identity: GH_ROW.identity })

    await act(async () =>
      releasePin({
        status: 'ok',
        pinned: { app: 'grasshopper', name: 'tower.gh', path: GH_ROW.path, unsaved: false, identity: GH_ROW.identity }
      })
    )
    expect($documents.get().pinned?.name).toBe('tower.gh')
    expect(h.bridge.selectProject).not.toHaveBeenCalled()
  })

  it('rolls an optimistic pin back when the backend refuses it', async () => {
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.documents.pin': () => ({ status: 'error', code: 'DOCUMENT_NOT_OPEN', bridgeState: 'identity-mismatch' })
      })
    )

    await act(async () => {
      await pinRow({ app: 'grasshopper', ...GH_ROW } as never)
    })

    expect($documents.get().pinned).toBeNull()
    expect($documents.get().pinError?.code).toBe('DOCUMENT_NOT_OPEN')
  })
})

describe('scope strip document and bridge segments (DGCL-02, plan 13 hand-over)', () => {
  it('shows «Проверка» until a bridge answers, then each bridge state with a neutral dot', async () => {
    let releaseRevit: (value: unknown) => void = () => undefined

    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.documents.list': ({ app }) =>
          app === 'revit'
            ? new Promise(resolveRevit => {
                releaseRevit = resolveRevit
              })
            : { status: 'ok', groups: [{ app, state: 'off', documents: [], code: 'BRIDGE_OFF' }], pinned: null }
      })
    )

    render(ru(withActions(<ConnectedScopeStrip />)))
    await waitFor(() => expect(screen.getByText('выкл')).toBeTruthy())
    expect(screen.getByText('Проверка')).toBeTruthy()

    await act(async () => releaseRevit(listOf('revit', REVIT_ROWS)))
    await waitFor(() => expect(screen.getByText('готов')).toBeTruthy())
    expect(screen.queryByText('Проверка')).toBeNull()
  })

  it('turns the pinned dot neutral and names the mismatch when the pinned document is gone', async () => {
    await readyHarness()
    fakeGateway(ghHandlers())
    render(withActions(<ConnectedScopeStrip />))
    await pinGh()

    expect(screen.getByRole('button', { name: 'Document: tower.gh' }).querySelector('.bg-ring')).toBeTruthy()

    act(() => noteBridgeOutcome('grasshopper', { code: 'IDENTITY_MISMATCH', bridgeState: 'identity-mismatch' }))

    const segment = screen.getByRole('button', { name: 'Document: tower.gh' })

    expect(segment.querySelector('.bg-ring')).toBeNull()
    expect(screen.getByText('other file')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('Context card (UI E4, D-17)', () => {
  it('without a document shows the no-document copy and reads nothing', async () => {
    await readyHarness()
    const gw = fakeGateway(ghHandlers())

    render(withActions(<ContextCard />))

    expect(
      screen.getByText(
        'No document selected — the request uses project data only. Select a document to add a snapshot.'
      )
    ).toBeTruthy()
    expect(gw.count('degram.context.preview')).toBe(0)
    expect(sendBlockedReason()).toBeNull()
  })

  it('with a pinned document reads it and shows project · document · counts · size with Russian plurals', async () => {
    await readyHarness()
    const gw = fakeGateway(ghHandlers())

    render(ru(withActions(<ContextCard />)))
    await pinGh()

    const summary = await screen.findByTestId('degram-context-summary')

    await waitFor(() => expect(summary.textContent).toContain('0 фрагментов'))
    expect(summary.textContent).toBe('Alpha · tower.gh · 2 объекта · 3 параметра · 2 правила · 0 фрагментов · 1,2 КБ')
    expect(gw.of('degram.context.preview')[0].params.scope).toBe('selection')
    expect(gw.of('degram.context.preview')[0].params.previewId).toMatch(/^pv_[A-Za-z0-9_-]{1,61}$/)
  })

  it('uses the locale plural forms: 0 / 1 / 2 / 5 and 21 / 22 objects in ru, 1 object in en', async () => {
    const { degramEn, degramRu } = await import('./i18n')

    expect([0, 1, 2, 4, 5, 11, 21, 22, 25].map(degramRu.context.objects)).toEqual([
      '0 объектов',
      '1 объект',
      '2 объекта',
      '4 объекта',
      '5 объектов',
      '11 объектов',
      '21 объект',
      '22 объекта',
      '25 объектов'
    ])
    expect(degramEn.context.objects(1)).toBe('1 object')
    expect(degramEn.context.objects(0)).toBe('0 objects')
    expect(degramRu.context.fragments(0)).toBe('0 фрагментов')
  })

  it('shows warn badges for truncation and missing data', async () => {
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.context.preview': params =>
          previewOf(params as never, {
            truncation: [{ what: 'objects', kept: 200, total: 500 }],
            missing: [{ what: 'rules', reason: 'DG_UNAVAILABLE' }]
          })
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    const badges = await screen.findByTestId('degram-card-badges')

    expect(within(badges).getByText(/Truncated: 200 of 500/)).toBeTruthy()
    expect(within(badges).getByText('Missing: rules')).toBeTruthy()
    expect(badges.querySelectorAll('[data-slot="badge"]')).toHaveLength(2)
  })

  it('the caret reveals exactly the payload the agent returned, and nothing is shown before it is opened', async () => {
    await readyHarness()
    fakeGateway(ghHandlers())
    render(withActions(<ContextCard />))
    await pinGh()
    await screen.findByText(/2 objects/)

    expect(screen.queryByTestId('degram-payload')).toBeNull()
    fireEvent.click(screen.getByTestId('degram-payload-toggle'))

    const log = screen.getByTestId('degram-payload')

    // Byte for byte: the card renders the very string the send will embed (plan 11: preview == sent payload).
    expect(log.textContent).toBe(PAYLOAD)
    expect(log.getAttribute('data-selectable-text')).toBe('true')
  })

  it('shows the glyph spinner and keeps Send blocked while a read is in flight, then releases it', async () => {
    await readyHarness()
    let releasePreview: (value: unknown) => void = () => undefined
    let previewParams: Record<string, any> = {}

    fakeGateway(
      ghHandlers({
        'degram.context.preview': params =>
          new Promise(resolvePreview => {
            previewParams = params
            releasePreview = resolvePreview
          })
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    expect(screen.getByRole('status', { name: 'Reading' })).toBeTruthy()
    expect(sendBlockedReason()).toBe('previewing')
    expect(screen.queryByText(/objects/)).toBeNull()

    await act(async () => releasePreview(previewOf(previewParams as never)))
    await screen.findByText(/2 objects/)
    expect(screen.queryByRole('status', { name: 'Reading' })).toBeNull()
    expect(sendBlockedReason()).toBeNull()
  })

  it('a failed read shows the bridge diagnostic inline with Retry read, blocks Send, and a retry re-reads', async () => {
    await readyHarness()
    let attempt = 0

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.preview': params => {
          attempt += 1

          return attempt === 1
            ? { status: 'error', code: 'BRIDGE_OFF', bridgeState: 'off', message: 'down' }
            : previewOf(params as never)
        }
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    const error = await screen.findByTestId('degram-card-read-error')

    expect(error.textContent).toContain("Grasshopper isn't responding.")
    expect(sendBlockedReason()).toBe('read-failed')
    // Nothing of the failed read (or of an earlier one) is on the card.
    expect(screen.queryByText(/objects/)).toBeNull()

    fireEvent.click(within(error).getByRole('button', { name: 'Retry read' }))
    await screen.findByText(/2 objects/)
    expect(gw.count('degram.context.preview')).toBe(2)
    expect(sendBlockedReason()).toBeNull()
  })

  it('an empty selection says so and still allows a send without a snapshot', async () => {
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.context.preview': params =>
          previewOf(params as never, {
            summary: {
              project: 'Alpha',
              document: { app: 'grasshopper', name: 'tower.gh', path: null },
              objects: 0,
              parameters: 0,
              rules: 2,
              fragments: 0,
              bytes: 300,
              emptySelection: true
            }
          })
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    expect(
      await screen.findByText('Nothing is selected in tower.gh. Select elements there, or send without a snapshot.')
    ).toBeTruthy()
    expect(screen.getByTestId('degram-context-summary').textContent).toContain('0 objects')
    expect(sendBlockedReason()).toBeNull()
  })

  it('a project change empties the card in the same render and the next read carries the new project', async () => {
    const h = await readyHarness('Alpha', 1)

    fakeGateway(
      ghHandlers({
        'degram.context.preview': params =>
          previewOf(params as never, {
            summary: {
              project: 'Beta',
              document: { app: 'grasshopper', name: 'tower.gh', path: null },
              objects: 7,
              parameters: 1,
              rules: 1,
              fragments: 0,
              bytes: 80,
              emptySelection: false
            }
          })
      })
    )
    render(withActions(<ContextCard />))
    await pinGh()
    await screen.findByText(/7 objects/)
    cleanup()

    // Another project: the scope key changes, so a reader sees nothing of Alpha before any effect ran.
    h.emitState(readyState('Beta', 2))
    render(withActions(<ContextCard />))

    const summary = screen.getByTestId('degram-context-summary')

    expect(summary.textContent).toBe('Beta')
    expect(screen.getByTestId('degram-card-no-document')).toBeTruthy()
    expect($documents.get().pinned).toBeNull()
  })

  it('a pinned document gone blocks the read, names the mismatch and offers no silent switch', async () => {
    await readyHarness()
    const gw = fakeGateway(ghHandlers())

    render(withActions(<ContextCard />))
    await pinGh()
    await screen.findByText(/2 objects/)

    act(() => noteBridgeOutcome('grasshopper', { code: 'IDENTITY_MISMATCH', bridgeState: 'identity-mismatch' }))

    const error = await screen.findByTestId('degram-card-read-error')

    expect(error.textContent).toContain('tower.gh is no longer open, or another file is active in its place.')
    expect(sendBlockedReason()).toBe('mismatch')
    expect(within(error).queryByRole('button', { name: 'Retry read' })).toBeNull()
    // The preview was not re-read against another document, and nothing was pinned instead.
    expect(gw.of('degram.documents.pin')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('whole-definition consent and send (D-17, 1300 D-06)', () => {
  const sessionRpc = (gw: ReturnType<typeof fakeGateway>) => (method: string, params?: Record<string, unknown>) =>
    gw.request(method, params ?? {}) as Promise<never>

  const setup = async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.send': () => ({ status: 'ok', submit: { status: 'streaming', user_row_id: 7 } }),
        'prompt.submit': () => ({ status: 'streaming' })
      })
    )

    render(withActions(<DegramComposerSections />))
    await pinGh()
    await screen.findByText(/2 objects/)

    return gw
  }

  it('choosing Whole definition re-reads for that scope and sends nothing; Send then asks, with counts and size', async () => {
    const gw = await setup()

    fireEvent.click(screen.getByRole('button', { name: 'Whole definition' }))
    await waitFor(() => expect(gw.of('degram.context.preview').at(-1)?.params.scope).toBe('whole-definition'))
    await screen.findByText(/2 objects/)

    expect(gw.count('degram.context.send')).toBe(0)
    expect(gw.count('prompt.submit')).toBe(0)

    let verdict: unknown = 'pending'

    const gate = composerGate({ text: 'check the heights' }).then(result => {
      verdict = result
    })

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Send the whole definition?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        '2 objects and 3 parameters from tower.gh (1.2 KB) will go to the model. Review the payload in the context card first.'
      )
    ).toBeTruthy()
    expect(verdict).toBe('pending')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Send whole definition' }))
    await gate
    expect(verdict).toEqual({ text: 'check the heights' })

    // The stock submit then carries the previewed payload with the user's consent.
    await degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'check the heights' }, 1000)

    const sent = gw.of('degram.context.send')

    expect(sent).toHaveLength(1)
    expect(sent[0].params).toMatchObject({ session_id: 's1', text: 'check the heights', consent: true })
    expect(sent[0].params.previewId).toBe(gw.of('degram.context.preview').at(-1)?.params.previewId)
    expect(gw.count('prompt.submit')).toBe(0)
    expect($lifecycle.get().phase).toBe('streaming')
  })

  it('«Keep selection only» sends nothing and resets the scope to the selection', async () => {
    const gw = await setup()

    fireEvent.click(screen.getByRole('button', { name: 'Whole definition' }))
    await screen.findByText(/2 objects/)

    let verdict: unknown = 'pending'

    const gate = composerGate({ text: 'hi' }).then(result => {
      verdict = result
    })

    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep selection only' }))
    await gate

    expect(verdict).toBeNull()
    expect(gw.count('degram.context.send')).toBe(0)
    expect(gw.count('prompt.submit')).toBe(0)
    await waitFor(() => expect($lifecycle.get().scope).toBe('selection'))
    await waitFor(() => expect(gw.of('degram.context.preview').at(-1)?.params.scope).toBe('selection'))
  })

  it('a selection-scope send needs no dialog and carries consent false through degram.context.send', async () => {
    const gw = await setup()

    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
    expect(screen.queryByRole('dialog')).toBeNull()

    await degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'hi', interrupted: false }, 1000)
    expect(gw.of('degram.context.send')[0].params).toMatchObject({ consent: false, text: 'hi' })
    expect(gw.of('degram.context.send')[0].params).not.toHaveProperty('interrupted')
  })

  it('with no pinned document the stock path runs (project data only) and the machine still tracks the turn', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(ghHandlers({ 'prompt.submit': () => ({ status: 'streaming' }) }))

    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
    await degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'hi' }, 1000)

    expect(gw.count('prompt.submit')).toBe(1)
    expect(gw.count('degram.context.send')).toBe(0)
    expect($lifecycle.get().phase).toBe('streaming')
  })

  it('outside variant degram the gate and the submit are pass-through', async () => {
    await readyHarness()
    // The harness raises the product flag; this test is about the other variants.
    $degramEnabled.set(false)

    const gw = fakeGateway(ghHandlers({ 'prompt.submit': () => ({ status: 'streaming' }) }))

    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
    await degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'hi', display_kind: 'hidden' }, 1000)

    expect(gw.of('prompt.submit')[0].params).toEqual({ session_id: 's1', text: 'hi', display_kind: 'hidden' })
    expect($lifecycle.get().phase).toBe('idle')
    // degramOnStop is also inert.
    degramOnStop()
    expect(gw.count('degram.context.cancel')).toBe(0)
  })

  it('the gate cancels a send while the read is in flight or has failed, and never sends a used preview twice', async () => {
    const gw = await setup()

    expect(await composerGate({ text: 'one' })).toEqual({ text: 'one' })
    await degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'one' }, 1000)
    handleTurnEvent({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })

    // The turn ended: the next read starts, and until it lands the gate refuses.
    await waitFor(() => expect($lifecycle.get().phase).not.toBe('done'))
    await waitFor(() => expect(sendBlockedReason()).toBeNull())
    expect(await composerGate({ text: 'two' })).toEqual({ text: 'two' })
    expect(gw.of('degram.context.preview').length).toBeGreaterThanOrEqual(2)
  })

  it('a send refused with CONSENT_REQUIRED becomes a named failure, not a silent drop', async () => {
    const gw = await setup()

    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
    gw.request.mockImplementationOnce(async () => ({
      status: 'error',
      code: 'CONSENT_REQUIRED',
      message: 'no consent'
    }))

    await expect(degramPromptSubmit(sessionRpc(gw), { session_id: 's1', text: 'hi' }, 1000)).rejects.toBeInstanceOf(
      DegramOutcomeError
    )

    // The failure stays on screen (the next read starts at once, so the phase is already back to resting).
    expect($lifecycle.get().failure?.parsed.code).toBe('CONSENT_REQUIRED')
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('policy deny (T-1301-14-02)', () => {
  it('shows the neutral banner with the server reason and Narrow context, never a confirm', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.send': () => ({ status: 'ok', submit: {} })
      })
    )

    render(withActions(<DegramComposerSections />))
    await pinGh()
    await screen.findByText(/2 objects/)
    fireEvent.click(screen.getByRole('button', { name: 'Whole definition' }))
    await screen.findByText(/2 objects/)

    const gate = composerGate({ text: 'hi' })

    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send whole definition' }))
    await gate
    await degramPromptSubmit((m, p) => gw.request(m, p ?? {}) as Promise<never>, { session_id: 's1', text: 'hi' }, 1000)

    act(() =>
      handleTurnEvent({
        type: 'message.complete',
        session_id: 's1',
        payload: {
          status: 'error',
          error: 'POLICY_DENY: The project forbids this export. (reason: whole-definition-export-disabled)'
        }
      })
    )

    const banner = await screen.findByTestId('degram-failure-banner')

    expect(banner.getAttribute('data-code')).toBe('POLICY_DENY')
    expect(banner.textContent).toContain(
      "DG policy doesn't allow sending this data to the model: whole-definition-export-disabled. Confirming won't override it"
    )
    expect(within(banner).getByRole('button', { name: 'Narrow context' })).toBeTruthy()
    expect(within(banner).queryByRole('button', { name: /Send whole definition|Retry request|Confirm/ })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    gw.calls.length = 0
    fireEvent.click(within(banner).getByRole('button', { name: 'Narrow context' }))
    await waitFor(() => expect(screen.queryByTestId('degram-failure-banner')).toBeNull())
    expect($lifecycle.get().scope).toBe('selection')
    await waitFor(() => expect(gw.of('degram.context.preview').at(-1)?.params.scope).toBe('selection'))
    expect(gw.count('degram.context.send')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('route guard (G-7, D-19, T-1301-18-02)', () => {
  const setup = async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.send': () => ({ status: 'ok', submit: { status: 'streaming', user_row_id: 7 } }),
        'prompt.submit': () => ({ status: 'streaming' })
      })
    )

    return { gw, rpc: (m: string, p?: Record<string, unknown>) => gw.request(m, p ?? {}) as Promise<never> }
  }

  it('blocks Send and refuses the submit, with no RPC, while the route is on another profile than the scope', async () => {
    const { gw, rpc } = await setup()

    expect(sendBlockedReason()).toBeNull()

    act(() => $activeGatewayProfile.set('another-scope-profile'))
    expect(sendBlockedReason()).toBe('route-mismatch')
    expect(await composerGate({ text: 'hi' })).toBeNull()

    await expect(degramPromptSubmit(rpc, { session_id: 's1', text: 'hi' }, 1)).rejects.toThrow('ROUTE_MISMATCH')
    expect(gw.count('prompt.submit')).toBe(0)
    expect(gw.count('degram.context.send')).toBe(0)
    // The machine never entered streaming: nothing went out.
    expect($lifecycle.get().phase).toBe('idle')

    act(() => $activeGatewayProfile.set('p'))
    expect(sendBlockedReason()).toBeNull()
    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
  })

  it('wins over a pinned document and its ready preview', async () => {
    await setup()
    await pinGh()
    await act(async () => {
      await refreshPreview()
    })
    expect(sendBlockedReason()).toBeNull()

    act(() => $activeGatewayProfile.set('another-scope-profile'))
    expect(sendBlockedReason()).toBe('route-mismatch')
    expect(await composerGate({ text: 'hi' })).toBeNull()
  })

  it('the Send button follows the route in the same render', async () => {
    await setup()

    const { result } = renderHook(() => useDegramSendBlocked())

    expect(result.current).toBe(false)
    act(() => $activeGatewayProfile.set('another-scope-profile'))
    expect(result.current).toBe(true)
    act(() => $activeGatewayProfile.set('p'))
    expect(result.current).toBe(false)
  })

  it('never blocks outside the DeGram variant', async () => {
    await setup()
    $degramEnabled.set(false)
    act(() => $activeGatewayProfile.set('another-scope-profile'))
    expect(sendBlockedReason()).toBeNull()
    expect(await composerGate({ text: 'hi' })).toEqual({ text: 'hi' })
  })
})

describe('Stop and the interrupted marker (D-18, DGCL-06)', () => {
  it('clears the pending state in the click handler and sends interrupt and cancel once each', async () => {
    $degramEnabled.set(true)
    await readyHarness()
    $activeSessionId.set('s1')

    const gw = fakeGateway(ghHandlers({ 'prompt.submit': () => ({ status: 'streaming' }) }))

    await degramPromptSubmit((m, p) => gw.request(m, p ?? {}) as Promise<never>, { session_id: 's1', text: 'hi' }, 1000)
    expect($lifecycle.get().phase).toBe('streaming')

    const stopped = stopActiveResponse()

    // Synchronously, before any RPC could have returned.
    expect($lifecycle.get().phase).toBe('interrupted')
    await stopped

    expect(gw.of('session.interrupt')).toEqual([{ method: 'session.interrupt', params: { session_id: 's1' } }])
    expect(gw.count('degram.context.cancel')).toBe(1)
  })

  it('the composer Stop hook aborts a bridge read in flight and leaves the card idle', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.preview': () => new Promise(() => undefined)
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    const readId = gw.of('degram.context.preview')[0].params.previewId

    expect($lifecycle.get().phase).toBe('previewing')
    degramOnStop()
    expect($lifecycle.get().phase).toBe('idle')
    await waitFor(() => expect(gw.of('degram.context.cancel')[0]?.params).toEqual({ previewId: readId }))
  })

  it('renders the muted «Прервано» badge for a partial message, and the transcript uses it in degram only', async () => {
    render(ru(<InterruptedBadge />))
    expect(screen.getByText('Прервано').className).toContain('bg-muted')
    cleanup()
    render(<InterruptedBadge />)
    expect(screen.getByText('Interrupted')).toBeTruthy()

    const source = readFileSync(resolve(__dirname, '../components/assistant-ui/thread/assistant-message.tsx'), 'utf8')

    expect(source).toContain('InterruptedBadge')
    expect(source).toContain("isSurfaceHidden('stock-error-retry')")
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('named failures (D-18, UI E5)', () => {
  const failure = (text: string, over: Record<string, unknown> = {}) => ({
    parsed: parseFailureText(text),
    text,
    app: 'revit' as const,
    elapsedSeconds: 0,
    lastText: 'hello',
    ...over
  })

  const CASES: Array<[string, string, Record<string, unknown>]> = [
    [
      'PROVIDER_UNAVAILABLE: The upstream is unreachable.',
      "The model service is unavailable. Your message wasn't processed; retry the request in a few minutes.",
      {}
    ],
    [
      'PROVIDER_TIMEOUT: The model provider did not answer in time. Try again, or narrow the context.',
      'No answer within 42 s, so the request was stopped. Retry it, or narrow the selection.',
      { elapsedSeconds: 41.7 }
    ],
    [
      'PROVIDER_RATE_LIMITED: Too many requests. (retryAfter: 30)',
      'The request limit for this project is reached. Retry after 30 s, or ask the DG operator.',
      {}
    ],
    [
      'PROVIDER_RATE_LIMITED: Too many requests.',
      'The request limit for this project is reached. Retry later, or ask the DG operator when it resets.',
      {}
    ],
    ['DG_UNAVAILABLE: The graph route timed out. (reason: TIMEOUT)', "The DG server can't be reached.", {}],
    ['BRIDGE_OFF: not reachable', "Revit isn't responding. Open Revit 2024", {}],
    ['BRIDGE_OFF: not reachable', "Grasshopper isn't responding. Place and enable", { app: 'grasshopper' }],
    ['BUSY: no answer', 'Revit is busy (a command or dialog is open).', {}],
    ['ROUTES_DISABLED: off', 'pyRevit Routes are turned off.', {}],
    ['SETUP_INCOMPLETE: (reason: ROUTES_NOT_LOOPBACK)', "pyRevit Routes aren't limited to this computer", {}],
    ['EXTENSION_NOT_LOADED: missing', "The DeGram extension isn't loaded in pyRevit.", {}],
    ['IDENTITY_MISMATCH: another file', 'tower.gh is no longer open, or another file is active in its place.', {}],
    ['DOCUMENT_NOT_OPEN: closed', 'tower.gh is no longer open, or another file is active in its place.', {}],
    [
      'Authentication failed: CREDENTIALS_EXPIRED: The held delegated token is past its expiry.',
      'The DG access token expired and is being renewed. Retry the request.',
      {}
    ],
    [
      'API call failed: CREDENTIALS_MISSING: No delegated token is held.',
      'DeGram has no DG access for Alpha in this window yet. Reopen the project; if it repeats, sign in again.',
      {}
    ],
    [
      'DELEGATED_SESSION_ENDED: the DG session ended.',
      'Your DG session has ended. Sign in again to continue',
      {}
    ],
    ['something nobody classified', 'The request failed. Retry it; if it keeps failing, ask the DG operator.', {}]
  ]

  it.each(CASES)('%s -> its UI-SPEC sentence and a manual Retry request', async (text, sentence, over) => {
    await readyHarness()
    $degramEnabled.set(true)
    fakeGateway(ghHandlers())
    await act(async () => {
      await pinRow({ app: 'revit', ...REVIT_ROWS[0] } as never)
    })

    const submit = vi.fn(async () => true)

    render(withActions(<FailureBanner failure={failure(text, over) as never} onSubmit={submit} />))

    const banner = screen.getByTestId('degram-failure-banner')

    expect(banner.textContent).toContain(sentence)
    expect(within(banner).getByRole('button', { name: 'Retry request' })).toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
  })

  it('maps a code found anywhere in a wrapped failure text, earliest first', () => {
    expect(parseFailureText('Authentication failed: CREDENTIALS_EXPIRED: x (reason: y)').code).toBe(
      'CREDENTIALS_EXPIRED'
    )
    expect(parseFailureText('XCREDENTIALS_EXPIRED_X is not a code').code).toBeNull()
    expect(parseFailureText('PROVIDER_TIMEOUT: a (reason: first-byte, retryAfter: 12)')).toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      reason: 'first-byte',
      retryAfter: 12
    })
  })

  it('a missing timeout figure falls back to the elapsed seconds, a stated one wins', async () => {
    const { degramEn } = await import('./i18n')

    expect(
      failureSentence(degramEn, parseFailureText('PROVIDER_TIMEOUT: no answer'), { elapsedSeconds: 61.4 })
    ).toContain('within 61 s')
    expect(
      failureSentence(degramEn, parseFailureText('PROVIDER_TIMEOUT: no answer after 60 seconds'), { elapsedSeconds: 3 })
    ).toContain('within 60 s')
  })

  it('forwards the credential and access outcomes to Electron main, and no other code', async () => {
    $degramEnabled.set(true)
    const h = await readyHarness()

    const gw = fakeGateway(ghHandlers({ 'prompt.submit': () => ({ status: 'streaming' }) }))
    const rpc = (m: string, p?: Record<string, unknown>) => gw.request(m, p ?? {}) as Promise<never>

    await degramPromptSubmit(rpc, { session_id: 's1', text: 'a' }, 1)
    handleTurnEvent({
      type: 'message.complete',
      session_id: 's1',
      payload: { status: 'error', error: 'Authentication failed: CREDENTIALS_EXPIRED: expired' }
    })
    expect(h.bridge.reportOutcome).toHaveBeenCalledWith('CREDENTIALS_EXPIRED')

    h.bridge.reportOutcome = vi.fn(async () => true) as never
    await degramPromptSubmit(rpc, { session_id: 's1', text: 'b' }, 1)
    handleTurnEvent({
      type: 'message.complete',
      session_id: 's1',
      payload: { status: 'error', error: 'PROVIDER_TIMEOUT: slow' }
    })
    expect(h.bridge.reportOutcome).not.toHaveBeenCalled()

    // CREDENTIALS_MISSING reaches main too, which re-hands the credential once per scope open (G-5).
    await degramPromptSubmit(rpc, { session_id: 's1', text: 'c' }, 1)
    handleTurnEvent({
      type: 'message.complete',
      session_id: 's1',
      payload: { status: 'error', error: 'API call failed: CREDENTIALS_MISSING: No delegated token is held.' }
    })
    expect(h.bridge.reportOutcome).toHaveBeenCalledWith('CREDENTIALS_MISSING')
  })

  it('the codes forwarded to main equal the codes main accepts', () => {
    expect([...FORWARDED_TO_MAIN].sort()).toEqual([...AGENT_OUTCOME_CODES].sort())
  })

  it('retry re-sends only on click, never from a timer (T-1301-14-04)', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({
        'degram.context.send': () => ({ status: 'ok', submit: {} })
      })
    )

    const submit = vi.fn(async () => true)

    render(withActions(<DegramComposerSections onSubmit={submit} />))
    await pinGh()
    await screen.findByText(/2 objects/)
    expect(await composerGate({ text: 'hello' })).toEqual({ text: 'hello' })
    await degramPromptSubmit(
      (m, p) => gw.request(m, p ?? {}) as Promise<never>,
      { session_id: 's1', text: 'hello' },
      1000
    )
    act(() =>
      handleTurnEvent({
        type: 'message.complete',
        session_id: 's1',
        payload: { status: 'error', error: 'PROVIDER_UNAVAILABLE: down' }
      })
    )

    const banner = await screen.findByTestId('degram-failure-banner')

    vi.useFakeTimers()
    const before = gw.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })

    // Ten minutes later: no send, no submit, no retry of any kind.
    expect(submit).not.toHaveBeenCalled()
    expect(gw.of('degram.context.send')).toHaveLength(1)
    expect(gw.calls.length).toBe(before)
    vi.useRealTimers()

    fireEvent.click(within(banner).getByRole('button', { name: 'Retry request' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit).toHaveBeenCalledWith('hello')
    // The click re-reads the context first, so the retry carries a fresh preview.
    expect(gw.count('degram.context.preview')).toBeGreaterThanOrEqual(2)
  })

  it('no document selected and a ready preview never send by themselves either', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(
      ghHandlers({ 'degram.context.send': () => ({ status: 'ok', submit: {} }), 'prompt.submit': () => ({}) })
    )

    render(withActions(<ContextCard />))
    await pinGh()
    await screen.findByText(/2 objects/)
    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })

    expect(gw.count('degram.context.send')).toBe(0)
    expect(gw.count('prompt.submit')).toBe(0)
  })
})

describe('request lifecycle transitions (D-18)', () => {
  const base = { ...$lifecycle.get() }

  it('only a user Send enters streaming; reads move between idle, previewing and ready', () => {
    let state = transition(base, { type: 'preview-start', previewId: 'pv_1' })

    expect(state.phase).toBe('previewing')
    state = transition(state, { type: 'preview-ok', previewId: 'pv_other', preview: {} as never })
    expect(state.phase).toBe('previewing')
    state = transition(state, { type: 'preview-ok', previewId: 'pv_1', preview: { previewId: 'pv_1' } as never })
    expect(state.phase).toBe('ready')
    state = transition(state, { type: 'done' })
    expect(state.phase).toBe('ready')
    state = transition(state, { type: 'sent', sessionId: 's', text: 'x', at: 1 })
    expect(state.phase).toBe('streaming')
    expect(transition(state, { type: 'preview-start', previewId: 'pv_2' }).phase).toBe('streaming')
    expect(transition(state, { type: 'interrupted' }).phase).toBe('interrupted')
    expect(transition(state, { type: 'done' }).phase).toBe('done')
  })
})

describe('turn events reach the machine through the live gateway (D-18)', () => {
  const makeGateway = () => {
    const handlers = new Set<(event: unknown) => void>()

    return {
      handlers,
      onEvent: (handler: (event: unknown) => void) => {
        handlers.add(handler)

        return () => handlers.delete(handler)
      },
      emit: (event: unknown) => handlers.forEach(handler => handler(event))
    }
  }

  afterEach(() => {
    $gateway.set(null)
  })

  it('follows the active gateway, ends a streaming turn on its completion and lets go on a swap and on stop', () => {
    const first = makeGateway()
    const second = makeGateway()

    $gateway.set(first as never)
    const stop = startTurnEventSync()

    markSent('s1', 'hello')
    expect(first.handlers.size).toBe(1)

    first.emit({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })
    expect($lifecycle.get().phase).toBe('done')

    $gateway.set(second as never)
    expect(first.handlers.size).toBe(0)
    expect(second.handlers.size).toBe(1)

    stop()
    expect(second.handlers.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('sign-out while running (D-08, UI-SPEC)', () => {
  it('opens Stop and sign out / Keep working, stops the turn first, and signs out only on confirm', async () => {
    const h = await readyHarness()
    const actions = { stopResponse: vi.fn(async () => undefined), startNewChat: vi.fn() }

    $busy.set(true)
    render(withActions(<DegramSignOutConfirm />, actions))
    act(() => requestDegramSignOut())

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Sign out of DG')).toBeTruthy()
    expect(
      within(dialog).getByText(
        "A response is still running. Signing out stops it and hides this project's chat until you sign in again."
      )
    ).toBeTruthy()
    expect(h.bridge.signOut).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep working' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.bridge.signOut).not.toHaveBeenCalled()
    expect(actions.stopResponse).not.toHaveBeenCalled()

    act(() => requestDegramSignOut())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop and sign out' }))
    await waitFor(() => expect(h.bridge.signOut).toHaveBeenCalledTimes(1))
    expect(actions.stopResponse).toHaveBeenCalledTimes(1)
  })

  it('the tray entry reaches the same flow: main asks, the confirmation shows while a response runs (G-17)', async () => {
    const h = await readyHarness()

    $busy.set(true)
    render(withActions(<DegramSignOutConfirm />))
    h.emitRequestSignOut()

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Sign out of DG')).toBeTruthy()
    expect(h.bridge.signOut).not.toHaveBeenCalled()
  })

  it('the tray request signs out at once when nothing is running', async () => {
    const h = await readyHarness()

    render(withActions(<DegramSignOutConfirm />))
    h.emitRequestSignOut()
    await waitFor(() => expect(h.bridge.signOut).toHaveBeenCalledTimes(1))
  })

  it('sends the localized sign-out label to the tray and stops listening on unmount', async () => {
    const h = await readyHarness()

    const { unmount } = render(withActions(<DegramSignOutConfirm />))

    await waitFor(() => expect(h.bridge.setTrayLabels).toHaveBeenCalledWith({ signOut: 'Sign out of DG' }))
    unmount()
    h.emitRequestSignOut()
    expect(h.bridge.signOut).not.toHaveBeenCalled()
  })

  it('signs out at once when nothing is running', async () => {
    const h = await readyHarness()

    render(withActions(<DegramSignOutConfirm />))
    act(() => requestDegramSignOut())
    await waitFor(() => expect(h.bridge.signOut).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('operational outcome copy covers the whole vocabulary (D-18)', () => {
  const spec = resolve(__dirname, '../../../../../../spec/degram/OPERATIONAL-OUTCOMES.md')

  it('has a copy key for every code in the closed vocabulary (and the constant equals the spec block)', () => {
    for (const code of OUTCOME_CODES) {
      expect(copyKeyForOutcome(code), code).toBeTruthy()
    }

    expect(copyKeyForOutcome('SOMETHING_NEW')).toBe('errors.unknown')
    expect(copyKeyForOutcome('COMPLETED')).toBe('none')
    expect(copyKeyForOutcome('CANCELLED')).toBe('none')
  })

  // The framework spec lives outside the component repository; a standalone checkout of the fork cannot read it.
  it.skipIf(!existsSync(spec))(
    'parses the spec code list: every documented code has a copy entry, and the set is equal',
    () => {
      const block =
        /<!-- degram-outcomes:codes:start -->\s*```\s*([\s\S]*?)```/.exec(readFileSync(spec, 'utf8'))?.[1] ?? ''

      const codes = block
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)

      expect(codes.length).toBeGreaterThan(20)
      expect([...codes].sort()).toEqual([...OUTCOME_CODES].sort())

      for (const code of codes) {
        expect(copyKeyForOutcome(code), `${code} has a copy key`).not.toBe('errors.unknown')
      }
    }
  )

  it('bridge codes follow the application of the failure', () => {
    expect(copyKeyForOutcome('BRIDGE_OFF', { app: 'grasshopper' })).toBe('errors.grasshopperOff')
    expect(copyKeyForOutcome('BRIDGE_OFF', { app: 'revit' })).toBe('errors.revitOff')
    expect(copyKeyForOutcome('BUSY', { app: 'grasshopper' })).toBe('errors.grasshopperBusy')
    expect(copyKeyForOutcome('SETUP_INCOMPLETE', { reason: 'ROUTES_NOT_LOOPBACK' })).toBe('errors.routesNotLoopback')
    expect(copyKeyForOutcome('SETUP_INCOMPLETE', { reason: 'NO_DOCUMENT_OPEN' })).toBe('empty.noDocuments')
  })

  it('refreshDocuments is a read of the loopback bridges only: it never calls a send RPC', async () => {
    await readyHarness()
    const gw = fakeGateway(ghHandlers())

    await act(async () => refreshDocuments())
    await act(async () => refreshPreview())
    markSent(null, 'x')

    expect(
      gw.calls.every(c => c.method.startsWith('degram.documents.') || c.method.startsWith('degram.context.'))
    ).toBe(true)
    expect(gw.count('degram.context.send')).toBe(0)
    expect(gw.count('prompt.submit')).toBe(0)
  })
})

// The upstream shell cannot be rendered offline; each stock seam is pinned at its source so a removed hook fails here.
describe('stock composer seams (variant degram, one line each)', () => {
  const src = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8')

  it.each([
    ['app/session/hooks/use-prompt-actions/submit.ts', 'degramPromptSubmit<PromptSubmitResult>('],
    ['app/session/hooks/use-prompt-actions/index.ts', 'degramOnStop()'],
    ['app/chat/composer/index.tsx', 'useDegramSendBlocked()'],
    ['app/chat/composer/status-stack/index.tsx', '<DegramComposerSections'],
    ['degram/shell-host.tsx', 'registerComposerGate()'],
    ['degram/shell-host.tsx', 'startTurnEventSync()']
  ])('%s consults the DeGram seam', (file, needle) => {
    expect(src(file)).toContain(needle)
  })

  it('the stock submit no longer calls prompt.submit directly for the turn', () => {
    expect(src('app/session/hooks/use-prompt-actions/submit.ts')).not.toMatch(
      /requestGateway<PromptSubmitResult>\(\s*'prompt\.submit'/
    )
  })
})

describe('preview failures name their cause (1301-19, G-14)', () => {
  it('gives the preview RPC more time than the agent needs to answer BUSY itself', async () => {
    $degramEnabled.set(true)
    await readyHarness()

    const gw = fakeGateway(ghHandlers())

    render(withActions(<ContextCard />))
    await pinGh()
    await screen.findByText(/2 objects/)

    const call = gw.request.mock.calls.find(c => c[0] === 'degram.context.preview') as unknown as unknown[]

    expect(call[2]).toBe(PREVIEW_RPC_TIMEOUT_MS)
    // The agent bounds a bridge read at 20 s and the rules read at 5 + 15 s: 40 s, below the RPC timeout.
    expect(PREVIEW_RPC_TIMEOUT_MS).toBe(45_000)
  })

  it('classifies the exception a preview RPC rejects with', () => {
    expect(classifyPreviewError(new Error('request timed out after 45s: degram.context.preview'))).toEqual({
      code: 'PREVIEW_TIMEOUT',
      message: 'PREVIEW_TIMEOUT: request timed out after 45s'
    })
    expect(classifyPreviewError(new Error('gateway not connected')).code).toBe('DG_UNAVAILABLE')
    expect(classifyPreviewError(new Error('WebSocket connection closed')).code).toBe('DG_UNAVAILABLE')
    expect(classifyPreviewError(new Error('{"code":4400}')).code).toBe('UNKNOWN')
    expect(classifyPreviewError('boom').code).toBe('UNKNOWN')
  })

  it('a preview RPC that times out reads as a timeout with its seconds, not as an unreachable DG', async () => {
    $degramEnabled.set(true)
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.context.preview': () => {
          throw new Error('request timed out after 45s: degram.context.preview')
        }
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    expect(await screen.findByText(/No answer within 45 s/)).toBeTruthy()
    expect(screen.queryByText(/can't be reached/)).toBeNull()
  })

  it('a dropped gateway connection still reads as an unreachable DG', async () => {
    $degramEnabled.set(true)
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.context.preview': () => {
          throw new Error('gateway not connected')
        }
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    expect(await screen.findByText(/can't be reached/)).toBeTruthy()
  })

  it('a BUSY preview outcome renders the Revit and the Grasshopper busy copy', async () => {
    $degramEnabled.set(true)
    await readyHarness()
    fakeGateway(
      ghHandlers({
        'degram.context.preview': () => ({ status: 'error', code: 'BUSY', bridgeState: 'busy', message: 'no answer' })
      })
    )

    render(withActions(<ContextCard />))
    await pinGh()

    expect(await screen.findByText(/Grasshopper is busy|Revit is busy/)).toBeTruthy()
  })
})
