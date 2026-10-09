// dg-page.tsx — the DG page, next to Chat (D-07, 1301-UI-SPEC E6).
//
// The page is a toolbar row plus a placeholder: the DG web itself is a native WebContentsView that Electron main
// positions over the placeholder (partition `persist:degram-dg`, exact-origin allowlist, no Node, no preload). The
// shell page never scrolls; the web view owns its own scrolling. The view stays mounted while the page is hidden
// (visibility is not lifecycle), so leaving the page only hides it. Before sign-in or a project choice the page
// shows the same project EmptyState as the gate, never a blank view.

import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'

import { ProjectChoice } from './degram-gate'
import { DgConnecting, DgUnreachable } from './sign-in-state'
import { degramBridge, useDegram } from './use-degram-state'
import { useDgBounds } from './use-dg-bounds'

type DgMode = 'full' | 'graph'

export function DgPage() {
  const { t } = useI18n()
  const copy = t.degram
  const { painted, state } = useDegram()
  const bridge = degramBridge()
  const hostRef = useRef<HTMLDivElement>(null)

  const signedIn = state?.auth.kind === 'signed-in'
  const ready = signedIn && state.scope.status === 'ready'
  const unreachable = ready && state.dg.reachable === false
  const mode: DgMode = state?.dg.mode ?? 'graph'
  const page = state?.dg.page

  // Bring the DG view to the DG page once a project is open. Main only loads the DG web on a sign-in transition,
  // so a returning session (or a scope reopened after a revocation) starts from a blank view: setting the current
  // mode is the idempotent "show it". It fires only while the view is blank, never on the mode change itself.
  useEffect(() => {
    if (ready && page === 'blank') {
      void bridge?.setDgMode(mode)
    }
  }, [bridge, mode, page, ready])

  useDgBounds(hostRef, ready && painted && !unreachable)

  if (!ready) {
    return (
      <section className="h-full min-h-0 overflow-hidden" data-testid="dg-page">
        {signedIn ? (
          <ProjectChoice />
        ) : (
          <div className="grid h-full place-items-center px-6">
            <EmptyState
              className="min-h-0"
              description={copy.empty.noProject.body}
              title={copy.empty.noProject.title}
            />
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="dg-page">
      <div className="flex shrink-0 items-center justify-between px-6 py-1">
        <SegmentedControl<DgMode>
          onChange={next => void bridge?.setDgMode(next)}
          options={[
            { id: 'graph', label: copy.cta.dgGraph },
            { id: 'full', label: copy.cta.dgFull }
          ]}
          value={mode}
        />
        <Button
          aria-label={copy.dgPage.reloadAria}
          onClick={() => void bridge?.reloadDg()}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCw />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1" ref={hostRef}>
        {unreachable ? (
          <div className="grid h-full place-items-center">
            <DgUnreachable action={() => void bridge?.retryDg()} actionLabel={copy.dgPage.reloadPage} />
          </div>
        ) : !painted ? (
          <div className="grid h-full place-items-center">
            <DgConnecting label={copy.signIn.connecting} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
