import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdvancedMappingSection } from './advanced-mapping'
import { DefinitionScheme } from './definition-scheme'
import { degramEn, degramRu } from './i18n'
import { parseSession } from './mapping-api'
import * as api from './mapping-api'
import { SessionView, useMappingFocus } from './mapping-session-view'
import * as gateway from './use-degram-gateway'
import { useMappingSessionById } from './use-mapping-session'

const HASH = 'a'.repeat(64)
const did = (n: number) => `MD-${String(n).padStart(12, '0')}`

const definition = (n: number, kind = 'derived') => ({
  definitionId: did(n), classIri: `ex:Building${n}`, revision: 3, mode: 'advanced', modeRevision: 1,
  head: { version: 2, kind, text: 'Grid A/1, instruction 75 (not a measurement)', source: 'agent', proposedBy: 'member', recipe: { recipe: 'building-envelope', version: 1 } },
  effective: { version: 1, kind, text: 'Previously approved' }, agentProposed: true
})

export function advancedSession(over: Record<string, unknown> = {}) {
  return parseSession({
    sessionId: 'ms-test', document: 'tower', revision: 'b'.repeat(24), summary: {}, answers: [], questions: [],
    advancedState: {
      revision: 'c'.repeat(24), model: { document: 'tower', modelKey: 'm1' }, complete: true, supported: true,
      definitions: [definition(1), definition(2)],
      bindings: [1, 2].map(n => ({ definitionId: did(n), revision: 4, resultDefinitionVersion: 2, resultHash: HASH,
        resultStatus: 'ok', change: 'unchanged', confirmation: 'none', eligibility: { eligible: false, reasons: ['not-delivered'] } })),
      pending: [], affectedModels: [], commit: null, ...over
    }
  })!
}

