// models-page.tsx — the DeGram «Модели» screen (Phase 1301-35, D-43, UI-SPEC E3 moved off the strip).
//
// Per connector (Revit, Grasshopper and any further bridge in BRIDGE_APPS) it shows the connector's status and the
// documents it exposes, with pin / unpin and refresh. One document is pinned per bridge (D-29); nothing is pinned
// implicitly. The body is the former strip popover's list (`DocumentsPanel`) and the documents-store, unchanged in
// semantics; only the place moved. Reads happen on open and whenever the ready scope changes, and the cache is
// scope-tagged, so a left project's documents never show here. Before a project is chosen the page shows the same
// first screen as the DG page.

import { useEffect } from 'react'

import { useI18n } from '@/i18n'

import { FirstScreen } from './degram-gate'
import { DocumentsPanel } from './document-picker'
import { refreshDocuments, scopeKeyOf } from './documents-store'
import { useDegram } from './use-degram-state'

export function ModelsPage() {
  const { t } = useI18n()
  const copy = t.degram
  const degram = useDegram()
  const key = scopeKeyOf(degram)

  // A read of the loopback bridges (not a request): on open, and again when another project becomes ready.
  useEffect(() => {
    if (key) {
      void refreshDocuments()
    }
  }, [key])

  if (!key) {
    return (
      <section className="h-full min-h-0 overflow-hidden" data-testid="degram-models-page">
        <FirstScreen />
      </section>
    )
  }

  return (
    <section className="h-full min-h-0 overflow-y-auto px-6 py-4" data-testid="degram-models-page">
      <div className="mx-auto grid w-full max-w-2xl gap-3">
        <h1 className="text-lg font-medium leading-tight">{copy.models.title}</h1>
        <DocumentsPanel />
      </div>
    </section>
  )
}
