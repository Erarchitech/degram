// The mapping card a degram_mapping call shows in a DeGram chat (DG 1303-33, D-118..D-121). Scripted gateway only.
//
// The card renders the session through the sub-tab's own view, so an answer, «show the group» and the confirmation
// travel the same RPCs as «Модели → Mapping»; the confirmation is the user's click (requestId / revision / answerIds).
// An answer the agent proposed carries its mark; a card of another project stays inert.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile } from '@/store/profile'
import { stubMenuDomApis } from '@/test/jsdom'

import { resetDocuments } from './documents-store'
import { type MappingCardAnchor, mappingCardAnchor, MappingChatCard } from './mapping-chat-card'
import { install, makeState, withActions } from './test-harness'
import { setDegramGatewayForTests } from './use-degram-gateway'
import { resetDegramStore } from './use-degram-state'

type Handler = (params: Record<string, any>) => unknown

const READY = { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null } as const
const REVISION = 'b'.repeat(24)

const ITEM = {
  itemId: 'G-suite-1',
  kind: 'stream',
  name: 'Suite 1',
  componentId: null,
  count: 20,
  proposal: { iri: 'ex:HabitableRoom', label: 'HabitableRoom' },
  alternatives: [],
  state: 'ambiguous'
}

const answer = (answerId: string) => ({
  answerId,
  questionId: `Q-${answerId}`,
  type: 'assign',
  title: `Rooms ${answerId}`,
  titleRu: `Помещения ${answerId}`,
  optionId: 'class:ex:HabitableRoom',
  items: [],
  decidedAt: '2026-11-07T11:00:00Z',
  decidedBy: 'ann',
  undoable: true
})

const SESSION = {
  sessionId: 'ms-rooms',
  label: 'tower · 11:00:00',
  document: 'tower',
  createdAt: '2026-11-07T11:00:00Z',
  revision: REVISION,
  pendingAnswerIds: ['A-agent', 'A-user'],
  batches: [] as unknown[],
  summary: { total: 60, confirmed: 40, auto: 0, suggested: 0, ambiguous: 20, unmapped: 0, openQuestions: 1 },
  llm: { status: 'done' },
  questions: [
    {
      questionId: 'Q-suite',
      type: 'assign',
      title: 'Suite 1 · 20 elements',
      titleRu: 'Suite 1 · 20 элементов',
      text: 'Which class?',
      textRu: 'Какой класс?',
      items: [ITEM],
      options: [
        { optionId: 'class:ex:HabitableRoom', label: 'HabitableRoom' },
        { optionId: 'none', label: 'None of these' }
      ]
    }
  ],
  answers: [answer('A-agent'), answer('A-user')],
  agentAnswerIds: ['A-agent']
}

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
    count: (method: string) => calls.filter(c => c.method === method).length,
    last: (method: string) => calls.filter(c => c.method === method).at(-1)?.params
  }
}

async function ready() {
  const state = makeState({ scope: { ...READY } as never })
  const h = install(state)

  $activeGatewayProfile.set(READY.profile)
  h.emitState(state)
  await act(async () => undefined)
}

const anchor = (over: Partial<MappingCardAnchor> = {}): MappingCardAnchor => ({
  app: 'grasshopper',
  sessionId: SESSION.sessionId,
  project: 'Alpha',
  ...over
})

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

describe('mappingCardAnchor', () => {
  it('points the card at the session a result names, and at nothing otherwise', () => {
    const card = { app: 'revit', sessionId: 'ms-1', project: 'Alpha' }

    expect(mappingCardAnchor(JSON.stringify({ status: 'ok', card }))).toEqual({ ...card, next: null })
    expect(mappingCardAnchor({ status: 'ok', card: { ...card, project: undefined } })?.project).toBeNull()
    expect(mappingCardAnchor({ status: 'ok', action: 'sessions', sessions: [] })).toBeNull()
    expect(mappingCardAnchor({ status: 'ok', card: { app: 'rhino', sessionId: 'ms-1' } })).toBeNull()
    expect(mappingCardAnchor(undefined)).toBeNull()
  })
})

