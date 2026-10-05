// shell-host.tsx — the one mount point of the DeGram shell surfaces (Phase 1301-13).
//
// Mounted once by the app shell, only when the product-identity flag says variant `degram`, so every other
// variant renders exactly what it did before. It owns the single bridge subscription, contributes the scope strip
// to the statusbar (the same registry call a plugin uses), turns a scope change into a fresh chat (D-19: the
// previous project's transcript is never reused), and renders the gate that stands in for the app until the user
// is signed in with a project chosen.

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { navigateToWorkspacePage, NEW_CHAT_ROUTE } from '@/app/routes'
import { registry } from '@/contrib'
import { $desktopBoot } from '@/store/boot'
import { requestFreshSession } from '@/store/profile'

import { DegramGate } from './degram-gate'
import { stopActiveResponse } from './host-actions'
import { ScopeStrip } from './scope-strip'
import {
  type DegramActions,
  DegramActionsContext,
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
    render: () => <ScopeStrip />
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
      }
    }),
    [navigate]
  )

  // A newly ready scope opens a fresh chat for it (D-19): the previous project's transcript is never reused.
  useEffect(() => startDegramSync(undefined, actions.startNewChat), [actions])
  useEffect(() => registerScopeStrip(), [])

  // A refusal that reached the renderer through the boot state (plan 04: HOME_OVERLAP) is shown by the gate,
  // with the full path and no continue action, instead of the stock recovery overlay.
  useEffect(() => {
    setDegramBootError(parseIsolationBootError(boot.error))
  }, [boot.error])

  return (
    <DegramActionsContext.Provider value={actions}>
      <DegramGate />
      {children}
    </DegramActionsContext.Provider>
  )
}
