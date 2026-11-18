import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { degramEn, degramRu } from './i18n'
import * as api from './mapping-api'
import { type MappingSession, parseSession } from './mapping-api'
import { SessionView } from './mapping-session-view'
import { RecognisedGroupsSection } from './recognised-groups'

const group = (id: string, extra: Record<string, unknown> = {}) => ({
  groupId: id,
  title: `100 elements from ${id}`,
  titleRu: `100 элементов из ${id}`,
  size: 100,
  classes: [{ classIri: 'ex:Beam', label: 'Beam' }],
  profiles: [{ profileId: 'P-1', source: 'learned', confirmations: 1, rejections: 0 }],
  representatives: ['r1'],
  ...extra
})

const CLASSES = [
  { classIri: 'ex:Beam', label: 'Beam' },
  { classIri: 'ex:OpeningBox', label: 'OpeningBox' },
  { classIri: 'ex:Wall', label: 'Wall' }
]

const make = (over: Record<string, unknown> = {}): MappingSession =>
  parseSession({
    sessionId: 'ms-test',
    document: 'tower',
    revision: 'b'.repeat(24),
    summary: {},
    answers: [],
    questions: [],
    recognised: [group('G-box'), group('G-wall', { classes: [{ classIri: 'ex:Wall', label: 'Wall' }] })],
    recognisedClasses: CLASSES,
    ...over
  })!

const props = (session = make(), app: 'grasshopper' | 'revit' = 'revit') => ({
  adopt: vi.fn(),
  busy: false,
  copy: degramEn,
  onFocus: vi.fn(),
  ru: false,
  session,
  app
})

