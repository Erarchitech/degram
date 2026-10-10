// use-degram-state.ts — the renderer's single mirror of the DeGram bridge (Phase 1301-13).
//
// Authority (apps/desktop/AGENTS.md "Decide state by authority"): Electron main owns the DG session, the
// scope and the DG view; the renderer paints from a cache of `degram.getState()` / `onState`. One module-level
// store with ONE subscription (`startDegramSync`, mounted by the shell host) so the scope strip, the gate, the
// DG page and the picker never subscribe separately, and one-shot events (toasts) fire once, not once per
// consumer. Nothing here holds a credential: the bridge has no getter for one.

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { createContext, useContext } from 'react'

import { translateNow } from '@/i18n/runtime'
import { notify } from '@/store/notifications'

import type { DegramBridge, DegramState } from '../../electron/degram/ipc'
import type { DegramEvent } from '../../electron/degram/scope'

import { type NewScopeHandler, routeDisagreesWithScope } from './scope-route'

/** A boot refusal main reported (plan 04: HOME_OVERLAP). */
export interface DegramBootError {
  code: string
  /** The overlapping Hermes path, shown in full. */
  path: string
}

export interface DegramStore {
  /** The first state arrived (or was found missing). Before that the shell shows the connecting loader. */
  loaded: boolean
  state: DegramState | null
  /** The DG view finished a load for the page it currently shows. */
  painted: boolean
  /** A 401 ended the session: the sign-in view carries the session-ended copy above it. */
  sessionEnded: boolean
  accessRevoked: { project: string } | null
  pairingNotice: 'revoked' | 'required' | null
  backendFailed: { project: string } | null
  bootError: DegramBootError | null
  /** State of an explicit refresh (the project picker's list). */
  refresh: 'idle' | 'loading' | 'error'
}

const INITIAL: DegramStore = {
  loaded: false,
  state: null,
  painted: false,
  sessionEnded: false,
  accessRevoked: null,
  pairingNotice: null,
  backendFailed: null,
  bootError: null,
  refresh: 'idle'
}

export const $degram = atom<DegramStore>(INITIAL)

// A load finished (`dg-reachable`) since the last state arrived. Events precede the state they cause, so a
// page change that follows its own paint event must not reset `painted`.
let reachableSinceState = false
let activeBridge: DegramBridge | null = null
// undefined: no scope observed yet. null: observed without a ready scope. number: the epoch already handled.
let handledEpoch: null | number | undefined

export function resetDegramStore(): void {
  $degram.set(INITIAL)
  reachableSinceState = false
  activeBridge = null
  handledEpoch = undefined
}

export function useDegram(): DegramStore {
  return useStore($degram)
}

/** The bridge the renderer talks to; `undefined` outside the DeGram variant or in a plain browser. */
export function degramBridge(): DegramBridge | undefined {
  return activeBridge ?? (typeof window === 'undefined' ? undefined : window.hermesDesktop?.degram)
}

function applyState(state: DegramState): void {
  const prev = $degram.get()
  const pageChanged = prev.state !== null && prev.state.dg.page !== state.dg.page
  const first = prev.state === null

  const signedOut = state.auth.kind !== 'signed-in'

  $degram.set({
    ...prev,
    loaded: true,
    state,
    painted: first
      ? state.dg.page !== 'blank' && state.dg.reachable
      : pageChanged
        ? reachableSinceState
        : state.dg.reachable
          ? prev.painted
          : false,
    sessionEnded: state.auth.kind === 'signed-in' ? false : prev.sessionEnded,
    pairingNotice: signedOut ? null : state.pairing.status === 'revoked' ? 'revoked' : (state.pairing.status === 'stored' || state.pairing.status === 'connected' ? null : prev.pairingNotice),
    backendFailed: signedOut || state.scope.status === 'ready' ? null : state.scope.error === 'BACKEND_START_FAILED' && state.scope.project ? { project: state.scope.project } : prev.backendFailed,
    accessRevoked: signedOut || state.scope.status === 'ready' ? null : prev.accessRevoked
  })
  reachableSinceState = false
}

/**
 * What the shell must do for this observation of the scope: `new` once per newly ready scope epoch (a selection the
 * shell has not handled yet: a fresh chat opens for it, D-19), `restore` once when the scope was already ready at the
 * first observation but the chat's gateway route is not on its profile (a route restored from the previous run, UAT
 * 6.1: the route moves, no fresh chat), `null` otherwise. A scope already ready AND already routed at the first
 * observation is only recorded, so a reload never disturbs a session restore.
 */
function noteScope(state: DegramState): 'new' | 'restore' | null {
  const { epoch, status } = state.scope

  if (handledEpoch === undefined) {
    handledEpoch = status === 'ready' ? epoch : null

    return status === 'ready' && routeDisagreesWithScope(state) ? 'restore' : null
  }

  if (status === 'ready' && handledEpoch !== epoch) {
    handledEpoch = epoch

    return 'new'
  }

  return null
}

