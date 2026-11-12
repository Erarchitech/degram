import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { DefinitionScheme } from './definition-scheme'
import type { DegramCopy } from './i18n'
import {
  type AdvancedAnswerTuple, type AdvancedBinding, type AdvancedDefinition, advancedIntentSettled, answerAdvanced, clearAdvancedPreview,
  deriveAdvancedDefinition, type MappingIntentResult, type MappingSession, newIntentRequestId, parseSession, previewAdvancedDefinition,
  proposeOrdinaryMode, readAdvancedIntentStatus, readMappingSession, undoMappingAnswer
} from './mapping-api'
import { recoverMappingSnapshot } from './use-degram-gateway'
import { environmentStamp, isCurrentEnvironment } from './use-degram-state'

export function advancedTuple(d: AdvancedDefinition, b?: AdvancedBinding): AdvancedAnswerTuple | null {
  return d.head && b && b.resultStatus === 'ok' && b.resultDefinitionVersion === d.head.version &&
    /^[0-9a-f]{16,64}$/.test(b.resultHash) && Number.isInteger(b.revision) && b.revision >= 0
    ? { definitionId: d.definitionId, definitionVersion: d.head.version, resultHash: b.resultHash, bindingRevision: b.revision }
    : null
}

/** Shared presentation only. Main re-reads every displayed tuple and the native dialog is the human-presence gate.
 * No renderer assertion or synthetic click grants consent. No result geometry is invented from instructions. */
