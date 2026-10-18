// models-mapping.test.tsx — the «Mapping» sub-tab under each document of the «Модели» screen (Phase 1303-10, owner
// request 2026-10-18; data shapes 1303-API-CONTRACT.md §3, §7). Scripted gateway only: no DG, no Grasshopper.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile } from '@/store/profile'
import { stubMenuDomApis } from '@/test/jsdom'

import { resetDocuments } from './documents-store'
import { ModelsPage } from './models-page'
import { install, makeState, withActions } from './test-harness'
import { setDegramGatewayForTests } from './use-degram-gateway'
import { resetDegramStore } from './use-degram-state'

type Handler = (params: Record<string, any>) => unknown

const READY = { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null } as const

const GH_ROW = {
  app: 'grasshopper',
  name: 'Tower Facade.gh',
  path: 'C:/work/Tower Facade.gh',
  unsaved: false,
  identity: { documentId: '11111111-aaaa-bbbb', filePath: 'C:/work/Tower Facade.gh' },
  pinned: false
}

const REVIT_ROW = {
  app: 'revit',
  name: 'Tower.rvt',
  path: 'C:\\Projects\\Tower.rvt',
  unsaved: false,
  identity: { creationGuid: 'aaaaaaaa-1111-2222', pathName: 'C:\\Projects\\Tower.rvt' },
  pinned: false
}

const PANELS_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const PANELS_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

const item = (over: Record<string, unknown>) => ({
  itemId: 'G-1',
  kind: 'stream',
  name: 'Panels A',
  componentId: PANELS_A,
  count: 120,
  proposal: { iri: 'ex:GlassPanel', label: 'GlassPanel' },
  alternatives: [{ iri: 'ex:BottomTriangularPanel', label: 'BottomTriangularPanel' }],
  state: 'ambiguous',
  ...over
})

const SESSION = {
  sessionId: 'ms-000000000001',
  label: 'tower-facade · 10:00:00',
  document: 'tower-facade',
  createdAt: '2026-10-18T10:00:00Z',
  summary: { total: 300, confirmed: 125, auto: 0, suggested: 55, ambiguous: 120, unmapped: 0, openQuestions: 2 },
  llm: { status: 'pending' },
  questions: [
    {
      questionId: 'Q-design',
      type: 'mapping-or-design',
      title: 'Panels A · 120 elements: BottomTriangularPanel or GlassPanel?',
      titleRu: 'Panels A · 120 элементов: BottomTriangularPanel или GlassPanel?',
      text: 'The full explanation of the Panels A question.',
      textRu: 'Полное объяснение вопроса Panels A.',
      items: [item({}), item({ itemId: 'G-2', name: 'Panels C', componentId: null, count: 3, alternatives: [] })],
      options: [
        { optionId: 'class:ex:GlassPanel', label: 'GlassPanel' },
        { optionId: 'design-error:ex:BottomTriangularPanel', label: 'BottomTriangularPanel — rule violations are design errors' },
        { optionId: 'none', label: 'None of these' }
      ]
    },
    {
      questionId: 'Q-measure',
      type: 'map-measure',
      title: 'Output «Area»: which DG property?',
      titleRu: 'Выход «Area»: какое свойство DG?',
      text: 'Area output.',
      textRu: 'Выход площади.',
      items: [
        item({
          itemId: 'M-1',
          kind: 'measure',
          name: 'Area',
          componentId: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
          count: 55,
          proposal: { iri: 'ex:hasAreaM2', label: 'hasAreaM2' },
          alternatives: [],
          state: 'suggested'
        })
      ],
      options: [
        { optionId: 'property:ex:hasAreaM2', label: 'hasAreaM2' },
        { optionId: 'none', label: 'Not a DG property' }
      ]
    }
  ],
  answers: [
    {
      answerId: 'A-batch',
      questionId: 'Q-batch',
      type: 'batch-assign',
      title: 'Accept 1 group',
      titleRu: 'Принять 1 группу',
      optionId: 'accept-all',
      items: [item({ itemId: 'G-3', name: 'Panels B', componentId: PANELS_B, count: 125, alternatives: [], state: 'confirmed' })],
      decidedAt: '2026-10-18T10:01:00Z',
      decidedBy: 'ann',
      undoable: true
    },
    {
      answerId: 'A-old',
      questionId: 'Q-old',
      type: 'assign',
      title: 'Old answer',
      titleRu: 'Старое решение',
      optionId: 'class:ex:GlassPanel',
      items: [],
      decidedAt: '2026-10-18T09:01:00Z',
      decidedBy: 'ann',
      undoable: false
    }
  ],
  elements: [],
  groups: []
}

