import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { degramEn, degramRu } from './i18n'
import { parseSession } from './mapping-api'
import { SessionView } from './mapping-session-view'

const question = (id: string, extra: Record<string, unknown> = {}) => ({
  questionId: id,
  type: 'assign',
  title: `${id} · 1 element: which class?`,
  titleRu: `${id} · 1 элемент: какой класс?`,
  text: '',
  textRu: '',
  items: [],
  options: [],
  ...extra
})

const session = (questions: unknown[]) =>
  parseSession({ sessionId: 'ms-cat', document: 'tower', revision: 'r1', summary: {}, answers: [], questions })!

const show = (questions: unknown[], copy = degramEn, ru = false) =>
  render(<SessionView adopt={vi.fn()} app="revit" copy={copy} onFocus={vi.fn()} reload={vi.fn()} ru={ru} session={session(questions)} />)

describe('proposal category', () => {
  afterEach(cleanup)

  it('shows the Revit category of the question elements next to its title', () => {
    show([question('Q-1', { categories: ['Materials'] }), question('Q-2', { categories: ['Walls', 'Floors'] }), question('Q-3')])
    const badges = screen.getAllByTestId('degram-mapping-category')
    expect(badges.map(b => b.textContent)).toEqual(['Materials', 'Walls, Floors'])
    expect(badges[0].getAttribute('title')).toBe('Category: Materials')
  })

  it('is localised and ignores malformed categories', () => {
    show([question('Q-1', { categories: ['Стены', '', 7, null] })], degramRu, true)
    const [badge] = screen.getAllByTestId('degram-mapping-category')
    expect(badge.textContent).toBe('Стены')
    expect(badge.getAttribute('title')).toBe('Категория: Стены')
  })
})

describe('check status', () => {
  afterEach(cleanup)

  it('says what it found instead of changing nothing on screen', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react')
    const api = await import('./mapping-api')
    const base = session([])

    const withBatch = parseSession({
      sessionId: 'ms-cat', document: 'tower', revision: 'r1', summary: {}, answers: [], questions: [],
      batches: [{ batchId: 'profile-ms-cat', answerIds: [], delivery: { state: 'written', written: 1, skipped: 0 } }]
    })!

    const spy = vi.spyOn(api, 'readMappingSession').mockResolvedValue({ session: withBatch } as never)

    render(<SessionView adopt={vi.fn()} app="revit" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={withBatch} />)
    expect(base.batches).toHaveLength(0)
    fireEvent.click(screen.getByTestId('mapping-delivery-status'))
    await waitFor(() => expect(screen.getByTestId('mapping-delivery-note').textContent).toMatch(/^Checked at .+: Written/))
    spy.mockRestore()
  })
})
