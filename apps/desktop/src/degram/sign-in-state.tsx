// sign-in-state.tsx — the not-signed-in surface (D-05, 1301-UI-SPEC focal point 1, E7).
//
// The login page is the existing ui-v2 page, opened top-level in the isolated DG partition by Electron main and
// shown in a native view. This component owns what surrounds it: the wordmark fixed above, the session-ended
// notice (after a 401) above the view, the Connecting-to-DG loader until the page paints, and the unreachable
// ErrorState. DeGram adds no form of its own.

import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { degramBridge, useDegram } from './use-degram-state'
import { useDgBounds } from './use-dg-bounds'

/** The text wordmark: Oswald 500, uppercase, 0.02em tracking (UI-SPEC Display role). Brand moments only. */
export function DegramWordmark({ className }: { className?: string }) {
  const { t } = useI18n()

  return (
    <span
      className={cn(
        'font-(family-name:--degram-font-display) text-[1.75rem] leading-[1.1] font-medium tracking-[0.02em] text-foreground uppercase',
        className
      )}
      data-testid="degram-wordmark"
    >
      {t.degram.brand}
    </span>
  )
}

/** The shared long-operation Loader with its visible label. Never the literal "Loading…". */
export function DgConnecting({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <Loader label={label} type="lemniscate-bloom" />
      <span className="font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground">{label}</span>
    </div>
  )
}

/** The DG-unreachable ErrorState: the contract copy as the body, one recovery action. No invented title. */
export function DgUnreachable({ action, actionLabel }: { action: () => void; actionLabel: string }) {
  const { t } = useI18n()

  return (
    <ErrorState description={t.degram.errors.dgUnreachable} title={null}>
      <Button onClick={action} variant="secondary">
        {actionLabel}
      </Button>
    </ErrorState>
  )
}

export function SignInState({ children }: { children?: React.ReactNode } = {}) {
  const { t } = useI18n()
  const copy = t.degram
  const { loaded, painted, sessionEnded, state } = useDegram()
  const hostRef = useRef<HTMLDivElement>(null)
  const unreachable = state?.dg.reachable === false
  // The native view stays hidden until the login page painted, so the loader is never covered by a blank view.
  const showView = loaded && painted && !unreachable

  useDgBounds(hostRef, showView)

  return (
    <section className="flex h-full min-h-0 flex-col items-center gap-8 px-6 pt-12 pb-6" data-testid="degram-sign-in">
      <DegramWordmark />

      {children}

      {sessionEnded && (
        <p className="max-w-prose text-center text-[0.8125rem] leading-[1.4] text-muted-foreground" role="status">
          {copy.errors.sessionEnded}
        </p>
      )}

      <div className="relative min-h-0 w-full flex-1" ref={hostRef}>
        {unreachable ? (
          <div className="grid h-full place-items-center">
            <DgUnreachable action={() => void degramBridge()?.retryDg()} actionLabel={copy.cta.retry} />
          </div>
        ) : !showView ? (
          <div className="grid h-full place-items-center">
            <DgConnecting label={copy.signIn.connecting} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