const renderSection = (p: ReturnType<typeof props>, copy = degramEn, ru = false) =>
  render(
    <RecognisedGroupsSection
      adopt={p.adopt}
      busy={p.busy}
      copy={copy}
      ru={ru}
      session={p.session}
      target={{ app: p.app, onFocus: p.onFocus }}
    />
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('recognised groups boundary', () => {
  it('parses recognised groups defensively and treats absence as empty', () => {
    const s = make()
    expect(s.recognised).toHaveLength(2)
    expect(s.recognised[0].classes).toEqual([{ iri: 'ex:Beam', label: 'Beam' }])
    expect(s.recognisedClasses.map(c => c.iri)).toEqual(['ex:Beam', 'ex:OpeningBox', 'ex:Wall'])
    const bare = parseSession({ sessionId: 'old', summary: {} })!
    expect(bare.recognised).toEqual([])
    expect(bare.recognisedClasses).toEqual([])
    const junk = parseSession({ sessionId: 'x', summary: {}, recognised: [null, { size: 3 }, 'g'], recognisedClasses: [1] })!
    expect(junk.recognised).toEqual([])
  })
})

describe('«Распознано» section', () => {
  it('renders nothing for an empty list', () => {
    const { container } = renderSection(props(make({ recognised: [] })))
    expect(container.textContent).toBe('')
  })

  it('is collapsed by default with the count in the header and lists one row per group when opened', () => {
    renderSection(props())
    expect(screen.getByTestId('degram-recognised-toggle').textContent).toContain('Recognised (2)')
    expect(screen.queryByTestId('degram-recognised-change')).toBeNull()
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    expect(screen.getAllByTestId('degram-recognised-change')).toHaveLength(2)
    expect(screen.getByText('100 elements from G-box')).toBeTruthy()
    expect(screen.getAllByText('100 el.')).toHaveLength(2)
    expect(screen.getAllByText('learned')).toHaveLength(2)
  })

  it('speaks Russian', () => {
    renderSection(props(), degramRu, true)
    expect(screen.getByTestId('degram-recognised-toggle').textContent).toContain('Распознано (2)')
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    expect(screen.getAllByRole('button', { name: 'Изменить класс' })).toHaveLength(2)
    expect(screen.getByText('100 элементов из G-box')).toBeTruthy()
  })

  it('shows a group in Revit only, through the shared focus handler with the group id', () => {
    const p = props()
    renderSection(p)
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    fireEvent.click(screen.getAllByTestId('degram-recognised-show')[0])
    expect(p.onFocus).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'G-box', kind: 'stream' }))
    cleanup()
    const gh = props(make(), 'grasshopper')
    renderSection(gh)
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    expect(screen.queryByTestId('degram-recognised-show')).toBeNull()
  })

  it('preselects the current classes, refuses an unchanged or empty choice and applies a different one', async () => {
    const p = props()
    const reclassify = vi.spyOn(api, 'reclassifyMappingGroup').mockResolvedValue({ outcome: null, session: make({ recognised: [] }) })
    renderSection(p)
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    fireEvent.click(screen.getAllByTestId('degram-recognised-change')[0])
    const apply = screen.getByTestId('degram-recognised-apply') as HTMLButtonElement
    const boxes = screen.getAllByTestId('degram-recognised-class') as HTMLInputElement[]
    expect(boxes.filter(b => b.checked).map(b => b.value)).toEqual(['ex:Beam'])
    expect(screen.getByText('(current)')).toBeTruthy()
    expect(apply.disabled).toBe(true) // unchanged
    fireEvent.click(boxes[0]) // none selected
    expect(apply.disabled).toBe(true)
    fireEvent.click(boxes[1])
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    await waitFor(() => expect(reclassify).toHaveBeenCalledWith('ms-test', 'G-box', ['ex:OpeningBox']))
    await waitFor(() => expect(p.adopt).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('degram-recognised-picker')).toBeNull()
  })

  it('filters the class list by the search field', () => {
    renderSection(props())
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    fireEvent.click(screen.getAllByTestId('degram-recognised-change')[0])
    fireEvent.change(screen.getByTestId('degram-recognised-search'), { target: { value: 'open' } })
    expect((screen.getAllByTestId('degram-recognised-class') as HTMLInputElement[]).map(b => b.value)).toEqual(['ex:OpeningBox'])
    fireEvent.change(screen.getByTestId('degram-recognised-search'), { target: { value: 'zzz' } })
    expect(screen.getByText(degramEn.mapping.recognised.noMatch)).toBeTruthy()
  })

  it('shows a DG refusal in the picker and adopts nothing', async () => {
    const p = props()
    vi.spyOn(api, 'reclassifyMappingGroup').mockRejectedValue(new api.MappingRefusal('MAPPING_GROUP_NOT_FOUND', 'gone'))
    renderSection(p)
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    fireEvent.click(screen.getAllByTestId('degram-recognised-change')[0])
    fireEvent.click(screen.getAllByTestId('degram-recognised-class')[1])
    fireEvent.click(screen.getByTestId('degram-recognised-apply'))
    await screen.findByRole('alert')
    expect(p.adopt).not.toHaveBeenCalled()
    expect(screen.getByTestId('degram-recognised-picker')).toBeTruthy()
  })

  it('ignores a late reply after the session changed', async () => {
    const p = props()

    let release: (value: api.SessionResult) => void = () => {}
    vi.spyOn(api, 'reclassifyMappingGroup').mockReturnValue(new Promise(resolve => { release = resolve }))
    const view = renderSection(p)
    fireEvent.click(screen.getByTestId('degram-recognised-toggle'))
    fireEvent.click(screen.getAllByTestId('degram-recognised-change')[0])
    fireEvent.click(screen.getAllByTestId('degram-recognised-class')[1])
    fireEvent.click(screen.getByTestId('degram-recognised-apply'))
    view.rerender(
      <RecognisedGroupsSection
        adopt={p.adopt}
        busy={false}
        copy={degramEn}
        ru={false}
        session={make({ revision: 'c'.repeat(24) })}
        target={{ app: 'revit', onFocus: p.onFocus }}
      />
    )
    release({ outcome: null, session: make({ recognised: [] }) })
    await Promise.resolve()
    await Promise.resolve()
    expect(p.adopt).not.toHaveBeenCalled()
  })

  it('is mounted by the session view and the new draft then reaches the existing answers', () => {
    render(
      <SessionView adopt={vi.fn()} app="revit" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={make()} />
    )
    expect(screen.getByTestId('degram-recognised')).toBeTruthy()
    cleanup()
    render(
      <SessionView
        adopt={vi.fn()}
        app="revit"
        copy={degramEn}
        onFocus={vi.fn()}
        reload={vi.fn()}
        ru={false}
        session={make({ recognised: [] })}
      />
    )
    expect(screen.queryByTestId('degram-recognised')).toBeNull()
  })
})
