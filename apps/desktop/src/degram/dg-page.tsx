// dg-page.tsx — the DG page, next to Chat (D-07, 1301-UI-SPEC E6).
//
// The page is a toolbar row plus a placeholder: the DG web itself is a native WebContentsView that Electron main
// positions over the placeholder (partition `persist:degram-dg`, exact-origin allowlist, no Node, no preload). The
// shell page never scrolls; the web view owns its own scrolling. The view stays mounted while the page is hidden
// (visibility is not lifecycle), so leaving the page only hides it. Before sign-in or a project choice the page
// shows the same project EmptyState as the gate, never a blank view.

import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'

import { FirstScreen } from './degram-gate'
import { DgConnecting, DgUnreachable } from './sign-in-state'
import { degramBridge, useDegram } from './use-degram-state'
import { useDgBounds } from './use-dg-bounds'

export function DgPage() {
  const { t } = useI18n()
  const copy = t.degram
  const { painted, state } = useDegram()
  const bridge = degramBridge()
  const hostRef = useRef<HTMLDivElement>(null)

  const signedIn = state?.auth.kind === 'signed-in'
  const ready = signedIn && state.scope.status === 'ready'
  const unreachable = ready && state.dg.reachable === false
  const mode = state?.dg.mode
  const page = state?.dg.page

  // Bring the DG view to the DG page once a project is open. Main only loads the DG web on a sign-in transition,
  // so a returning session (or a scope reopened after a revocation) starts from a blank view: setting the mode is
  // the idempotent "show it". The mode is always the whole DG app (D-42: the graph/full switch is gone, the sidebar
  // steers the region), so it also corrects a view that still shows the #degram slice. It fires only for a blank or
  // slice view, never on its own echo.
  useEffect(() => {
    if (ready && (page === 'blank' || mode === 'graph')) {
      void bridge?.setDgMode('full')
    }
  }, [bridge, mode, page, ready])

  useDgBounds(hostRef, ready && painted && !unreachable)

  if (!ready) {
    return (
      <section className="h-full min-h-0 overflow-hidden" data-testid="dg-page">
<FirstScreen />
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="dg-page">
      <div className="flex shrink-0 items-center justify-end px-6 py-1">
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
