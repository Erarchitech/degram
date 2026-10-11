// shell-host.tsx — the one mount point of the DeGram shell surfaces (Phase 1301-13).
//
// Mounted once by the app shell, only when the product-identity flag says variant `degram`, so every other
// variant renders exactly what it did before. It owns the single bridge subscription, contributes the scope strip
// to the statusbar (the same registry call a plugin uses), turns a scope change into a fresh chat (D-19: the
// previous project's transcript is never reused), and renders the gate that stands in for the app until the user
// is signed in with a project chosen.
//
// A newly ready scope stays on the DG page (`/dg`) showing the ring (D-41): the draft is reset with the route
// preserved, and a chat opens only from the DG page's «Новая сессия» pill, the sidebar row or the history.

import './fonts.css'

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { navigateToWorkspacePage, NEW_CHAT_ROUTE } from '@/app/routes'
import { registry } from '@/contrib'
import { getRuntimeI18nLocale, subscribeRuntimeI18nLocale } from '@/i18n/runtime'
import { $desktopBoot } from '@/store/boot'
import { requestFreshSession } from '@/store/profile'

import { registerComposerGate } from './composer-seam'
import { ConnectedScopeStrip } from './connected-scope-strip'
import { DegramGate } from './degram-gate'
import { stopActiveResponse } from './host-actions'
import { registerDgPage } from './register-dg-page'
import { startTurnEventSync } from './request-lifecycle'
import { handleNewScope, startRouteReconcile } from './scope-route'
import { $degramNavRegion, DG_PAGE_PATH } from './sidebar-nav'
import { DegramSignOutConfirm } from './sign-out-confirm'
import {
  $degram,
  type DegramActions,
  DegramActionsContext,
  degramBridge,
  parseIsolationBootError,
  setDegramBootError,
  startDegramSync
} from './use-degram-state'

export const DEGRAM_SCOPE_STRIP_ID = 'degram.scope'

/** Contribute the scope strip to the statusbar's left side. Returns the disposer. */
export function registerScopeStrip(): () => void {
  return registry.register({
    id: DEGRAM_SCOPE_STRIP_ID,
    area: 'statusBar.left',
    source: 'core',
    // After the core items (command center, gateways) so the strip reads as the bar's scope.
    order: 900,
    render: () => <ConnectedScopeStrip />
  })
}

export function DegramShellHost({ children }: { children?: ReactNode }) {
  const navigate = useNavigate()
  const boot = useStore($desktopBoot)

  const actions = useMemo<DegramActions>(
    () => ({
      stopResponse: stopActiveResponse,
      startNewChat: () => {
        requestFreshSession()
        navigateToWorkspacePage(navigate, NEW_CHAT_ROUTE)
      },
      showRing: () => {
        $degramNavRegion.set('landing')
        requestFreshSession({ preserveRoute: true })
        navigateToWorkspacePage(navigate, DG_PAGE_PATH)
      }
    }),
    [navigate]
  )

  // A newly ready scope first moves the chat onto its profile (G-7: main opens one profile and backend per scope,
  // the renderer's route is otherwise whatever the last run restored), then opens a fresh chat for it (D-19): the
  // previous project's transcript is never reused. A route that cannot move opens no chat and Send stays blocked.
  // The new scope lands on the DG page's ring (D-41); the page's «Новая сессия» pill opens the chat.
  useEffect(
    () =>
      startDegramSync(
        undefined,
        (state, opts) => void handleNewScope(state, opts, actions.showRing),
        actions.startNewChat
      ),
    [actions]
  )
  // The DG page renders in the DeGram locale: main appends it to the page URL (next load).
  useEffect(() => {
    const send = () => {
      const locale = getRuntimeI18nLocale() === 'ru' ? 'ru' : 'en'

      void degramBridge()?.setLocale?.(locale)
    }

    send()

    return subscribeRuntimeI18nLocale(send)
  }, [])
  // The boot adopts the primary profile after the shell mounted: a route moved away from the ready scope's profile
  // is brought back, instead of leaving the composer blocked.
  useEffect(() => startRouteReconcile(() => $degram.get().state), [])
  useEffect(() => registerScopeStrip(), [])
  useEffect(() => registerDgPage(), [])
  useEffect(() => registerComposerGate(), [])
  useEffect(() => startTurnEventSync(), [])

  // A refusal that reached the renderer through the boot state (plan 04: HOME_OVERLAP) is shown by the gate,
  // with the full path and no continue action, instead of the stock recovery overlay.
  useEffect(() => {
    setDegramBootError(parseIsolationBootError(boot.error))
  }, [boot.error])

  return (
    <DegramActionsContext.Provider value={actions}>
      <DegramGate />
      <DegramSignOutConfirm />
      {children}
    </DegramActionsContext.Provider>
  )
}
