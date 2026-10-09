// scope-route.ts — the chat follows the DeGram scope's profile (Phase 1301-18, G-7, G-3, D-19, DGCL-02).
//
// Authority: Electron main opens one profile and one agent backend per project scope and hands the delegated
// credential to that backend only. The renderer's gateway route (`$activeGatewayProfile`, a mirror of the socket
// registry) is a separate store, restored from the previous run at boot; left alone it keeps the chat on a backend
// that holds no credential for the selected project (CREDENTIALS_MISSING on every turn) and keeps the previous
// project's sessions in the sidebar. So when a scope becomes ready the renderer switches its route to
// `state.scope.profile` before any chat, session list or send uses it, and while the two disagree Send is blocked
// (`sendBlockedReason() === 'route-mismatch'`, `degramPromptSubmit`).
//
// Import discipline: this module reads the route and the scope state it is handed, never the DeGram store, so the
// store (`use-degram-state`) can ask `routeDisagreesWithScope` without a cycle.

import { wipeSessionListsForGatewaySwitch } from '@/store/gateway-switch'
import { $activeGatewayProfile, ensureGatewayProfile, normalizeProfileKey, pinNewChatProfile } from '@/store/profile'

import type { DegramState } from '../../electron/degram/ipc'

export type FollowOutcome = 'agreed' | 'failed' | 'superseded' | 'switched'

export interface FollowOptions {
  /** A fresh chat follows (a scope the user just selected); false for the boot restore of an already open scope. */
  fresh: boolean
}

/** What the shell does with a scope that needs the chat on its profile: `fresh` is true for a newly selected scope. */
export type NewScopeHandler = (state: DegramState, opts: FollowOptions) => void

/**
 * True while a ready scope exists and the renderer's active gateway route is not on that scope's profile. A scope
 * that is not ready has no profile to follow, so it never disagrees (the gate keeps the composer unmounted then).
 */
export function routeDisagreesWithScope(state: DegramState | null | undefined): boolean {
  const scope = state?.scope

  if (!scope || scope.status !== 'ready') {
    return false
  }

  // A ready scope with no profile cannot be followed: nothing may send under it.
  if (!scope.profile) {
    return true
  }

  return normalizeProfileKey($activeGatewayProfile.get()) !== normalizeProfileKey(scope.profile)
}

// Each call takes a ticket; an older call that finishes after a newer one started (rapid A -> B -> C) must not act.
let latestTicket = 0

/**
 * Put the chat on the ready scope's profile. Order matters (D-19, T-1301-18-01): the previous scope's session
 * lists and open-session state are wiped first, so nothing of it is painted under the new route; then the route is
 * activated (`ensureGatewayProfile` serializes concurrent activations and opens the backend's socket lazily); then
 * the next new chat is pinned to that profile so `session.create` cannot read another one.
 *
 * - `agreed`: nothing to switch (route already on the scope profile, or the scope is not ready).
 * - `switched`: the route was on another profile and now serves the scope.
 * - `failed`: the route could not be moved; it stays where it was and Send stays blocked by the guard.
 * - `superseded`: a newer call started meanwhile; the newer one owns the outcome.
 */
export async function followScopeRoute(state: DegramState, opts: FollowOptions): Promise<FollowOutcome> {
  const { scope } = state

  if (scope.status !== 'ready') {
    return 'agreed'
  }

  const ticket = ++latestTicket
  const target = scope.profile ? normalizeProfileKey(scope.profile) : null

  if (!target) {
    console.warn(`[degram-route] ready scope ${scope.epoch} carries no profile; the route was not moved`)

    return 'failed'
  }

  const switching = routeDisagreesWithScope(state)

  if (switching) {
    wipeSessionListsForGatewaySwitch()
  }

  try {
    // On agreement this is ensureGatewayProfile's own fast path: it also repairs an atom that claims the profile
    // while the registry's socket serves another one.
    await ensureGatewayProfile(target)
  } catch {
    // The profile name is a scope identifier: kept out of the log line.
    console.warn(`[degram-route] could not open the route for scope ${scope.epoch} (fresh=${opts.fresh})`)

    return ticket === latestTicket ? 'failed' : 'superseded'
  }

  if (ticket !== latestTicket) {
    return 'superseded'
  }

  if (routeDisagreesWithScope(state)) {
    console.warn(`[degram-route] the route for scope ${scope.epoch} did not land on the scope profile`)

    return 'failed'
  }

  pinNewChatProfile(target)

  return switching ? 'switched' : 'agreed'
}

/**
 * The shell host's reaction to a scope that needs the chat on its profile. A selected scope (`fresh`) then opens a
 * fresh chat; the boot restore of an already open scope only moves the route. A route that did not move, or a scope
 * a newer one replaced meanwhile, opens nothing.
 */
export async function handleNewScope(state: DegramState, opts: FollowOptions, openFreshChat: () => void): Promise<void> {
  const outcome = await followScopeRoute(state, opts)

  if (opts.fresh && (outcome === 'switched' || outcome === 'agreed')) {
    openFreshChat()
  }
}

/**
 * Keep the route on the ready scope's profile after something else moved it (the boot adopts the primary profile
 * after the shell mounted). Called with the live state getter; returns the disposer. Runs only on a route change, so
 * a failed attempt cannot loop.
 */
export function startRouteReconcile(getState: () => DegramState | null): () => void {
  let running = false

  return $activeGatewayProfile.listen(() => {
    const state = getState()

    if (running || !state || !routeDisagreesWithScope(state)) {
      return
    }

    running = true
    void followScopeRoute(state, { fresh: false }).finally(() => {
      running = false
    })
  })
}
