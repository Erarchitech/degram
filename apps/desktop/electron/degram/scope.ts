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
import type { AuthState, Clock, DgSession, Logger, MeResult, MintResult } from './dg-session'
import { DEGRAM_HEARTBEAT_S, DEGRAM_TOKEN_RENEW_S } from './dg-session'

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
  /**
   * Verify the DG session and the active project's membership now (GET /auth/me). Called by the heartbeat
   * timer, by the window `focus` hook (coalesced within 5 s) and after an agent outcome. A 401 ends the
   * session, a lost membership purges that scope, a network failure only reports `dg-unreachable`.
   */
  checkAccess: (source: CheckSource) => Promise<void>
  /**
   * An operational outcome code the agent reported (see AGENT_OUTCOME_CODES). Returns false for a code that
   * is not an access signal. A soft expiry is never trusted alone: CREDENTIALS_EXPIRED is verified against
   * /auth/me and re-minted unless DG confirms the session ended.
   */
  reportOutcome: (code: string) => Promise<boolean>
  /** Stop every timer. */
  dispose: () => void
}

export type CheckSource = 'heartbeat' | 'focus' | 'outcome'

/** Agent outcomes that signal a change of access. Anything else is not an access signal. */
const OUTCOMES_END_SESSION = new Set(['DELEGATED_SESSION_ENDED'])
const OUTCOMES_VERIFY_AND_RENEW = new Set(['CREDENTIALS_EXPIRED', 'DELEGATED_EXPIRED', 'DELEGATED_AUTH_FAILED'])
const OUTCOMES_REVOKE = new Set(['DELEGATED_SCOPE_CHANGED', 'ACCESS_DENIED'])

export const AGENT_OUTCOME_CODES: readonly string[] = [
  ...OUTCOMES_END_SESSION,
  ...OUTCOMES_VERIFY_AND_RENEW,
  ...OUTCOMES_REVOKE
]

