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
import { setConnectionScopeTag } from '@/lib/connection-scoped'
import { notify } from '@/store/notifications'

import type { EnvironmentViewState } from '../../electron/degram/environment-controller'
import type { DegramBridge, DegramState, EnvironmentStamp, OperationStamp } from '../../electron/degram/ipc'
import type { DegramEvent } from '../../electron/degram/scope'

import { degramScopeTag, invalidateScopeRoute, type NewScopeHandler, routeDisagreesWithScope } from './scope-route'

/** A boot refusal main reported (plan 04: HOME_OVERLAP). */
export interface DegramBootError {
  code: string
  /** The overlapping Hermes path, shown in full. */
  path: string
}

export interface DegramStore {
  environment?: EnvironmentViewState | null
  /** The first state arrived (or was found missing). Before that the shell shows the connecting loader. */
  loaded: boolean
  state: DegramState | null
  /** The DG view finished a load for the page it currently shows. */
  painted: boolean
  /** A 401 ended the session: the sign-in view carries the session-ended copy above it. */
  sessionEnded: boolean
  accessRevoked: { project: string } | null
  grantRequired: { project: string } | null
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
  grantRequired: null,
  backendFailed: null,
  bootError: null,
  refresh: 'idle'
}

export const $degram = atom<DegramStore>(INITIAL)
const environmentResetters = new Set<() => void>()

export function onEnvironmentReset(reset: () => void): () => void {
  environmentResetters.add(reset)

  return () => {
    environmentResetters.delete(reset)
  }
}

// A load finished (`dg-reachable`) since the last state arrived. Events precede the state they cause, so a
// page change that follows its own paint event must not reset `painted`.
let reachableSinceState = false
let activeBridge: DegramBridge | null = null
// undefined: no scope observed yet. null: observed without a ready scope. number: the epoch already handled.
let handledEpoch: null | string | undefined
// The shell host's reaction to the DG page's «Новая сессия» pill (D-41).
let newSessionHandler: (() => void) | undefined
let stateRevision = 0
let takeRuntimeState: ((state: DegramState) => void) | undefined

export function resetDegramStore(): void {
  $degram.set(INITIAL)
  reachableSinceState = false
  activeBridge = null
  handledEpoch = undefined
  newSessionHandler = undefined
  takeRuntimeState = undefined
  stateRevision++
  setConnectionScopeTag(null)
}

export function useDegram(): DegramStore {
  return useStore($degram)
}

/** The bridge the renderer talks to; `undefined` outside the DeGram variant or in a plain browser. */
export function degramBridge(): DegramBridge | undefined {
  return activeBridge ?? (typeof window === 'undefined' ? undefined : window.hermesDesktop?.degram)
}

export function environmentStamp(): EnvironmentStamp | null {
  const target = $degram.get().environment

  return target?.selected ? { environmentId: target.selected.environmentId, generation: target.generation } : null
}

export function isCurrentEnvironment(stamp: EnvironmentStamp | null | undefined): boolean {
  const target = $degram.get().environment

  if (!target) {
    return !stamp
  } // legacy isolated-runtime tests only

  return Boolean(
    stamp &&
    target.selected &&
    target.generation === stamp.generation &&
    target.selected.environmentId === stamp.environmentId
  )
}

export function isEnvironmentReady(target: EnvironmentViewState | null | undefined): boolean {
  if (!target) {
    return true
  } // A standalone runtime has no environment coordinator.

  const selected = target.selected
  const effective = target.effectiveRuntime

  return Boolean(
    target.status === 'ready' &&
    selected &&
    effective &&
    (selected.mode === 'developer' || selected.mode === 'demo') &&
    selected.mode === effective.mode &&
    selected.origin === effective.origin &&
    selected.environmentId === effective.environmentId &&
    selected.partition === effective.partition
  )
}

export async function acquireEnvironmentOperation(): Promise<(() => Promise<void>) | null> {
  const bridge = degramBridge()
  const stamp = environmentStamp()

  if (!$degram.get().environment) {
    return async () => undefined
  }

  if (!bridge || !stamp || !isEnvironmentReady($degram.get().environment)) {
    return null
  }

  let lease: OperationStamp

  try {
    lease = await bridge.acquireOperation(stamp)
  } catch {
    return null
  }

  if (!isCurrentEnvironment(lease) || !isEnvironmentReady($degram.get().environment)) {
    await bridge.releaseOperation(lease)

    return null
  }

  let released = false

  return async () => {
    if (!released) {
      released = true
      await bridge.releaseOperation(lease)
    }
  }
}

function applyState(state: DegramState): void {
  if (!isCurrentEnvironment(state.environment)) {
    return
  }

  const prev = $degram.get()
  const pageChanged = prev.state !== null && prev.state.dg.page !== state.dg.page
  const first = prev.state === null

  const signedOut = state.auth.kind !== 'signed-in'

  // A project that STAYS open keeps the notice of a refused pick (grant-required / access-revoked for another
  // project, 1301-37 F-07): a state of the same scope epoch does not clear it. Opening a project (a new epoch) does.
  const openedNew =
    state.scope.status === 'ready' &&
    (prev.state?.scope.status !== 'ready' || prev.state.scope.epoch !== state.scope.epoch)

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
    grantRequired: signedOut || openedNew ? null : prev.grantRequired,
    backendFailed:
      signedOut || state.scope.status === 'ready'
        ? null
        : state.scope.error === 'BACKEND_START_FAILED' && state.scope.project
          ? { project: state.scope.project }
          : prev.backendFailed,
    accessRevoked: signedOut || openedNew ? null : prev.accessRevoked
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
  const { status } = state.scope

  const epoch = JSON.stringify([
    state.environment ?? null,
    state.auth.username,
    state.scope.company,
    state.scope.project,
    state.scope.epoch
  ])

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

    case 'grant-required':
      $degram.set({ ...$degram.get(), grantRequired: { project: event.project } })

      return

    case 'backend-start-failed':
      $degram.set({ ...$degram.get(), backendFailed: { project: event.project } })

      return

    case 'new-session-requested':
      // Main forwards the pill only while a scope is ready; the renderer checks its own mirror too.
      if ($degram.get().state?.scope.status === 'ready') {
        newSessionHandler?.()
      }

      return
  }
}

