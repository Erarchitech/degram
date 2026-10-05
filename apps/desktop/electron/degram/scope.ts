// scope.ts — the project scope controller (Phase 1301-12, D-06/D-19).
//
// A scope is one user + company + project. Opening it (an EXPLICIT project selection, never implicit):
//
//   1. confirm with a fresh GET /auth/me that the user is signed in and a member of the project,
//   2. close the previously open scope (agent credential cleared first),
//   3. ensure that scope's own Hermes profile (python -m degram_variant.profiles ensure),
//   4. start / attach the profile's agent backend,
//   5. mint a delegated token through the DG partition,
//   6. hand it to the agent with degram.credentials.set (BEFORE the renderer may create a session),
//   7. report the scope ready.
//
// The delegated token exists only in this call chain and in the agent process memory: it is not part of
// any state object, event, log line or file. The renderer starts a fresh chat session when it sees a
// new scope epoch; a session is never carried across scopes.
//
// All collaborators are injected (see test-support.ts for the fakes).

import { relayBaseUrlFor } from './dg-config'
import type { AuthState, Clock, DgSession, Logger, MintResult } from './dg-session'

export interface ScopeKey {
  user: string
  company: string | null
  project: string
}

/** One RPC channel to a profile's agent backend (the gateway, main side). */
export interface BackendHandle {
  call: (method: string, params: unknown) => Promise<unknown>
}

export type DegramEvent =
  | { type: 'session-ended' }
  | { type: 'access-revoked'; project: string; purged: boolean }
  | { type: 'external-link-blocked'; url: string }
  | { type: 'dg-unreachable' }
  | { type: 'dg-reachable' }

export type ScopeStatus = 'no-project' | 'opening' | 'ready' | 'error'

export interface ScopeState {
  status: ScopeStatus
  project: string | null
  company: string | null
  profile: string | null
  /** Increments on every selection; a renderer starts a fresh chat session whenever it changes. */
  epoch: number
  /** The failure code of the last selection when status is `error`. */
  error: string | null
}

export type ScopeErrorCode =
  | 'NOT_SIGNED_IN'
  | 'NOT_A_MEMBER'
  | 'SUPERSEDED'
  | 'DG_UNREACHABLE'
  | 'PROFILE_FAILED'
  | 'BACKEND_FAILED'
  | 'CREDENTIALS_REJECTED'
  | 'ACCESS_DENIED'
  | 'MINT_FAILED'

export type SelectResult = { ok: true; state: ScopeState } | { ok: false; code: ScopeErrorCode; state: ScopeState }

export interface ScopeDeps {
  session: DgSession
  origin: string
  clock: Clock
  logger: Logger
  emit: (event: DegramEvent) => void
  profiles: {
    ensure: (scope: ScopeKey) => Promise<{ profile: string }>
    purge: (scope: ScopeKey) => Promise<void>
  }
  backend: {
    ensure: (profile: string) => Promise<BackendHandle>
    release: (profile: string) => Promise<void>
  }
  /** The embedded DG web view: state reset and partition storage wipe. */
  view: {
    reset: () => Promise<void> | void
    clearStorage: (options?: { keepCookies?: boolean }) => Promise<void> | void
  }
}

export interface ScopeController {
  getState: () => ScopeState
  onState: (listener: (state: ScopeState) => void) => () => void
  selectProject: (project: string) => Promise<SelectResult>
  /**
   * End the DG session on purpose: POST /auth/logout through the partition, then clear the agent credential,
   * close the scope, wipe the partition storage and blank the DG view. Local scope profiles are kept (their
   * history stays hidden until a fresh sign-in confirms membership, D-19).
   */
  signOut: () => Promise<void>
  /**
   * False while a clearing sequence is running or a lost session has been observed but not yet cleared.
   * A caller that mirrors state to the renderer must not publish while this is false, so no stale project
   * data is repainted ahead of the clearing (T-1301-12-04).
   */
  isSettled: () => boolean
}

interface OpenScope {
  key: ScopeKey
  profile: string
  handle: BackendHandle | null
}

const IDLE: Omit<ScopeState, 'epoch'> = {
  status: 'no-project',
  project: null,
  company: null,
  profile: null,
  error: null
}