/** Focus events closer together than this reuse the previous check (no request burst). */
const FOCUS_MIN_INTERVAL_MS = 5_000

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
  /** The scope being opened or open (set as soon as membership is confirmed, so a revoke can purge it). */
  let active: { key: ScopeKey; profile: string | null } | null = null
  /** A signed-in session has been observed since the last clearing. */
  let live = false
  let clearing = false
  let clearingPromise: Promise<unknown> | null = null
  let heartbeat: { handle: unknown } | null = null
  let renewal: { handle: unknown } | null = null
  let renewPending = false
  let renewing = false
  let checking: Promise<void> | null = null
  let lastCheckAt = Number.NEGATIVE_INFINITY
  let unreachableReported = false
  const listeners = new Set<(next: ScopeState) => void>()

  const stopHeartbeat = (): void => {
    if (heartbeat) {
      deps.clock.clearInterval(heartbeat.handle)
      heartbeat = null
    }
  }

  const stopRenewal = (): void => {
    if (renewal) {
      deps.clock.clearInterval(renewal.handle)
      renewal = null
    }

    renewPending = false
  }

  session.onAuth(auth => {
    if (auth.kind === 'signed-in') {
      live = true

      if (!heartbeat) {
        heartbeat = { handle: deps.clock.setInterval(() => void checkAccess('heartbeat'), DEGRAM_HEARTBEAT_S * 1000) }
      }
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
    stopRenewal()

    if (open?.handle) {
      try {
        await open.handle.call('degram.credentials.clear', {})
      } catch {
        logger.warn('[degram] could not clear the agent credential of the previous scope')
      }
    }
  }

  /** Run one clearing sequence at a time; a concurrent trigger waits for it and is skipped (never doubled). */
  const runClearing = async <T>(body: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> => {
    if (clearingPromise) {
      await clearingPromise

      return { done: false }
    }

    const running = body()

    clearingPromise = running.catch(() => undefined)

    try {
      return { done: true, value: await running }
    } finally {
      clearingPromise = null
    }
  }

  /**
   * The shared clearing sequence: invalidate any in-flight selection, clear the agent credential, optionally
   * release and purge the scope's profile, close the scope, then reset the DG view. Completes BEFORE the
   * caller tells the renderer anything. Returns whether the profile purge succeeded (null: none requested).
   */
  const teardown = async (options: {
    wipe: 'all' | 'tenant'
    endsSession: boolean
    purge?: { key: ScopeKey; profile: string | null }
  }): Promise<boolean | null> => {
    clearing = true
    epoch += 1

    let purged: boolean | null = null

    try {
      await closeCurrent()
      active = null

      if (options.purge) {
        purged = true

        try {
          if (options.purge.profile) {
            await deps.backend.release(options.purge.profile)
          }

          await deps.profiles.purge(options.purge.key)
        } catch {
          purged = false
          logger.warn('[degram] could not purge the local profile of a revoked scope')
        }
      }

      setState({ ...IDLE, epoch })

      try {
        await deps.view.reset()

        if (options.wipe === 'all') {
          await deps.view.clearStorage()
        } else {
          await deps.view.clearStorage({ keepCookies: true })
        }
      } catch {
        logger.warn('[degram] could not fully reset the DG view')
      }

      if (options.endsSession) {
        live = false
        stopHeartbeat()
      }
    } finally {
      clearing = false
    }

    return purged
  }

  /** The DG session is gone (401): clear everything, then tell the renderer. */
  const endSession = async (): Promise<void> => {
    session.markSignedOut()

    const result = await runClearing(() => teardown({ wipe: 'all', endsSession: true }))

    if (result.done) {
      deps.emit({ type: 'session-ended' })
    }
  }

  /** Access to the active project is gone (403 / membership loss): purge that scope only, then tell the renderer. */
  const revokeActive = async (): Promise<void> => {
    const target = active

    if (!target) {
      return
    }

    const result = await runClearing(() => teardown({ wipe: 'tenant', endsSession: false, purge: target }))

    if (result.done) {
      deps.emit({ type: 'access-revoked', project: target.key.project, purged: result.value === true })
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
      if (live) {
        await endSession()
      }

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
    active = { key, profile: null }
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

    if (active?.key === key) {
      active.profile = profile
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

    stopRenewal()
    renewal = { handle: deps.clock.setInterval(() => void renew(), DEGRAM_TOKEN_RENEW_S * 1000) }
    logger.info(`[degram] scope ready for project ${project}`)

    return { ok: true, state }
  }

  const signOut = async (): Promise<void> => {
    await runClearing(async () => {
      await session.logout()
      await teardown({ wipe: 'all', endsSession: true })
    })
  }

  /** Re-mint the delegated token of the open scope and hand it to the agent (timer, or pending retry). */
  const renew = async (): Promise<void> => {
    const open = current

    if (!open || !open.handle || renewing) {
      return
    }

    renewing = true

    try {
      const minted: MintResult = await session.mint(open.key.project)

      if (current !== open) {
        return
      }

      if (minted.kind === 'ok') {
        try {
          await open.handle.call('degram.credentials.set', credentialParams(open.key, minted))
          renewPending = false
        } catch {
          logger.warn('[degram] the agent did not accept the renewed credential; retrying on the next heartbeat')
          renewPending = true
        }
      } else if (minted.kind === 'signed-out') {
        await endSession()
      } else if (minted.kind === 'forbidden') {
        await revokeActive()
      } else {
        // unreachable or an unusable reply: keep the current credential and retry on the next heartbeat tick
        renewPending = true
      }
    } finally {
      renewing = false
    }
  }

  const handleMe = async (me: MeResult): Promise<void> => {
    if (me.kind === 'unreachable') {
      if (!unreachableReported) {
        unreachableReported = true
        deps.emit({ type: 'dg-unreachable' })
      }

      return
    }

    if (unreachableReported) {
      unreachableReported = false
      deps.emit({ type: 'dg-reachable' })
    }

    if (me.kind === 'signed-out') {
      if (live) {
        await endSession()
      }

      return
    }

    const target = active

    if (target) {
      const membership = me.memberships.find(m => m.project === target.key.project)

      if (!membership || membership.company !== target.key.company) {
        await revokeActive()

        return
      }
    }

    if (renewPending && current) {
      await renew()
    }
  }

  const checkAccess = (source: CheckSource): Promise<void> => {
    if (!live) {
      return Promise.resolve()
    }

    if (checking) {
      return checking
    }

    const now = deps.clock.now()

    if (source === 'focus' && now - lastCheckAt < FOCUS_MIN_INTERVAL_MS) {
      return Promise.resolve()
    }

    lastCheckAt = now

    checking = session
      .refresh()
      .then(handleMe)
      .catch(() => logger.warn('[degram] access check failed'))
      .finally(() => {
        checking = null
      })

    return checking
  }

  const reportOutcome = async (code: string): Promise<boolean> => {
    if (OUTCOMES_END_SESSION.has(code)) {
      if (live) {
        await endSession()
      }

      return true
    }

    if (OUTCOMES_VERIFY_AND_RENEW.has(code)) {
      if (live) {
        renewPending = true
        await checkAccess('outcome')
      }

      return true
    }

    if (OUTCOMES_REVOKE.has(code)) {
      await revokeActive()

      return true
    }

    return false
  }

  return {
    signOut,
    checkAccess,
    reportOutcome,
    dispose: (): void => {
      stopHeartbeat()
      stopRenewal()
    },
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
