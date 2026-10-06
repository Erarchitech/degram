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
  bootError: DegramBootError | null
  /** State of an explicit refresh (the project picker's list). */
  refresh: 'idle' | 'loading' | 'error'
}

const INITIAL: DegramStore = {
  loaded: false,
  state: null,
  painted: false,
  sessionEnded: false,
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
    // Signing in again retires the session-ended notice; an unreachable DG must not.
    sessionEnded: state.auth.kind === 'signed-in' ? false : prev.sessionEnded
  })
  reachableSinceState = false
}

/**
 * True once per newly ready scope: a selection the shell has not handled yet means a new scope epoch, so a fresh
 * chat opens for it (D-19). A scope that is already ready at the first observation is only recorded, so a reload
 * never disturbs a session restore.
 */
function noteScope(state: DegramState): boolean {
  const { epoch, status } = state.scope

  if (handledEpoch === undefined) {
    handledEpoch = status === 'ready' ? epoch : null

    return false
  }

  if (status === 'ready' && handledEpoch !== epoch) {
    handledEpoch = epoch

    return true
  }

  return false
}

function handleEvent(event: DegramEvent, bridge: DegramBridge): void {
  switch (event.type) {
    case 'session-ended':
      $degram.set({ ...$degram.get(), sessionEnded: true, painted: false })

      return

    case 'access-revoked':
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
      // Phase 1301-17: the scope closed; the pairing panel in the project choice asks for a new token.
      notify({ kind: 'warning', message: translateNow('degram.pairing.revoked') })

      return
  }
}

/**
 * Subscribe once to the bridge. Returns the disposer. Safe to call with no bridge (other variants): the store
 * then stays at its initial value and the gate renders nothing.
 */
export function startDegramSync(
  bridge: DegramBridge | undefined = degramBridge(),
  onNewScope?: () => void
): () => void {
  if (!bridge) {
    return () => undefined
  }

  activeBridge = bridge
  let disposed = false

  const take = (state: DegramState): void => {
    applyState(state)

    if (noteScope(state)) {
      onNewScope?.()
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
  /** Open a fresh chat for the scope that was just selected (D-19). */
  startNewChat: () => void
}

export const DegramActionsContext = createContext<DegramActions>({
  stopResponse: async () => (await import('./host-actions')).stopActiveResponse(),
  startNewChat: () => void import('./host-actions').then(m => m.startFreshChat())
})

export function useDegramActions(): DegramActions {
  return useContext(DegramActionsContext)
}
