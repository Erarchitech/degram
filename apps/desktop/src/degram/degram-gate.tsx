// degram-gate.tsx — what the DeGram variant shows INSTEAD of the app until the user may work (focal points 1-2).
//
// Decides one surface from the bridge state: the runtime-isolation failure, the sign-in surface, the project
// choice, or nothing. While it renders anything the composer is unreachable (no request can be composed without
// an explicit scope); once a project is open it renders nothing and the app is untouched. It sits on the
// `--z-setup` rung of the boot chain, above the app and below crash.

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogPortalContainerContext } from '@/components/ui/dialog-portal-context'
import { useI18n } from '@/i18n'

import { IsolationBootFailure } from './isolation-boot-failure'
import { PairingPanel } from './pairing-panel'
import { DgConnecting, DgUnreachable, SignInState } from './sign-in-state'
import { degramBridge, dismissDegramNotice, refreshDegramState, useDegram } from './use-degram-state'

function Surface({ children }: { children: React.ReactNode }) {
  // Popovers opened from inside the surface (the project picker) portal into it: a body-level popover would sit
  // below the `--z-setup` rung this surface owns.
  const [node, setNode] = useState<HTMLElement | null>(null)

  return (
    <div
      className="fixed inset-x-0 top-0 bottom-5 z-(--z-setup) flex flex-col bg-background text-foreground"
      data-testid="degram-gate"
      ref={setNode}
    >
      {/* Keeps the native window drag handle reachable above the surface. */}
      <div className="h-8 shrink-0 [-webkit-app-region:drag]" />
      <DialogPortalContainerContext.Provider value={node}>
        <div className="min-h-0 flex-1">{children}</div>
      </DialogPortalContainerContext.Provider>
    </div>
  )
}

/** Retry for a DG-unreachable choice: main re-checks DG and reloads the view, then the state is re-read (G-16). */
async function retryDgAndRefresh(): Promise<void> {
  await degramBridge()?.retryDg()
  await refreshDegramState()
}

/** The single start screen, before sign-in and until an explicit project is open. */
export function FirstScreen() {
  const { t } = useI18n()
  const { accessRevoked, backendFailed, pairingNotice, state } = useDegram()
  const signedIn = state?.auth.kind === 'signed-in'
  const hasPairing = state?.pairing.status === 'stored' || state?.pairing.status === 'connected'
  const opening = state?.scope.status === 'opening'
  const unreachable = state?.dg.reachable === false || state?.scope.error === 'DG_UNREACHABLE'

  return <SignInState>
    <div className="grid w-full max-w-prose gap-2" data-testid="degram-first-screen">
      {accessRevoked && <Notice onDismiss={() => dismissDegramNotice('access')}>{t.degram.errors.accessRevoked(accessRevoked.project)}</Notice>}
      {pairingNotice && <Notice onDismiss={() => dismissDegramNotice('pairing')}>{pairingNotice === 'revoked' ? t.degram.pairing.revokedNotice : t.degram.pairing.requiredNotice}</Notice>}
      {backendFailed && <Notice onDismiss={() => dismissDegramNotice('backend')} action={() => void degramBridge()?.selectProject(backendFailed.project)}>{t.degram.errors.backendStartFailed(backendFailed.project)}</Notice>}
    </div>
    {signedIn && !hasPairing && <PairingPanel focusRequest={pairingNotice !== null} />}
    {opening && !unreachable && <DgConnecting label={t.degram.signIn.connecting} />}
    {state?.scope.error === 'DG_UNREACHABLE' && state.dg.reachable && <DgUnreachable action={() => void retryDgAndRefresh()} actionLabel={t.degram.cta.retry} />}
  </SignInState>
}

function Notice({ children, onDismiss, action }: { children: React.ReactNode; onDismiss: () => void; action?: () => void }) {
  const { t } = useI18n()
  return <div role="status" className="flex gap-2 text-sm"><span>{children}</span>{action && <Button onClick={action} variant="secondary">{t.degram.cta.retry}</Button>}<Button aria-label={t.degram.notice.dismiss} onClick={onDismiss} variant="text">×</Button></div>
}

export function DegramGate() {
  const { bootError, loaded, state } = useDegram()

  if (bootError) {
    return (
      <Surface>
        <IsolationBootFailure code={bootError.code} path={bootError.path} />
      </Surface>
    )
  }

  if (!loaded || state?.auth.kind !== 'signed-in' || state.scope.status !== 'ready') {
    return <Surface><FirstScreen /></Surface>
  }

  return null
}