export function AdvancedMappingSection({ session, copy, adopt, reload, onClarify }: {
  session: MappingSession; copy: DegramCopy; adopt: (session: MappingSession) => void; reload: () => void
  onClarify?: (text: string) => void
}) {
  const a = session.advanced
  const c = copy.mapping.advanced
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [unresolved, setUnresolved] = useState(false)
  const [generalize, setGeneralize] = useState<{ key: string; definitionId: string } | null>(null)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const key = JSON.stringify([session.sessionId, a?.revision, a?.model])
  const currentKey = useRef(key)
  const generation = useRef(0)

  if (currentKey.current !== key) {
    currentKey.current = key
    generation.current++
  }

  // Mount lifetime only, not a mirrored reactive value; StrictMode re-runs setup after cleanup.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      // Invalidate the live generation, deliberately not the generation captured at mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
    }
  }, [])

  const run = async (operation: (id: string) => Promise<MappingIntentResult>) => {
    if (inFlight.current || unresolved || !a?.complete) {
      return
    }

    const stamp = environmentStamp()
    const startedGeneration = generation.current
    const current = () => mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)
    const id = newIntentRequestId()
    inFlight.current = true
    setBusy(true)
    setMessage('')
    setRequestId(id)

    try {
      const result = await operation(id)

      if (!current()) {
        return
      }

      if (!result.ok) {
        setMessage(result.serverCode || result.code)
        setUnresolved(result.unresolved === true)
      } else if (result.session) {
        const canonical = parseSession(result.session)

        if (canonical?.sessionId === session.sessionId && canonical.document === session.document) {
          adopt(canonical)
        }
      }

      reload()
    } catch {
      if (current()) {
        // A lost IPC reply does not prove that nothing happened. Status only, never automatic native redispatch.
        setMessage(c.nativePending)
        setUnresolved(true)
      }
    } finally {
      inFlight.current = false

      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  const [deriveRequest, setDeriveRequest] = useState<{ id: string; definitionId: string; bindingRevision: number | undefined } | null>(null)
  const [deriveBlocked, setDeriveBlocked] = useState(false)
  const [correction, setCorrection] = useState<{ definitionId: string; key: string; text: string; allPhases?: boolean } | null>(null)

  const undo = async (answerId: string) => {
    if (inFlight.current || unresolved || !a?.pending.some(p => p.answerId === answerId)) {return}
    const stamp = environmentStamp()
    const startedGeneration = generation.current
    const current = () => mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)
    inFlight.current = true
    setBusy(true)

    try {
      const result = await undoMappingAnswer(session.sessionId, answerId)

      if (!current()) {return}

      if (result.outcome) {setMessage(result.outcome.code)}
      else if (result.session.sessionId === session.sessionId && result.session.document === session.document) {adopt(result.session)}

      reload()
    } catch {
      if (current()) { setMessage(c.nativePending); reload() }
    } finally {
      inFlight.current = false

      if (mounted.current) {setBusy(false)}
    }
  }

  const unprotected = async (d: AdvancedDefinition, mode: boolean, statusOnly = false) => {
    if (inFlight.current || !a?.complete || (!mode && deriveBlocked && !statusOnly)) {
      return
    }

    const stamp = environmentStamp()
    const startedGeneration = generation.current
    const current = () => mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)
    inFlight.current = true
    setBusy(true)
    setMessage('')

    try {
      if (mode) {
        await proposeOrdinaryMode(d)
      } else {
        const previous = statusOnly ? deriveRequest : null
        const id = previous?.id ?? newIntentRequestId()
        const revision = previous?.bindingRevision ?? a.bindings.find(b => b.definitionId === d.definitionId)?.revision
        setDeriveRequest({ id, definitionId: d.definitionId, bindingRevision: revision })
        setDeriveBlocked(true)
        const edit = !statusOnly && correction?.definitionId === d.definitionId && correction.key === key ? correction : null
        const ids = edit ? [...new Set(edit.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))] : []
        const limit = d.head?.kind === 'derived' ? 50 : d.head?.kind === 'direct' ? 500 : 5000

        if (edit && ((!ids.length && !(d.head?.kind === 'derived' && edit.allPhases)) || ids.length > limit || ids.some(s => !/^[A-Za-z0-9._:#/\- ]{1,200}$/.test(s)))) {
          setDeriveBlocked(false)
          setMessage(c.invalidInputs)

          return
        }

        const binding = edit ? d.head?.kind === 'derived' ? { grids: ids, ...(edit.allPhases ? { phaseScope: 'all-model' as const } : {}) } : d.head?.kind === 'direct' ? { uniqueIds: ids } : { memberIds: ids } : undefined
        const outcome = await deriveAdvancedDefinition(session.sessionId, d, revision, id, statusOnly, binding)

        if (current()) {
          setMessage(outcome)
          setDeriveBlocked(!['ok', 'failed', 'needs-input'].includes(outcome))
        }
      }

      if (current()) {
        reload()
      }
    } catch {
      if (current()) {
        setMessage(c.nativePending)
      }
    } finally {
      inFlight.current = false

      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  const status = async () => {
    if (!requestId || inFlight.current) {
      return
    }

    const stamp = environmentStamp()
    const startedGeneration = generation.current
    inFlight.current = true
    setBusy(true)

    try {
      const result = await readAdvancedIntentStatus(session.sessionId, requestId)
      const canonical = advancedIntentSettled(result) ? await readMappingSession(session.sessionId) : null

      if (mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)) {
        if (canonical && !canonical.outcome && canonical.session.sessionId === session.sessionId && canonical.session.document === session.document) {
          setUnresolved(false)
          adopt(canonical.session)
        }

        setMessage(result.ok ? result.intents.map(i => [i.status, i.operationState].filter(Boolean).join(': ')).join(' · ') || c.nativePending : result.code)
        reload()
      }
    } catch {
      if (mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)) {
        setMessage(c.nativePending)
      }
    } finally {
      inFlight.current = false

      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  const recover = async (batchId: string) => {
    if (inFlight.current) {return}
    const stamp = environmentStamp()
    const startedGeneration = generation.current
    const current = () => mounted.current && generation.current === startedGeneration && isCurrentEnvironment(stamp)
    inFlight.current = true
    setBusy(true)
    setMessage('')

    try {
      const result = await recoverMappingSnapshot({ sessionId: session.sessionId, batchId })

      if (current()) {
        setMessage(result.ok ? result.status : result.code)
        reload()
      }
    } catch {
      if (current()) {setMessage(c.nativePending); reload()}
    } finally {
      inFlight.current = false

      if (mounted.current) {setBusy(false)}
    }
  }

  if (!a || !a.definitions.length) {
    return null
  }

  const unchanged = a.definitions.flatMap(d => {
    const b = a.bindings.find(b => b.definitionId === d.definitionId)
    const tuple = advancedTuple(d, b)

    return tuple && b?.change === 'unchanged' && !a.pending.some(p => p.definitionId === d.definitionId) ? [tuple] : []
  })

  const disabled = busy || unresolved || !a.complete

  return (
    <section className="grid min-w-0 gap-3" data-testid="advanced-mapping-section">
      <h4 className="text-sm font-medium">{c.title}</h4>
      <p className="break-words font-mono text-xs text-muted-foreground">{a.model.document} · {a.model.modelKey}</p>
      {!a.complete && <p className="text-xs text-muted-foreground" role="status">{c.unsupported}</p>}
      {a.definitions.some(d => !a.bindings.find(b => b.definitionId === d.definitionId)?.eligible) && <p className="text-xs text-muted-foreground">{c.incomplete}</p>}
      {a.definitions.map(d => {
        const b = a.bindings.find(b => b.definitionId === d.definitionId)
        const tuple = advancedTuple(d, b)
        const pending = a.pending.filter(p => p.definitionId === d.definitionId)
        const kind = d.head?.kind

        return (
          <section className="grid min-w-0 gap-2 border-t border-(--ui-stroke-tertiary) pt-3" data-testid="advanced-definition" key={d.definitionId}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-medium">{d.classIri}</span>
              <Badge variant="outline">{kind === 'derived' || kind === 'compound' || kind === 'direct' ? c.kinds[kind] : '—'}</Badge>
              {d.agentProposed && <Badge variant="muted">{copy.mapping.proposedByAgent}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">{c.draft} {d.head?.version ?? '—'} · {c.effective} {d.effective?.version ?? '—'}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{d.head?.text}</p>
            {d.head?.proposedBy && <p className="text-xs text-muted-foreground">{d.head.proposedBy}</p>}
            {d.effective && d.head?.version !== d.effective.version && <p className="text-xs text-muted-foreground">{c.approvedKept}</p>}
            <p className="break-words font-mono text-xs text-muted-foreground">{[b?.resultStatus, b?.change, b?.confirmation, b?.delivery].filter(Boolean).join(' · ') || c.contractUnavailable}</p>
            {b?.reasons.length ? <p className="text-xs text-muted-foreground">{b.reasons.join(' · ')}</p> : null}
            {b?.resultStatus === 'failed' || b?.resultStatus === 'needs-input'
              ? <p className="text-xs text-destructive">{c.failedNoPartial}</p>
              : <DefinitionScheme copy={c} value={b?.display.scheme} />}
            {b && <div className="grid gap-1 break-words text-xs text-muted-foreground">
              {b.display.code && <p>{b.display.code}</p>}
              {b.display.message && <p>{b.display.message}</p>}
              {b.display.question && <p>{b.display.question}</p>}
              {b.display.inputIds.length > 0 && <p>{b.display.inputIds.join(' · ')}</p>}
              {b.display.memberIds.length > 0 && <p>{b.display.memberIds.join(' · ')}</p>}
            </div>}
            {kind === 'direct' && <div className="grid gap-1 text-xs text-muted-foreground">
              <p>{c.selectedOnly}</p>
              {b?.profileOffer ? <>
                <p>{Object.entries(b.profileOffer.selector).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
                <p>{c.capturedMatches(b.profileOffer.matchedCount, b.profileOffer.capturedCount)}</p><p>{c.futureScope}</p>
                <label className="flex items-center gap-2"><input checked={generalize?.key === key && generalize.definitionId === d.definitionId} disabled={disabled || pending.length > 0}
                  onChange={e => setGeneralize(e.target.checked ? { key, definitionId: d.definitionId } : null)}
                  type="checkbox" />{c.similar}</label>
              </> : <p>{c.profileUnavailable}</p>}
            </div>}
            {pending.map(p => <div className="flex flex-wrap items-center gap-2" key={p.answerId}>
              <p className="text-xs text-muted-foreground">{c.waiting} {p.action} · {p.answerId} {p.valid ? '' : p.reasons.join(' · ')}</p>
              <Button disabled={busy || unresolved} onClick={() => void undo(p.answerId)} size="xs" variant="text">{copy.mapping.undo}</Button>
            </div>)}
            <details className="text-xs text-muted-foreground">
              <summary>{c.inputs}</summary>
              <p>{c.correctionHint}</p>
              {kind === 'derived' && <label className="flex items-center gap-2">
                <input checked={correction?.key === key && correction.definitionId === d.definitionId && correction.allPhases === true} disabled={disabled || deriveBlocked}
                  onChange={e => setCorrection({ definitionId: d.definitionId, key, text: correction?.key === key && correction.definitionId === d.definitionId ? correction.text : b?.display.inputIds.join('\n') ?? '', allPhases: e.target.checked })} type="checkbox" />
                {c.allPhases}
              </label>}
              <label className="grid gap-1">
                {kind === 'derived' ? c.grids : c.members}
                <textarea aria-label={kind === 'derived' ? c.grids : c.members} className="min-h-20 w-full rounded border border-input bg-background p-2 text-foreground" disabled={disabled || deriveBlocked}
                  maxLength={kind === 'derived' ? 10050 : kind === 'direct' ? 100500 : 1005000}
                  onChange={e => setCorrection({ definitionId: d.definitionId, key, text: e.target.value, allPhases: correction?.key === key && correction.definitionId === d.definitionId ? correction.allPhases : false })}
                  value={correction?.definitionId === d.definitionId && correction.key === key ? correction.text : b?.display.inputIds.join('\n') ?? ''} />
              </label>
            </details>
            <div className="flex flex-wrap gap-1.5">
              <Button disabled={disabled || !d.head || deriveBlocked} onClick={() => void unprotected(d, false)} size="xs" variant="outline">{c.derive}</Button>
              {deriveRequest?.definitionId === d.definitionId && <Button disabled={busy} onClick={() => void unprotected(d, false, true)} size="xs" variant="outline">{c.status}</Button>}
              {d.mode === 'advanced' && <Button disabled={disabled || d.modeProposal === 'ordinary'} onClick={() => void unprotected(d, true)} size="xs" variant="text">{c.ordinary}</Button>}
              <Button disabled={disabled || !tuple || pending.length > 0} onClick={() => tuple && void run(id => answerAdvanced('approve', session.sessionId, id, [{ ...tuple, ...(generalize?.key === key && generalize.definitionId === d.definitionId && b?.profileOffer ? { generalization: { selectorHash: b.profileOffer.selectorHash, matchedCount: b.profileOffer.matchedCount, countState: b.profileOffer.countState } } : {}) }]))} size="xs">
                {b?.change === 'unchanged' ? c.approveUnchanged : c.approve}
              </Button>
              <Button disabled={disabled || !tuple || pending.length > 0} onClick={() => tuple && void run(id => answerAdvanced('skip', session.sessionId, id, [tuple]))} size="xs" variant="outline">{c.skip}</Button>
              <Button disabled={disabled || !tuple} onClick={() => tuple && void run(id => previewAdvancedDefinition(session.sessionId, id, tuple))} size="xs" variant="outline">{c.preview}</Button>
              <Button disabled={disabled} onClick={() => void run(id => clearAdvancedPreview(session.sessionId, id, d.definitionId))} size="xs" variant="outline">{c.clear}</Button>
              <Button disabled={busy || !onClarify} onClick={() => onClarify?.(`${c.clarify}: ${d.classIri}\n${d.head?.text ?? ''}`)} size="xs" variant="text">{c.clarify}</Button>
            </div>
          </section>
        )
      })}
      {unchanged.length >= 2 && unchanged.length <= 100 && <div><Button disabled={disabled || generalize?.key === key} onClick={() => void run(id => answerAdvanced('approve', session.sessionId, id, unchanged))} size="sm" variant="outline">{c.bulk}</Button></div>}
      {busy && <p className="text-xs text-muted-foreground" role="status">{c.nativePending}</p>}
      {message && <p className="break-words text-xs text-destructive" role="alert">{message}</p>}
      {requestId && <div><Button disabled={busy} onClick={() => void status()} size="xs" variant="outline">{c.status}</Button></div>}
      {a.snapshotState && <p className="text-xs text-muted-foreground">{a.snapshotState}</p>}
      {session.batches.filter(b => b.delivery === 'written' && ['failed', 'pending'].includes(b.snapshot?.status ?? '')).map(b =>
        <div className="grid gap-1" key={b.batchId}>
          <p className="break-words text-xs text-muted-foreground">{b.batchId} · {c.recoveryHint}</p>
          <Button disabled={busy} onClick={() => void recover(b.batchId)} size="xs" variant="outline">{c.recoverPublication}</Button>
        </div>
      )}
    </section>
  )
}