const ROW = (session = SESSION) => ({
  sessionId: session.sessionId,
  label: session.label,
  document: session.document,
  createdAt: session.createdAt,
  summary: session.summary
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

  return {
    calls,
    count: (method: string) => calls.filter(c => c.method === method).length,
    last: (method: string) => calls.filter(c => c.method === method).at(-1)?.params
  }
}

const backend = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  'degram.documents.list': ({ app }) => ({
    status: 'ok',
    groups: [{ app, state: 'ready', documents: [app === 'revit' ? REVIT_ROW : GH_ROW] }],
    pinned: {}
  }),
  'degram.documents.pin': ({ app, identity }) => ({ status: 'ok', pinned: { app, name: GH_ROW.name, identity } }),
  'degram.mapping.sessions': ({ app }) => ({
    status: 'ok',
    document: app === 'revit' ? 'tower' : 'tower-facade',
    sessions: app === 'revit' ? [] : [ROW()],
    signedIn: true
  }),
  'degram.mapping.session': () => ({ status: 'ok', session: SESSION }),
  'degram.mapping.focus': ({ componentId }) => ({ status: 'ok', found: true, componentId, name: 'Panels A' }),
  ...over
})

const ready = async () => {
  const state = makeState({ scope: { ...READY } as never })
  const h = install(state)

  $activeGatewayProfile.set(READY.profile)
  h.emitState(state)
  await act(async () => undefined)

  return h
}

const subtab = (app: 'grasshopper' | 'revit') =>
  window.document.querySelector(`[data-testid="degram-mapping-subtab"][data-app="${app}"]`) as HTMLElement

async function openGh(locale?: string) {
  const ui = withActions(<ModelsPage />)

  render(locale ? <I18nProvider configClient={null} initialLocale={locale}>{ui}</I18nProvider> : ui)
  await screen.findByText(GH_ROW.name)
  fireEvent.click(within(subtab('grasshopper')).getByTestId('degram-mapping-toggle'))
  await within(subtab('grasshopper')).findByTestId('degram-mapping-progress')

  return subtab('grasshopper')
}