const props = () => ({ session: advancedSession(), copy: degramEn, adopt: vi.fn(), reload: vi.fn(), onClarify: vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('advanced session boundary', () => {
  it('preserves draft and approved versions, distinct states, and no unknown secret fields', () => {
    const session = advancedSession({ token: 'secret', cookie: 'secret' })
    expect(session.advanced?.definitions[0]?.head?.version).toBe(2)
    expect(session.advanced?.definitions[0]?.effective?.version).toBe(1)
    expect(session.advanced?.bindings[0]?.resultHash).toBe(HASH)
    expect(JSON.stringify(session)).not.toContain('secret')
    expect(parseSession({ sessionId: 'old', summary: {} })?.advanced).toBeNull()
    const delivered = advancedSession({ bindings: [{ definitionId: did(1), materialization: { state: 'pending-delivery' } }] })
    expect(delivered.advanced?.bindings[0].delivery).toBe('pending-delivery')
  })
})

describe('shared confirmation and session lifecycle', () => {
  it('common confirmation uses the advanced manifest, not the ordinary apply route', async () => {
    const commit = vi.spyOn(api, 'commitAdvanced').mockResolvedValue({ ok: true, requestId: 'r', action: 'commit', intents: [] })
    const ordinary = vi.spyOn(api, 'applyMapping')
    const session = advancedSession({ pending: [{ answerId: 'A-advanced', definitionId: did(1), action: 'approve', valid: true }], commit: { batchManifestHash: HASH, operations: [], ordinaryRows: { elements: [], parameters: [], measures: [] } } })
    render(<SessionView adopt={vi.fn()} app="grasshopper" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={session} />)
    fireEvent.click(screen.getByTestId('degram-mapping-apply'))
    await waitFor(() => expect(commit).toHaveBeenCalledWith('ms-test', expect.any(String), { answerIds: ['A-advanced'], revision: 'b'.repeat(24), batchManifestHash: HASH }))
    expect(ordinary).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('advanced-mapping-section')).toHaveLength(1)
  })
  it('shows exact delivery rows including clears and affected models, not proposal counts', () => {
    const session = advancedSession({ pending: [{ answerId: 'A-advanced', definitionId: did(1), action: 'approve', valid: true }],
      affectedModels: [{ definitionId: did(1), modelKey: 'other-model', document: 'Other tower' }],
      commit: { batchManifestHash: HASH, operations: [{ definitionId: did(1), definitionVersion: 2, classIri: 'ex:Building1', action: 'create', instanceKey: 'B1', existing: null }],
        ordinaryRows: { elements: [{ nativeId: 'exact-u1', roles: ['ex:Wall'] }, { nativeId: 'exact-u2', roles: [], clear: true }], parameters: [], measures: [] } } })

    render(<SessionView adopt={vi.fn()} app="grasshopper" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={session} />)
    expect(screen.getByText(/exact-u1.*ex:Wall/)).toBeTruthy()
    expect(screen.getByText(/exact-u2.*DG_Class → ∅/)).toBeTruthy()
    expect(screen.getByText(/Other tower.*other-model/)).toBeTruthy()
    expect(screen.getByTestId('degram-mapping-apply').hasAttribute('disabled')).toBe(false)
  })
  it.each([
    { operations: Array.from({ length: 1501 }, () => ({ definitionId: did(1), action: 'create' })), ordinaryRows: { elements: [], parameters: [], measures: [] } },
    { operations: [], ordinaryRows: { elements: [{ nativeId: 'u', roles: ['ex:Wall', null] }], parameters: [], measures: [] } },
    { operations: [], ordinaryRows: { elements: Array.from({ length: 5001 }, () => ({ nativeId: 'u', roles: [] })), parameters: [], measures: [] } },
    { operations: [] },
    { operations: [{ definitionId: did(1), action: 'create', classIri: 'ex:B', instanceKey: 'B1', existing: null }], ordinaryRows: { elements: [], parameters: [], measures: [] } },
    { operations: [{ definitionId: did(1), action: 'update', classIri: 'ex:B', definitionVersion: 2, instanceKey: 'B1', existing: null }], ordinaryRows: { elements: [], parameters: [], measures: [] } },
    { operations: [{ definitionId: did(1), action: 'delete', instanceKey: 'B1', nativeId: 'u', reason: 'arbitrary' }], ordinaryRows: { elements: [], parameters: [], measures: [] } },
    { operations: [{ definitionId: did(1), action: 'direct', classIri: 'ex:B', uniqueIds: ['u', 'u'] }], ordinaryRows: { elements: [], parameters: [], measures: [] } },
    { operations: [], ordinaryRows: { elements: [{ nativeId: 'u', roles: ['ex:Wall'], clear: true }], parameters: [], measures: [] } },
    { operations: [], ordinaryRows: { elements: [], parameters: [{ nativeId: 'p', name: '' }], measures: [] } },
    { operations: [], ordinaryRows: { elements: [], parameters: [], measures: [{ nativeId: 'm', name: 'Height', propertyIri: 'x'.repeat(513) }] } }
  ])('refuses confirmation rather than calling a truncated/malformed disclosure exact %#', commit => {
    const session = advancedSession({ pending: [{ answerId: 'A-advanced', definitionId: did(1), action: 'approve', valid: true }], commit: { batchManifestHash: HASH, ...commit } })
    render(<SessionView adopt={vi.fn()} app="grasshopper" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={session} />)
    expect(screen.getByTestId('degram-mapping-apply').hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText(degramEn.mapping.advanced.contractUnavailable).length).toBeGreaterThan(0)
  })
  it('shows snapshot failure separately from a written batch and refreshes without repeating CAD or publication', async () => {
    const session = advancedSession()
    session.batches = [{ batchId: 'written-batch', revision: 'r1', answerIds: ['A1'], committedAt: '', delivery: 'written',
      snapshot: { status: 'failed', stateId: 'OS_1', reason: 'Speckle publication unavailable' } }]
    const read = vi.spyOn(api, 'readMappingSession').mockResolvedValue({ outcome: null, session })
    const commit = vi.spyOn(api, 'commitAdvanced')
    const apply = vi.spyOn(api, 'applyMapping')
    const adopt = vi.fn()
    render(<SessionView adopt={adopt} app="revit" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={session} />)
    expect(screen.getByTestId('mapping-snapshot-status').textContent).toContain('Snapshot failed')
    expect(screen.getByText('Speckle publication unavailable')).toBeTruthy()
    expect(screen.getByText(degramEn.mapping.advanced.snapshotRecovery)).toBeTruthy()
    fireEvent.click(screen.getByTestId('mapping-delivery-status'))
    await waitFor(() => expect(adopt).toHaveBeenCalledWith(session))
    expect(read).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })
  it('recovers publication through the member lane without apply, derive or native intent', async () => {
    const p = props()
    p.session.batches = [{ batchId: 'written-batch', revision: 'r1', answerIds: ['A1'], committedAt: '', delivery: 'written',
      snapshot: { status: 'failed', stateId: 'OS_1', reason: 'offline' } }]
    const recover = vi.spyOn(gateway, 'recoverMappingSnapshot').mockResolvedValue({ ok: true, status: 'published' })
    const apply = vi.spyOn(api, 'applyMapping')
    const derive = vi.spyOn(api, 'deriveAdvancedDefinition')
    const native = vi.spyOn(api, 'commitAdvanced')
    render(<AdvancedMappingSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.recoverPublication }))
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
    expect(recover).toHaveBeenCalledWith({ sessionId: 'ms-test', batchId: 'written-batch' })
    expect(apply).not.toHaveBeenCalled()
    expect(derive).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it('drops recovery completion after A to B to A view changes', async () => {
    const p = props()
    p.session.batches = [{ batchId: 'written-batch', revision: 'r1', answerIds: [], committedAt: '', delivery: 'written',
      snapshot: { status: 'pending', stateId: 'OS_1', reason: '' } }]
    let finish!: (value: { ok: true; status: 'published' }) => void
    vi.spyOn(gateway, 'recoverMappingSnapshot').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<AdvancedMappingSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.recoverPublication }))
    view.rerender(<AdvancedMappingSection {...p} session={{ ...p.session, sessionId: 'other' }} />)
    view.rerender(<AdvancedMappingSection {...p} />)
    await act(async () => finish({ ok: true, status: 'published' }))
    expect(p.reload).not.toHaveBeenCalled()
  })

  it('parses the server snapshot.status without treating unknown publication as published', () => {
    const session = parseSession({ sessionId: 's', batches: [
      { batchId: 'b1', delivery: { state: 'written' }, snapshot: { status: 'failed', stateId: 'OS_1', reason: 'offline', token: 'secret' } },
      { batchId: 'b2', snapshot: { status: 'made-up' } }
    ] })!

    expect(session.batches[0].snapshot).toEqual({ status: 'failed', stateId: 'OS_1', reason: 'offline' })
    expect(session.batches[1].snapshot?.status).toBe('unknown')
    expect(advancedSession({ snapshot: { status: 'failed' } }).advanced?.snapshotState).toBe('failed')
    expect(JSON.stringify(session)).not.toContain('secret')
  })
  it.each(['revision', 'answers'])('does not unlock consumed commit with only a matching batch id but wrong %s', async mismatch => {
    const commit = vi.spyOn(api, 'commitAdvanced').mockResolvedValue({ ok: true, requestId: 'r', action: 'commit', intents: [] })

    const session = advancedSession({ pending: [{ answerId: 'A-advanced', definitionId: did(1), action: 'approve', valid: true }],
      commit: { batchManifestHash: HASH, operations: [], ordinaryRows: { elements: [], parameters: [], measures: [] } } })

    vi.spyOn(api, 'readAdvancedIntentStatus').mockResolvedValue({ ok: true, requestId: 'r', intents: [{ intentId: 'hi-x', action: 'advanced-commit', status: 'consumed' }] })
    const read = vi.spyOn(api, 'readMappingSession')
    render(<SessionView adopt={vi.fn()} app="grasshopper" copy={degramEn} onFocus={vi.fn()} reload={vi.fn()} ru={false} session={session} />)
    fireEvent.click(screen.getByTestId('degram-mapping-apply'))
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
    const requestId = commit.mock.calls[0][1]
    read.mockResolvedValue({ outcome: null, session: { ...session, batches: [{ batchId: requestId,
      revision: mismatch === 'revision' ? 'wrong' : session.revision, answerIds: mismatch === 'answers' ? ['other'] : ['A-advanced'],
      committedAt: '', delivery: 'written' }] } })
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.status }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('degram-mapping-apply').hasAttribute('disabled')).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
  })
  it('drops a late CAD focus response after A→B→A', async () => {
    let finish!: (r: Awaited<ReturnType<typeof api.showRevitItem>>) => void
    vi.spyOn(api, 'showRevitItem').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const hook = renderHook(({ id }) => useMappingFocus('revit', id, degramEn, 'p'), { initialProps: { id: 'A' } })
    act(() => hook.result.current.focus({ itemId: 'i', name: 'Old item', kind: 'stream' } as api.MappingItem))
    hook.rerender({ id: 'B' })
    hook.rerender({ id: 'A' })
    await act(async () => finish({ outcome: null, found: false, shown: 0, missing: ['old'] }))
    expect(hook.result.current.focusError).toBeNull()
  })
  it('session-by-id drops an old A reply after A→B→A and a scope switch', async () => {
    const pending: Array<{ id: string; resolve: (r: api.SessionResult) => void }> = []
    vi.spyOn(api, 'readMappingSession').mockImplementation(id => new Promise(resolve => pending.push({ id, resolve })))
    const hook = renderHook(({ id, scope }) => useMappingSessionById(id, scope), { initialProps: { id: 'A', scope: 'one' } })
    hook.rerender({ id: 'B', scope: 'one' })
    hook.rerender({ id: 'A', scope: 'two' })
    const canonical = { ...advancedSession(), sessionId: 'A', label: 'fresh' }
    await act(async () => pending.at(-1)!.resolve({ outcome: null, session: canonical }))
    expect(hook.result.current.state.session?.label).toBe('fresh')
    await act(async () => pending[0]!.resolve({ outcome: null, session: { ...canonical, label: 'late' } }))
    expect(hook.result.current.state.session?.label).toBe('fresh')
    hook.unmount()
  })
})

