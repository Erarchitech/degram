// degram-gate.tsx — what the DeGram variant shows INSTEAD of the app until the user may work (focal points 1-2).
//
// Decides one surface from the bridge state: the runtime-isolation failure, the sign-in surface, the project
// choice, or nothing. While it renders anything the composer is unreachable (no request can be composed without
// an explicit scope); once a project is open it renders nothing and the app is untouched. It sits on the
// `--z-setup` rung of the boot chain, above the app and below crash.

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogPortalContainerContext } from '@/components/ui/dialog-portal-context'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'

import { IsolationBootFailure } from './isolation-boot-failure'
import { PairingPanel } from './pairing-panel'
import { ProjectPicker } from './project-picker'
import { DgConnecting, DgUnreachable, SignInState } from './sign-in-state'
import { refreshDegramState, useDegram } from './use-degram-state'

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

/** The content-column choice shown while signed in without a project (also used standalone by the DG page). */
export function ProjectChoice() {
  const { t } = useI18n()
  const copy = t.degram
  const { state } = useDegram()

  if (state?.scope.status === 'opening') {
    return (
      <div className="grid h-full place-items-center">
        <DgConnecting label={copy.signIn.connecting} />
      </div>
    )
  }

  if (state?.scope.status === 'error' && state.scope.error === 'DG_UNREACHABLE') {
    return (
      <div className="grid h-full place-items-center">
        <DgUnreachable action={() => void refreshDegramState()} actionLabel={copy.cta.retry} />
      </div>
    )
  }

  const none = (state?.auth.memberships.length ?? 0) === 0
  const empty = none ? copy.empty.noAccessible : copy.empty.noProject

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="flex max-w-prose flex-col items-center gap-6">
        <EmptyState className="min-h-0" description={empty.body} title={empty.title} />
        {!none && (
          <ProjectPicker>
            <Button variant="secondary">{copy.cta.chooseProject}</Button>
          </ProjectPicker>
        )}
        <PairingPanel />
      </div>
    </div>
  )
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

  if (!loaded || state?.auth.kind !== 'signed-in') {
    return (
      <Surface>
        <SignInState />
      </Surface>
    )
  }

  if (state.scope.status !== 'ready') {
    return (
      <Surface>
        <ProjectChoice />
      </Surface>
    )
  }

  return null
}