describe('MappingChatCard', () => {
  it('answers and confirms through the same calls as the Models → Mapping sub-tab', async () => {
    await ready()

    const gw = fakeGateway({
      'degram.mapping.session': () => ({ status: 'ok', session: SESSION }),
      'degram.mapping.answer': () => ({ status: 'ok', session: SESSION }),
      'degram.mapping.apply': params => ({
        status: 'ok',
        batch: { batchId: params.requestId, revision: REVISION, answerIds: params.answerIds, committedAt: 'now' }
      })
    })

    render(withActions(<MappingChatCard anchor={anchor()} />))
    const card = await screen.findByTestId('degram-mapping-chat-card')
    const proposal = await within(card).findByTestId('degram-mapping-proposal')

    fireEvent.click(within(proposal).getByRole('button', { name: 'HabitableRoom' }))
    await waitFor(() =>
      expect(gw.last('degram.mapping.answer')).toEqual({
        sessionId: SESSION.sessionId,
        questionId: 'Q-suite',
        optionId: 'class:ex:HabitableRoom'
      })
    )

    expect(gw.count('degram.mapping.apply')).toBe(0)
    fireEvent.click(within(card).getByTestId('degram-mapping-apply'))
    await waitFor(() =>
      expect(gw.last('degram.mapping.apply')).toEqual({
        sessionId: SESSION.sessionId,
        requestId: `commit-${REVISION}`,
        revision: REVISION,
        answerIds: ['A-agent', 'A-user']
      })
    )
  })

  it('marks only the answers the agent proposed', async () => {
    await ready()
    fakeGateway({ 'degram.mapping.session': () => ({ status: 'ok', session: SESSION }) })

    render(withActions(<MappingChatCard anchor={anchor()} />))
    const card = await screen.findByTestId('degram-mapping-chat-card')
    const answers = await within(card).findAllByTestId('degram-mapping-answer')
    const marked = answers.filter(row => within(row).queryByTestId('degram-mapping-by-agent'))

    expect(marked.map(row => row.getAttribute('data-answer-id'))).toEqual(['A-agent'])
    expect(within(marked[0]!).getByText('proposed by the agent')).toBeTruthy()
  })

  it('shows a Revit group in the model from its chip', async () => {
    await ready()

    const gw = fakeGateway({
      'degram.mapping.session': () => ({ status: 'ok', session: SESSION }),
      'degram.mapping.focus': ({ itemId }) => ({ status: 'ok', found: true, itemId, shown: 20, missing: [] })
    })

    render(withActions(<MappingChatCard anchor={anchor({ app: 'revit' })} />))
    const card = await screen.findByTestId('degram-mapping-chat-card')

    fireEvent.click(await within(card).findByTestId('degram-mapping-chip'))
    await waitFor(() =>
      expect(gw.last('degram.mapping.focus')).toEqual({
        app: 'revit',
        sessionId: SESSION.sessionId,
        itemId: 'G-suite-1'
      })
    )
  })

  const NEXT = {
    options: { filters: { categories: ['OST_Rooms'] }, limit: 100, after: 700 },
    read: 100,
    matched: 250,
    remaining: 150
  }

  const continuing = (pending: string[]) =>
    fakeGateway({
      'degram.mapping.session': ({ sessionId }) => ({
        status: 'ok',
        session: { ...SESSION, sessionId, pendingAnswerIds: pending }
      }),
      'degram.mapping.start': () => ({
        status: 'ok',
        started: true,
        sessionId: 'ms-next',
        scope: 'filters',
        read: 100,
        matched: 250,
        remaining: 50,
        lastElementId: 900
      })
    })

  it('holds the continuation while this session still has answers to confirm', async () => {
    await ready()
    const gw = continuing(['A-agent'])

    render(withActions(<MappingChatCard anchor={anchor({ app: 'revit', next: NEXT })} />))
    const warning = await screen.findByTestId('degram-mapping-over-limit')

    expect(warning.textContent).toContain('150 remain')
    await within(warning).findByText(/Confirm or undo the answers of this session first/)
    const go = within(warning).getByRole('button', { name: 'Continue with the remaining 150' }) as HTMLButtonElement

    expect(go.disabled).toBe(true)
    expect(gw.count('degram.mapping.start')).toBe(0)
  })

  it('continues an over-limit start and follows the next session', async () => {
    await ready()
    const gw = continuing([])

    render(withActions(<MappingChatCard anchor={anchor({ app: 'revit', next: NEXT })} />))
    const warning = await screen.findByTestId('degram-mapping-over-limit')
    const go = within(warning).getByRole('button', { name: 'Continue with the remaining 150' }) as HTMLButtonElement

    await waitFor(() => expect(go.disabled).toBe(false))
    fireEvent.click(go)
    await waitFor(() =>
      expect(gw.last('degram.mapping.start')).toEqual({
        app: 'revit',
        filters: { categories: ['OST_Rooms'] },
        limit: 100,
        after: 700
      })
    )
    await waitFor(() => expect(gw.last('degram.mapping.session')).toEqual({ sessionId: 'ms-next' }))
    expect((await screen.findByTestId('degram-mapping-over-limit')).textContent).toContain('50 remain')
  })

  it('stays inert for a session of another project', async () => {
    await ready()
    const gw = fakeGateway({})

    render(withActions(<MappingChatCard anchor={anchor({ project: 'Beta' })} />))

    expect((await screen.findByTestId('degram-mapping-chat-card-elsewhere')).textContent).toContain('Beta')
    expect(screen.queryByTestId('degram-mapping-apply')).toBeNull()
    expect(gw.count('degram.mapping.session')).toBe(0)
  })
})