describe('safe definition scheme', () => {
  it('renders numeric grid identifiers and counts, never markup, links or dimensions', () => {
    const { container } = render(<DefinitionScheme copy={degramEn.mapping.advanced} value={{
      lines: [{ points: [[0, 0], [100, 100]], label: 'A/1 +3 −2 <script>bad</script>' }]
    }} />)

    expect(screen.getByText('A/1 +3 −2 <script>bad</script>')).toBeTruthy()
    expect(container.querySelector('script, foreignObject, a, image')).toBeNull()
    expect(container.querySelector('polyline')?.getAttribute('points')).toBe('0,0 100,100')
  })
  it.each([
    '<svg onload="bad()"/>', { lines: [{ points: [[NaN, 0], [1, 1]] }] },
    { lines: [{ points: [[Infinity, 0], [1, 1]] }] }, { lines: [{ points: [[1e20, 0], [1, 1]] }] },
    { lines: [{ points: [[0, 0], [1, 1]], dimension: 75 }] },
    { lines: [], foreignObject: '<script>bad</script>' },
    { lines: Array.from({ length: 129 }, () => ({ points: [[0, 0], [1, 1]] })) }
  ])('rejects an entire unsafe/oversized scheme %#', value => {
    const { container } = render(<DefinitionScheme copy={degramEn.mapping.advanced} value={value} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByText(degramEn.mapping.advanced.noScheme)).toBeTruthy()
  })
})