/**
 * Subscribe once to the bridge. Returns the disposer. Safe to call with no bridge (other variants): the store
 * then stays at its initial value and the gate renders nothing.
 */
export function startDegramSync(
  bridge: DegramBridge | undefined = degramBridge(),
  onNewScope?: NewScopeHandler,
  onNewSession?: () => void
): () => void {
  if (!bridge) {
    return () => undefined
  }

  activeBridge = bridge
  newSessionHandler = onNewSession
  let disposed = false

  let stateEventSeen = false
  let environmentEventSeen = false
  let pendingState: DegramState | null = null

  const takeEnvironment = (environment: EnvironmentViewState): void => {
    const previous = $degram.get().environment

    if (previous && environment.generation < previous.generation) {
      return
    }

    if (
      previous?.selected &&
      environment.selected &&
      previous.generation === environment.generation &&
      previous.selected.environmentId !== environment.selected.environmentId
    ) {
      return
    }

    const changed =
      previous?.generation !== environment.generation ||
      previous?.selected?.environmentId !== environment.selected?.environmentId

    stateRevision++

    if (changed) {
      handledEpoch = undefined
      reachableSinceState = false
      setConnectionScopeTag('no-scope')
      invalidateScopeRoute()

      for (const reset of environmentResetters) {
        reset()
      }

      $degram.set({ ...INITIAL, loaded: true, environment })
    } else {
      $degram.set({ ...$degram.get(), environment })
    }

    if (environment.status === 'ready' && pendingState) {
      const pending = pendingState
      pendingState = null
      take(pending)
    }
  }

  const take = (state: DegramState): void => {
    const environment = $degram.get().environment

    if (
      state.environment &&
      (!environment ||
        state.environment.generation > environment.generation ||
        (isCurrentEnvironment(state.environment) && environment.status === 'switching'))
    ) {
      if (!pendingState?.environment || state.environment.generation >= pendingState.environment.generation) {
        pendingState = state
      }

      return
    }

    if (!isCurrentEnvironment(state.environment) || !isEnvironmentReady(environment)) {
      return
    }

    stateRevision++
    // Scope-keyed stores (pins) move first, so nothing paints the previous scope's list under the new state.
    setConnectionScopeTag(degramScopeTag(state))
    applyState(state)

    const scope = noteScope(state)

    if (scope) {
      onNewScope?.(state, { fresh: scope === 'new' })
    }
  }

  takeRuntimeState = take

  const offState = bridge.onState(state => {
    if (!disposed) {
      stateEventSeen = true
      take(state)
    }
  })

  const offEnvironment = bridge.onEnvironment(environment => {
    if (!disposed) {
      environmentEventSeen = true
      takeEnvironment(environment)
    }
  })

  void bridge
    .getEnvironment()
    .then(environment => {
      if (!disposed && !environmentEventSeen) {
        takeEnvironment(environment)
      }
    })
    .catch(() => undefined)

  const offEvent = bridge.onEvent(event => {
    if (
      !disposed &&
      isCurrentEnvironment(event.environment) &&
      (!$degram.get().environment || $degram.get().environment?.status === 'ready')
    ) {
      stateRevision++
      handleEvent(event, bridge)
    }
  })

  void bridge
    .getState()
    .then(state => {
      if (!disposed && !stateEventSeen) {
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
    offEnvironment()

    if (activeBridge === bridge) {
      activeBridge = null
      newSessionHandler = undefined
      takeRuntimeState = undefined
    }
  }
}

/** Re-read the state from main (the project picker's `fetchProjects`): loading, then idle or error. */
export async function refreshDegramState(): Promise<void> {
  const bridge = degramBridge()

  if (!bridge) {
    return
  }

  const stamp = environmentStamp()
  const revision = stateRevision
  $degram.set({ ...$degram.get(), refresh: 'loading' })

  try {
    const state = await bridge.getState()

    if (!isCurrentEnvironment(stamp)) {
      return
    }

    if (revision === stateRevision) {
      ;(takeRuntimeState ?? applyState)(state)
    }

    $degram.set({ ...$degram.get(), refresh: 'idle' })
  } catch {
    if (isCurrentEnvironment(stamp)) {
      $degram.set({ ...$degram.get(), refresh: 'error' })
    }
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
  /** Show the DG page's ring for a newly ready scope: reset the draft without leaving the route (D-41). */
  showRing: () => void
}

export const DegramActionsContext = createContext<DegramActions>({
  stopResponse: async () => (await import('./host-actions')).stopActiveResponse(),
  startNewChat: () => void import('./host-actions').then(m => m.startFreshChat()),
  showRing: () => void import('./host-actions').then(m => m.startFreshChat({ preserveRoute: true }))
})

export function useDegramActions(): DegramActions {
  return useContext(DegramActionsContext)
}

export function dismissDegramNotice(kind: 'access' | 'grant' | 'backend'): void {
  const current = $degram.get()
  $degram.set({
    ...current,
    accessRevoked: kind === 'access' ? null : current.accessRevoked,
    grantRequired: kind === 'grant' ? null : current.grantRequired,
    backendFailed: kind === 'backend' ? null : current.backendFailed
  })
}