export function createScopeController(deps: ScopeDeps): ScopeController {
  const { session, logger } = deps
  let epoch = 0
  let state: ScopeState = { ...IDLE, epoch: 0 }
  let current: OpenScope | null = null
  /** A signed-in session has been observed since the last clearing. */
  let live = false
  let clearing = false
  const listeners = new Set<(next: ScopeState) => void>()

  session.onAuth(auth => {
    if (auth.kind === 'signed-in') {
      live = true
    }
  })

  const setState = (next: Partial<ScopeState>): void => {
    state = { ...state, ...next }

    for (const listener of [...listeners]) {
      listener(state)
    }
  }

  const credentialParams = (key: ScopeKey, minted: Extract<MintResult, { kind: 'ok' }>): Record<string, unknown> => ({
    token: minted.token,
    expiresAt: minted.expiresAt,
    relayBaseUrl: relayBaseUrlFor(deps.origin),
    user: key.user,
    company: key.company,
    project: key.project
  })

  /** Clear the agent credential of the open scope (best effort) and forget it. */
  const closeCurrent = async (): Promise<void> => {
    const open = current

    current = null

    if (open?.handle) {
      try {
        await open.handle.call('degram.credentials.clear', {})
      } catch {
        logger.warn('[degram] could not clear the agent credential of the previous scope')
      }
    }
  }

  /**
   * The shared clearing sequence: invalidate any in-flight selection, clear the agent credential, close the
   * scope, then reset the DG view. Completes BEFORE the caller tells the renderer anything.
   */
  const teardown = async (view: { wipe: 'all' | 'tenant' | 'none' }): Promise<void> => {
    clearing = true
    epoch += 1

    try {
      await closeCurrent()
      setState({ ...IDLE, epoch })

      try {
        await deps.view.reset()

        if (view.wipe === 'all') {
          await deps.view.clearStorage()
        } else if (view.wipe === 'tenant') {
          await deps.view.clearStorage({ keepCookies: true })
        }
      } catch {
        logger.warn('[degram] could not fully reset the DG view')
      }

      live = false
    } finally {
      clearing = false
    }
  }

  const fail = (code: ScopeErrorCode, forget: boolean): SelectResult => {
    if (code !== 'SUPERSEDED') {
      setState({ ...(forget ? IDLE : {}), status: forget ? 'no-project' : 'error', error: forget ? null : code })
    }

    return { ok: false, code, state }
  }

  const selectProject = async (project: string): Promise<SelectResult> => {
    const me = await session.refresh()

    if (me.kind === 'unreachable') {
      return { ok: false, code: 'DG_UNREACHABLE', state }
    }

    if (me.kind !== 'signed-in') {
      return { ok: false, code: 'NOT_SIGNED_IN', state }
    }

    const membership = me.memberships.find(m => m.project === project)

    if (!membership) {
      return { ok: false, code: 'NOT_A_MEMBER', state }
    }

    const mine = (epoch += 1)
    const key: ScopeKey = { user: me.username, company: membership.company, project }
    const superseded = (): boolean => mine !== epoch

    await closeCurrent()
    setState({ status: 'opening', project, company: membership.company, profile: null, epoch: mine, error: null })

    let profile: string

    try {
      profile = (await deps.profiles.ensure(key)).profile
    } catch {
      logger.error('[degram] could not prepare the scope profile')

      return superseded() ? fail('SUPERSEDED', false) : fail('PROFILE_FAILED', false)
    }

    if (superseded()) {
      return fail('SUPERSEDED', false)
    }

    let handle: BackendHandle

    try {
      handle = await deps.backend.ensure(profile)
    } catch {
      logger.error('[degram] could not start the agent backend for the scope')

      return superseded() ? fail('SUPERSEDED', false) : fail('BACKEND_FAILED', false)
    }

    if (superseded()) {
      return fail('SUPERSEDED', false)
    }

    const minted: MintResult = await session.mint(project)

    if (superseded()) {
      return fail('SUPERSEDED', false)
    }

    if (minted.kind !== 'ok') {
      const code: ScopeErrorCode =
        minted.kind === 'unreachable'
          ? 'DG_UNREACHABLE'
          : minted.kind === 'signed-out'
            ? 'NOT_SIGNED_IN'
            : minted.kind === 'forbidden'
              ? 'ACCESS_DENIED'
              : 'MINT_FAILED'

      return fail(code, false)
    }

    current = { key, profile, handle }

    try {
      await handle.call('degram.credentials.set', credentialParams(key, minted))
    } catch {
      logger.error('[degram] the agent refused the delegated credential')
      current = null

      return superseded() ? fail('SUPERSEDED', false) : fail('CREDENTIALS_REJECTED', false)
    }

    if (superseded()) {
      current = null

      try {
        await handle.call('degram.credentials.clear', {})
      } catch {
        logger.warn('[degram] could not clear a credential set for a superseded selection')
      }

      return fail('SUPERSEDED', false)
    }

    setState({ status: 'ready', project, company: membership.company, profile, epoch: mine, error: null })
    logger.info(`[degram] scope ready for project ${project}`)

    return { ok: true, state }
  }

  const signOut = async (): Promise<void> => {
    await session.logout()
    await teardown({ wipe: 'all' })
  }

  return {
    signOut,
    isSettled: (): boolean => !clearing && !(live && session.state().kind === 'signed-out'),
    getState: (): ScopeState => state,
    onState: (listener): (() => void) => {
      listeners.add(listener)

      return (): void => {
        listeners.delete(listener)
      }
    },
    selectProject
  }
}

export type { AuthState }
