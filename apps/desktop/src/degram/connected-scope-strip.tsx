// connected-scope-strip.tsx — the scope strip fed with the document and the two bridges (Phase 1301-14, DGCL-02/04).
//
// The strip itself (plan 13) is presentational. This feeds its document and bridge segments from the documents
// cache, and keeps that cache fresh at the moments that matter: when a scope becomes ready (the dots leave
// «Проверка») and when the picker opens. A project or document change shows in the strip in the same render
// because the cache is scope-tagged (a reader of another scope sees an empty one).

import { useEffect } from 'react'

import { useI18n } from '@/i18n'

import { bridgeView, toSegment } from './bridge-status'
import { pinnedApps, refreshDocuments, scopeKeyOf, useDocuments } from './documents-store'
import { ScopeStrip } from './scope-strip'
import type { BridgeApp } from './use-degram-gateway'
import { useDegram } from './use-degram-state'

export function ConnectedScopeStrip() {
  const { t } = useI18n()
  const degram = useDegram()
  const documents = useDocuments()
  const key = scopeKeyOf(degram)
  const copy = t.degram
  const { mismatch, pinned } = documents

  // First status for the bridges as soon as a scope is ready (a read of the loopback bridges, not a request).
  useEffect(() => {
    if (key) {
      void refreshDocuments()
    }
  }, [key])

  const view = (app: BridgeApp) => {
    const entry = documents.apps[app]

    // An RPC that failed outright reads as an unreachable bridge; no answer yet reads as «Проверка».
    const group =
      entry.group ?? (entry.failed ? { app, state: 'off' as const, documents: [], code: 'BRIDGE_OFF' } : undefined)

    const pin = pinned[app]
    const segment = toSegment(bridgeView(copy, group, pin?.name))

    // D-29: each bridge carries its own pinned document. It shows with the accent dot while it is the one answering,
    // and with a neutral «other file» when it is gone or replaced; any other bridge state (off, busy, setup) wins.
    if (pin && (segment.status === 'ready' || segment.status === 'pinned' || segment.status === 'identity-mismatch')) {
      return mismatch[pin.app]
        ? {
            status: 'identity-mismatch' as const,
            label: copy.bridge.states.identityMismatch,
            detail: copy.errors.pinnedGone(pin.name)
          }
        : { ...segment, status: 'pinned' as const, document: pin.name }
    }

    return segment
  }

  return (
    <ScopeStrip
      bridges={{ revit: view('revit'), grasshopper: view('grasshopper') }}
      document={{ count: pinnedApps(documents).length }}
      documentPicker
    />
  )
}