beforeEach(() => {
  stubMenuDomApis()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  resetDegramStore()
  resetDocuments()
  setDegramGatewayForTests(null)
  $degramEnabled.set(false)
  $activeGatewayProfile.set('default')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('Mapping sub-tab on the Models page (1303-10)', () => {
  it('sits collapsed under every document row and reads nothing until it is opened', async () => {
    await ready()
    const gw = fakeGateway(backend())

    render(withActions(<ModelsPage />))
    await screen.findByText(GH_ROW.name)
    await screen.findByText(REVIT_ROW.name)

    for (const app of ['grasshopper', 'revit'] as const) {
      const toggle = within(subtab(app)).getByTestId('degram-mapping-toggle')

      expect(toggle.textContent).toContain('Mapping')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    }

    expect(gw.calls.filter(c => c.method.startsWith('degram.mapping.'))).toEqual([])
  })

  it('opens on the newest session of that document: progress, LLM status and one row per item', async () => {
    await ready()
    const gw = fakeGateway(backend())
    const tab = await openGh()

    expect(gw.last('degram.mapping.sessions')).toEqual({ app: 'grasshopper', document: 'Tower Facade.gh' })
    expect(gw.last('degram.mapping.session')).toEqual({ sessionId: SESSION.sessionId })
    // Five states, only the non-empty ones paint a segment.
    expect(within(tab).getByTestId('degram-mapping-segment-confirmed')).toBeTruthy()
    expect(within(tab).queryByTestId('degram-mapping-segment-auto')).toBeNull()
    expect(within(tab).getByTestId('degram-mapping-llm')).toBeTruthy()

    const [first] = within(tab).getAllByTestId('degram-mapping-proposal')
    const rows = first!.querySelectorAll('[data-mapping-item]')

    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByTestId('degram-mapping-chip').textContent).toBe('Panels A')
    expect(rows[0]!.textContent).toContain('→ GlassPanel')
    expect(rows[0]!.textContent).toContain('120 elements')
    expect(rows[0]!.textContent).toContain('or BottomTriangularPanel')
    expect(within(rows[1] as HTMLElement).getByTestId('degram-mapping-chip').textContent).toBe('Panels C')
  })

  it('a chip click asks the canvas to focus that component; a chip without a component is disabled', async () => {
    await ready()
    const gw = fakeGateway(backend())
    const tab = await openGh()
    const chips = within(within(tab).getAllByTestId('degram-mapping-proposal')[0]!).getAllByTestId('degram-mapping-chip')

    fireEvent.click(chips[0]!)
    await waitFor(() => expect(gw.last('degram.mapping.focus')).toEqual({ componentId: PANELS_A }))
    expect((chips[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chips[1]!)
    expect(gw.count('degram.mapping.focus')).toBe(1)
  })

  it('collapses and expands each proposal on its own; the first starts open', async () => {
    await ready()
    fakeGateway(backend())
    const tab = await openGh()
    const [first, second] = within(tab).getAllByTestId('degram-mapping-proposal')
    const head = (card: HTMLElement) => card.querySelector('button[aria-expanded]') as HTMLElement

    expect(head(first!).getAttribute('aria-expanded')).toBe('true')
    expect(head(second!).getAttribute('aria-expanded')).toBe('false')
    expect(second!.querySelector('[data-mapping-item]')).toBeNull()

    fireEvent.click(head(second!))
    expect(head(second!).getAttribute('aria-expanded')).toBe('true')
    expect(second!.querySelectorAll('[data-mapping-item]')).toHaveLength(1)
    expect(head(first!).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(head(first!))
    expect(head(first!).getAttribute('aria-expanded')).toBe('false')
    expect(head(second!).getAttribute('aria-expanded')).toBe('true')
  })

  it('names the options in the UI language and answers with the chosen option id', async () => {
    await ready()
    const gw = fakeGateway(backend({ 'degram.mapping.answer': () => ({ status: 'ok', session: SESSION }) }))
    const tab = await openGh()
    const [first, second] = within(tab).getAllByTestId('degram-mapping-proposal')

    expect(within(first!).getByRole('button', { name: 'GlassPanel' })).toBeTruthy()
    expect(
      within(first!).getByRole('button', { name: 'BottomTriangularPanel — rule violations are design errors' })
    ).toBeTruthy()
    expect(within(first!).getByRole('button', { name: 'None of these' })).toBeTruthy()
    fireEvent.click(second!.querySelector('button[aria-expanded]') as HTMLElement)
    expect(within(second!).getByRole('button', { name: 'Not a DG property' })).toBeTruthy()

    fireEvent.click(within(first!).getByRole('button', { name: 'GlassPanel' }))
    await waitFor(() =>
      expect(gw.last('degram.mapping.answer')).toEqual({
        sessionId: SESSION.sessionId,
        questionId: 'Q-design',
        optionId: 'class:ex:GlassPanel'
      })
    )

    // «Подробнее» shows the full text.
    fireEvent.click(within(first!).getByRole('button', { name: 'Details' }))
    expect(within(first!).getByTestId('degram-mapping-details').textContent).toBe(SESSION.questions[0]!.text)
  })

  it('every decision has its own undo; an applied one is disabled with the reason', async () => {
    await ready()
    const after = { ...SESSION, answers: SESSION.answers.slice(1) }
    const gw = fakeGateway(backend({ 'degram.mapping.undo': () => ({ status: 'ok', session: after }) }))
    const tab = await openGh()
    const [batch, old] = within(tab).getAllByTestId('degram-mapping-answer')

    expect(batch!.querySelector('[data-mapping-item]')).toBeNull()
    fireEvent.click(batch!.querySelector('button[aria-expanded]') as HTMLElement)
    expect(within(batch!).getByTestId('degram-mapping-chip').textContent).toBe('Panels B')
    fireEvent.click(within(batch!).getByTestId('degram-mapping-chip'))
    await waitFor(() => expect(gw.last('degram.mapping.focus')).toEqual({ componentId: PANELS_B }))

    fireEvent.click(old!.querySelector('button[aria-expanded]') as HTMLElement)
    expect((within(old!).getByRole('button', { name: 'Undo decision' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(old!).getByText('The session is applied — undo is not available')).toBeTruthy()

    fireEvent.click(within(batch!).getByRole('button', { name: 'Undo decision' }))
    await waitFor(() =>
      expect(gw.last('degram.mapping.undo')).toEqual({ sessionId: SESSION.sessionId, answerId: 'A-batch' })
    )
    await waitFor(() => expect(within(tab).getAllByTestId('degram-mapping-answer')).toHaveLength(1))
    expect(within(tab).getByText('Decision undone')).toBeTruthy()
  })

  it('shows DG refusing an undo by its code and reads the session again', async () => {
    await ready()

    const refuse = () => {
      throw Object.assign(new Error('MAPPING_SESSION_APPLIED: applied'), {
        data: { code: 'MAPPING_SESSION_APPLIED', status: 409 }
      })
    }

    const gw = fakeGateway(backend({ 'degram.mapping.undo': refuse }))
    const tab = await openGh()
    const [batch] = within(tab).getAllByTestId('degram-mapping-answer')
    const reads = gw.count('degram.mapping.sessions')

    fireEvent.click(batch!.querySelector('button[aria-expanded]') as HTMLElement)
    fireEvent.click(within(batch!).getByRole('button', { name: 'Undo decision' }))
    expect(await within(batch!).findByText('The session is already applied; nothing was changed.')).toBeTruthy()
    await waitFor(() => expect(gw.count('degram.mapping.sessions')).toBe(reads + 1))
  })

  it('offers «Start mapping» only for a Grasshopper document without a session, then reads again', async () => {
    await ready()
    let started = false

    const gw = fakeGateway(
      backend({
        'degram.mapping.sessions': ({ app }) => ({
          status: 'ok',
          document: 'tower-facade',
          sessions: app === 'grasshopper' && started ? [ROW()] : [],
          signedIn: true
        }),
        'degram.mapping.start': () => {
          started = true

          return { status: 'ok', started: true, message: 'Reading the canvas' }
        }
      })
    )

    render(withActions(<ModelsPage />))
    await screen.findByText(GH_ROW.name)
    fireEvent.click(within(subtab('revit')).getByTestId('degram-mapping-toggle'))
    fireEvent.click(within(subtab('grasshopper')).getByTestId('degram-mapping-toggle'))

    expect(await within(subtab('revit')).findByText('There are no mapping sessions for this model yet.')).toBeTruthy()
    expect(within(subtab('revit')).queryByRole('button', { name: 'Start mapping' })).toBeNull()

    const start = await within(subtab('grasshopper')).findByRole('button', { name: 'Start mapping' })

    expect((start as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() => expect(gw.count('degram.mapping.start')).toBe(1))
    await within(subtab('grasshopper')).findByTestId('degram-mapping-progress')
    expect(within(subtab('grasshopper')).queryByRole('button', { name: 'Start mapping' })).toBeNull()
  })

  it('keeps Enter inside the sub-tab: a focused proposal button never pins the document', async () => {
    await ready()
    const gw = fakeGateway(backend())
    const tab = await openGh()

    fireEvent.keyDown(within(tab).getAllByTestId('degram-mapping-chip')[0]!, { key: 'Enter' })
    expect(gw.count('degram.documents.pin')).toBe(0)
  })

  it('re-reads every 4 s while proposals are open and stops when collapsed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    await ready()
    const gw = fakeGateway(backend())
    const tab = await openGh()
    const before = gw.count('degram.mapping.session')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100)
    })
    await waitFor(() => expect(gw.count('degram.mapping.session')).toBe(before + 1))

    fireEvent.click(within(tab).getByTestId('degram-mapping-toggle'))
    const closed = gw.count('degram.mapping.session')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(gw.count('degram.mapping.session')).toBe(closed)
  })

  it('reads in Russian: «Меппинг», titles, options and the undo', async () => {
    await ready()
    fakeGateway(backend())
    const tab = await openGh('ru')
    const [first] = within(tab).getAllByTestId('degram-mapping-proposal')

    expect(within(tab).getByTestId('degram-mapping-toggle').textContent).toContain('Меппинг')
    expect(first!.textContent).toContain(SESSION.questions[0]!.titleRu)
    expect(
      within(first!).getByRole('button', { name: 'BottomTriangularPanel — нарушения правил — ошибки проекта' })
    ).toBeTruthy()
    expect(within(first!).getByRole('button', { name: 'Ни один из вариантов' })).toBeTruthy()
    expect(within(first!).getByRole('button', { name: 'Подробнее' })).toBeTruthy()
    expect(within(tab).getByText('Принятые решения')).toBeTruthy()

    const [batch] = within(tab).getAllByTestId('degram-mapping-answer')

    expect(batch!.textContent).toContain('→ Принять все')
    fireEvent.click(batch!.querySelector('button[aria-expanded]') as HTMLElement)
    expect(within(batch!).getByRole('button', { name: 'Отменить решение' })).toBeTruthy()
  })
})