describe('shared advanced section', () => {
  it('shows all kinds, draft coexistence and no invented geometric or compliance success', () => {
    render(<AdvancedMappingSection {...props()} session={advancedSession({ definitions: [definition(1), definition(2, 'compound'), definition(3, 'direct')] })} />)
    expect(screen.getAllByTestId('advanced-definition')).toHaveLength(3)
    expect(screen.getAllByText(degramEn.mapping.advanced.approvedKept)).toHaveLength(3)
    expect(screen.getByText(degramEn.mapping.advanced.incomplete)).toBeTruthy()
    expect(screen.getByText(degramEn.mapping.advanced.kinds.compound)).toBeTruthy()
    expect(screen.getByText(degramEn.mapping.advanced.kinds.direct)).toBeTruthy()
  })
  it('approves a frozen tuple through the protected broker, never an ordinary answer', async () => {
    const p = props()
    const approve = vi.spyOn(api, 'answerAdvanced').mockResolvedValue({ ok: true, requestId: 'req', action: 'approve', intents: [] })
    const ordinary = vi.spyOn(api, 'answerMapping')
    render(<AdvancedMappingSection {...p} />)
    fireEvent.click(within(screen.getAllByTestId('advanced-definition')[0]!).getByRole('button', { name: degramEn.mapping.advanced.approveUnchanged }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith('approve', 'ms-test', expect.any(String), [{ definitionId: did(1), definitionVersion: 2, resultHash: HASH, bindingRevision: 4 }]))
    expect(ordinary).not.toHaveBeenCalled()
    expect(p.reload).toHaveBeenCalled()
  })
  it('uses one bulk action, keeps whole-list stale refusal explicit, and offers status instead of blind retry', async () => {
    const run = vi.spyOn(api, 'answerAdvanced').mockResolvedValue({ ok: false, requestId: 'req', action: 'approve', code: 'STALE_TUPLE', message: 'safe', intents: [], completed: [], stale: [did(2)] })
    render(<AdvancedMappingSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('STALE_TUPLE'))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[3]).toHaveLength(2)
  })
  it('old connector keeps drafts visible with protected actions disabled', () => {
    render(<AdvancedMappingSection {...props()} session={advancedSession({ complete: false })} />)
    expect(screen.getByText(degramEn.mapping.advanced.unsupported)).toBeTruthy()

    for (const button of screen.getAllByRole('button', { name: degramEn.mapping.advanced.approveUnchanged })) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
  })
  it('failed compound never displays partial geometry; clarification is requested only on click', () => {
    const p = props()
    render(<AdvancedMappingSection {...p} session={advancedSession({ definitions: [definition(1, 'compound')], bindings: [{ definitionId: did(1), revision: 4, resultStatus: 'failed', change: 'none' }] })} />)
    expect(screen.getByText(degramEn.mapping.advanced.failedNoPartial)).toBeTruthy()
    expect(p.onClarify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.clarify }))
    expect(p.onClarify).toHaveBeenCalledTimes(1)
  })
  it('fences an A→B→A late action by generation, not key equality', async () => {
    let finish!: (r: Awaited<ReturnType<typeof api.answerAdvanced>>) => void
    vi.spyOn(api, 'answerAdvanced').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const p = props()
    const view = render(<AdvancedMappingSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }))
    view.rerender(<AdvancedMappingSection {...p} session={advancedSession({ revision: 'd'.repeat(24) })} />)
    view.rerender(<AdvancedMappingSection {...p} />)
    await act(async () => finish({ ok: true, requestId: 'late', action: 'approve', intents: [] }))
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.adopt).not.toHaveBeenCalled()
  })
  it('lost broker reply blocks redispatch and status is read-only', async () => {
    const run = vi.spyOn(api, 'answerAdvanced').mockRejectedValue(new Error('IPC lost'))
    const status = vi.spyOn(api, 'readAdvancedIntentStatus').mockResolvedValue({ ok: true, requestId: 'r', intents: [] })
    render(<AdvancedMappingSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }))
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.status }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
  })
  it('routes skip, preview and owned clear through their protected broker functions', async () => {
    const p = props()
    const skip = vi.spyOn(api, 'answerAdvanced').mockResolvedValue({ ok: true, requestId: 'r', action: 'skip', intents: [] })
    const preview = vi.spyOn(api, 'previewAdvancedDefinition').mockResolvedValue({ ok: true, requestId: 'r', action: 'preview', intents: [] })
    const clear = vi.spyOn(api, 'clearAdvancedPreview').mockResolvedValue({ ok: true, requestId: 'r', action: 'clear-preview', intents: [] })
    render(<AdvancedMappingSection {...p} session={advancedSession({ definitions: [definition(1)] })} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.skip }))
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.preview }))
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.clear }))
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(3))
    expect(skip.mock.calls[0]?.[0]).toBe('skip')
    expect(preview.mock.calls[0]?.[2]).toMatchObject({ definitionId: did(1), resultHash: HASH })
    expect(clear.mock.calls[0]?.[2]).toBe(did(1))
  })
  it('derives without approval, reuses the derive request for status, and proposes ordinary mode with CAS', async () => {
    const derive = vi.spyOn(api, 'deriveAdvancedDefinition').mockResolvedValueOnce('pending').mockResolvedValueOnce('ok')
    const mode = vi.spyOn(api, 'proposeOrdinaryMode').mockResolvedValue()
    const p = props()
    render(<AdvancedMappingSection {...p} session={advancedSession({ definitions: [definition(1)] })} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.derive }))
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: degramEn.mapping.advanced.derive }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.status }))
    await waitFor(() => expect(derive).toHaveBeenCalledTimes(2))
    expect(derive.mock.calls[1]?.[3]).toBe(derive.mock.calls[0]?.[3])
    expect(derive.mock.calls[1]?.[4]).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.ordinary }))
    await waitFor(() => expect(mode).toHaveBeenCalledWith(expect.objectContaining({ definitionId: did(1), revision: 3 })))
  })
  it('renders the bounded server scheme and concrete escaped failure details', () => {
    const display = { scheme: { lines: [{ points: [[0, 0], [100, 0], [0, 50]], label: 'A/1' }] }, message: '<script>untrusted</script>', question: 'Which grid?', code: 'GRID_REQUIRED', memberIds: ['member-1'], inputIds: ['A/1'] }
    const session = advancedSession({ definitions: [definition(1)], bindings: [{ definitionId: did(1), revision: 4, resultStatus: 'ok', display }] })
    const view = render(<AdvancedMappingSection {...props()} session={session} />)
    expect(screen.getByRole('img', { name: degramEn.mapping.advanced.scheme })).toBeTruthy()
    expect(screen.getByText(display.message)).toBeTruthy()
    expect(view.container.querySelector('script')).toBeNull()
    expect(screen.getByText('GRID_REQUIRED')).toBeTruthy()
    expect(screen.getByText('member-1')).toBeTruthy()
  })
  it('corrects exact model-local inputs for the next derive, never an approval', async () => {
    const derive = vi.spyOn(api, 'deriveAdvancedDefinition').mockResolvedValue('ok')
    const approve = vi.spyOn(api, 'answerAdvanced')
    render(<AdvancedMappingSection {...props()} session={advancedSession({ definitions: [definition(1)] })} />)
    fireEvent.change(screen.getByLabelText(degramEn.mapping.advanced.grids), { target: { value: 'A/1\nB/2\nA/1' } })
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.derive }))
    await waitFor(() => expect(derive).toHaveBeenCalledWith('ms-test', expect.any(Object), 4, expect.any(String), false, { grids: ['A/1', 'B/2'] }))
    expect(approve).not.toHaveBeenCalled()
  })
  it('allows explicit all-phase derived scope with no manually selected grids', async () => {
    const derive = vi.spyOn(api, 'deriveAdvancedDefinition').mockResolvedValue('ok')
    render(<AdvancedMappingSection {...props()} session={advancedSession({ definitions: [definition(1)] })} />)
    fireEvent.click(screen.getByRole('checkbox', { name: degramEn.mapping.advanced.allPhases }))
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.derive }))
    await waitFor(() => expect(derive).toHaveBeenCalledWith('ms-test', expect.any(Object), 4, expect.any(String), false, { grids: [], phaseScope: 'all-model' }))
  })
  it('undoes an advanced draft through the existing UI lane without native mutation', async () => {
    const p = props()
    const undo = vi.spyOn(api, 'undoMappingAnswer').mockResolvedValue({ outcome: null, session: advancedSession() })
    const approve = vi.spyOn(api, 'answerAdvanced')
    render(<AdvancedMappingSection {...p} session={advancedSession({ pending: [{ answerId: 'A-advanced', definitionId: did(1), action: 'approve', valid: true }] })} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.undo }))
    await waitFor(() => expect(undo).toHaveBeenCalledWith('ms-test', 'A-advanced'))
    expect(p.adopt).toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })
  it('unlocks only after terminal status and a matching canonical session, without redispatch', async () => {
    const p = props()
    const run = vi.spyOn(api, 'answerAdvanced').mockRejectedValue(new Error('IPC lost'))
    vi.spyOn(api, 'readAdvancedIntentStatus').mockResolvedValue({ ok: true, requestId: 'r', intents: [{ intentId: 'hi-x', action: 'advanced-approve', status: 'consumed' }] })
    vi.spyOn(api, 'readMappingSession').mockResolvedValue({ outcome: null, session: advancedSession() })
    render(<AdvancedMappingSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.status }))
    await waitFor(() => expect(p.adopt).toHaveBeenCalled())
    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }).hasAttribute('disabled')).toBe(false)
  })
  it.each(['claimed', 'unknown'])('keeps %s native operations blocked', operationState => {
    expect(api.advancedIntentSettled({ ok: true, requestId: 'r', intents: [{ intentId: 'hi-x', action: 'preview-definition', status: 'confirmed', operationState }] })).toBe(false)
  })
  it('keeps direct selected-only by default and freezes explicit future-profile opt-in', async () => {
    const approve = vi.spyOn(api, 'answerAdvanced').mockResolvedValue({ ok: true, requestId: 'r', action: 'approve', intents: [] })
    render(<AdvancedMappingSection {...props()} session={advancedSession({ definitions: [definition(1, 'direct')], bindings: [{ definitionId: did(1), revision: 4, resultDefinitionVersion: 2, resultHash: HASH, resultStatus: 'ok', profileOffer: { selector: { category: 'Walls' }, selectorHash: 'a'.repeat(16), matchedCount: 7, capturedCount: 10, countState: 'unknown', futureScope: 'project-revit-future-sessions' } }] })} />)
    const optIn = screen.getByRole('checkbox', { name: degramEn.mapping.advanced.similar }) as HTMLInputElement
    expect(optIn.checked).toBe(false)
    expect(screen.getByText(degramEn.mapping.advanced.capturedMatches(7, 10))).toBeTruthy()
    expect(screen.getByText(degramEn.mapping.advanced.futureScope)).toBeTruthy()
    fireEvent.click(optIn)
    fireEvent.click(screen.getByRole('button', { name: degramEn.mapping.advanced.approve }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith('approve', 'ms-test', expect.any(String), [expect.objectContaining({ definitionId: did(1), generalization: { selectorHash: 'a'.repeat(16), matchedCount: 7, countState: 'unknown' } })]))
    expect(approve.mock.calls[0]?.[3]).toHaveLength(1)
  })
  it('disables atomic bulk while a single-card future-profile opt-in is selected', () => {
    const defs = [definition(1, 'direct'), definition(2)]

    const bindings = [1, 2].map(n => ({ definitionId: did(n), revision: 4, resultDefinitionVersion: 2,
      resultHash: HASH, resultStatus: 'ok', change: 'unchanged', ...(n === 1 ? { profileOffer: {
        selector: { category: 'Walls' }, selectorHash: 'a'.repeat(16), matchedCount: 7, capturedCount: 10,
        countState: 'unknown', futureScope: 'project-revit-future-sessions'
      } } : {}) }))

    const approve = vi.spyOn(api, 'answerAdvanced')
    render(<AdvancedMappingSection {...props()} session={advancedSession({ definitions: defs, bindings })} />)
    const bulk = screen.getByRole('button', { name: degramEn.mapping.advanced.bulk }) as HTMLButtonElement
    expect(bulk.disabled).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: degramEn.mapping.advanced.similar }))
    expect(bulk.disabled).toBe(true)
    fireEvent.click(bulk)
    expect(approve).not.toHaveBeenCalled()
  })
  it('does not enable advanced actions from a truncated definition list', () => {
    const session = advancedSession({ definitions: Array.from({ length: 501 }, (_, n) => definition(n + 1)) })
    expect(session.advanced?.complete).toBe(false)
    expect(session.advanced?.confirmationComplete).toBe(false)
  })
  it('localizes the section in Russian', () => {
    render(<AdvancedMappingSection {...props()} copy={degramRu} />)
    expect(screen.getByRole('heading', { name: degramRu.mapping.advanced.title })).toBeTruthy()
    expect(screen.getByRole('button', { name: degramRu.mapping.advanced.bulk })).toBeTruthy()
  })
})