function handleEvent(event: DegramEvent, bridge: DegramBridge): void {
  switch (event.type) {
    case 'session-ended':
      $degram.set({ ...$degram.get(), sessionEnded: true, painted: false })

      return

    case 'access-revoked':
      $degram.set({ ...$degram.get(), accessRevoked: { project: event.project } })
      notify({
        kind: 'warning',
        message: translateNow('degram.errors.accessRevoked', event.project)
      })

      return
    case 'external-link-blocked': {
      const { url } = event

      notify({
        kind: 'info',
        message: translateNow('degram.dgPage.externalBlocked'),
        action: {
          label: translateNow('degram.dgPage.openInBrowser'),
          // Opening the system browser is an explicit user act: it runs from this click only.
          onClick: () => void bridge.openExternalConfirmed(url)
        }
      })

      return
    }

    case 'dg-unreachable':
      reachableSinceState = false
      $degram.set({ ...$degram.get(), painted: false })

      return

    case 'dg-reachable':
      reachableSinceState = true
      $degram.set({ ...$degram.get(), painted: true })

      return

    case 'pairing-revoked':
      $degram.set({ ...$degram.get(), pairingNotice: 'revoked' })
      return

    case 'pairing-required':
      $degram.set({ ...$degram.get(), pairingNotice: 'required' })
      return

    case 'backend-start-failed':
      $degram.set({ ...$degram.get(), backendFailed: { project: event.project } })
      return
  }
}

/**
 * Subscribe once to the bridge. Returns the disposer. Safe to call with no bridge (other variants): the store
 * then stays at its initial value and the gate renders nothing.
 */
export function startDegramSync(
  bridge: DegramBridge | undefined = degramBridge(),
  onNewScope?: NewScopeHandler
): () => void {
  if (!bridge) {
    return () => undefined
  }

  activeBridge = bridge
  let disposed = false

  const take = (state: DegramState): void => {
    applyState(state)

    const scope = noteScope(state)

    if (scope) {
      onNewScope?.(state, { fresh: scope === 'new' })
    }
  }

  const offState = bridge.onState(state => {
    if (!disposed) {
      take(state)
    }
  })

  const offEvent = bridge.onEvent(event => {
    if (!disposed) {
      handleEvent(event, bridge)
    }
  })

  void bridge
    .getState()
    .then(state => {
      if (!disposed) {
        take(state)
      }
    })
    .catch(() => {
      if (!disposed) {
        $degram.set({ ...$degram.get(), loaded: true })
      }
    })

  return () => {
    disposed = true
    offState()
    offEvent()

    if (activeBridge === bridge) {
      activeBridge = null
    }
  }
}

/** Re-read the state from main (the project picker's `fetchProjects`): loading, then idle or error. */
export async function refreshDegramState(): Promise<void> {
  const bridge = degramBridge()

  if (!bridge) {
    return
  }

  $degram.set({ ...$degram.get(), refresh: 'loading' })

  try {
    applyState(await bridge.getState())
    $degram.set({ ...$degram.get(), refresh: 'idle' })
  } catch {
    $degram.set({ ...$degram.get(), refresh: 'error' })
  }
}

/** Show the runtime-isolation failure in the window (or clear it). */
export function setDegramBootError(error: DegramBootError | null): void {
  $degram.set({ ...$degram.get(), bootError: error })
}

/**
 * Recognize main's isolation refusal (`DegramIsolationError` message) and extract the overlapping Hermes path
 * from it. `null` for any other text, so the stock boot-failure overlay keeps every other failure.
 */
export function parseIsolationBootError(message: string | null | undefined): DegramBootError | null {
  if (!message || !message.includes('HOME_OVERLAP')) {
    return null
  }

  const path = /Hermes home "([^"]+)"/.exec(message)?.[1]

  return path ? { code: 'HOME_OVERLAP', path } : null
}

/** What the picker and sign-in controls may ask the surrounding app to do. Provided by the shell host. */
export interface DegramActions {
  /** Stop the running response (one Stop, synchronous in the UI; main-side cancellation is plan 14). */
  stopResponse: () => Promise<void>
  /** Open a fresh chat for the scope that was just selected (D-19); the shell host moves the route first (G-7). */
  startNewChat: () => void
}

export const DegramActionsContext = createContext<DegramActions>({
  stopResponse: async () => (await import('./host-actions')).stopActiveResponse(),
  startNewChat: () => void import('./host-actions').then(m => m.startFreshChat())
})

export function useDegramActions(): DegramActions {
  return useContext(DegramActionsContext)
}

export function dismissDegramNotice(kind: 'access' | 'pairing' | 'backend'): void {
  const current = $degram.get()
  $degram.set({ ...current, accessRevoked: kind === 'access' ? null : current.accessRevoked, pairingNotice: kind === 'pairing' ? null : current.pairingNotice, backendFailed: kind === 'backend' ? null : current.backendFailed })
}
