// ipc.ts — the DeGram runtime and its typed `degram:*` IPC surface (Phase 1301-12).
//
// `createDegramRuntime` composes the pieces of this plan from injected primitives (partition fetch, native
// view factory, profile CLI, backend handle, clock, renderer sender): the DG session, the embedded DG view
// and the scope controller. It owns the renderer-safe state object and decides WHEN the renderer hears
// something: never before a clearing sequence has completed (T-1301-12-04), and never the delegated token
// (T-1301-12-03). The token is not part of any state, event, return value or channel.
//
// `registerDegramIpc` is the only place that touches ipcMain: it verifies the sender is the DeGram window,
// validates every payload, and calls the runtime. There is no channel that can read a credential.
//
// Phase 1301-17 (D-25): `setPairing` takes the DeGram pairing token pasted in the renderer exactly once and
// hands it to the safeStorage-backed store; the state carries only the pairing status, never the token.

import { DEGRAM_CHANNELS } from './channels'
import type { AuthState, Clock, DgSession, Logger, Membership, PairingStatus, PartitionFetch } from './dg-session'
import { createDgSession } from './dg-session'
import type { DgBounds, DgMode, DgView, DgViewDeps, DgViewPage } from './dg-view'
import { createDgView } from './dg-view'
import { isPairingToken, type PairingSetResult, type PairingStore } from './pairing-store'
import type { DegramEvent, ScopeController, ScopeDeps, ScopeState, SelectResult } from './scope'
import { AGENT_OUTCOME_CODES, createScopeController } from './scope'

export { DEGRAM_CHANNELS, type DegramChannel } from './channels'

/** What the renderer may know about the DG session. No token, no cookie, no password. */
export interface DegramAuthView {
  kind: 'unknown' | 'signed-out' | 'signed-in'
  username: string | null
  isAdmin: boolean
  memberships: Membership[]
}

/** The DeGram pairing as the renderer may see it: a status, never the token. */
export interface DegramPairingView {
  status: PairingStatus
  company: string | null
  /** False when no encrypted store exists (OS encryption unavailable): the panel cannot store a token. */
  available: boolean
}

export interface DegramState {
  auth: DegramAuthView
  scope: ScopeState
  dg: { mode: DgMode; page: DgViewPage; reachable: boolean }
  pairing: DegramPairingView
}

/** The renderer-facing bridge exposed by preload.ts as `window.hermesDesktop.degram`. No credential getter. */
export interface DegramBridge {
  getState: () => Promise<DegramState>
  onState: (callback: (state: DegramState) => void) => () => void
  onEvent: (callback: (event: DegramEvent) => void) => () => void
  selectProject: (project: string) => Promise<SelectResult>
  signOut: () => Promise<void>
  setDgMode: (mode: DgMode) => Promise<void>
  reloadDg: () => Promise<void>
  /** The rectangle (window content coordinates) the DG page occupies; `null` hides the view. */
  setDgBounds: (bounds: DgBounds | null) => Promise<void>
  /** Forward an operational outcome code the agent reported (for example CREDENTIALS_EXPIRED). */
  reportOutcome: (code: string) => Promise<boolean>
  /** Open a URL the DG view refused to show in the system browser. Call only from a user action. */
  openExternalConfirmed: (url: string) => Promise<boolean>
  /** Store a pasted DeGram pairing token (Phase 1301-17). The token is never sent back. */
  setPairing: (token: string) => Promise<PairingSetResult>
  /** Forget the stored pairing on this PC (revoking it is done on the DG Connectors tab). */
  clearPairing: () => Promise<void>
}

export interface DegramRuntimeDeps {
  origin: string
  fetch: PartitionFetch
  clock: Clock
  logger: Logger
  createView: DgViewDeps['createView']
  openExternal: DgViewDeps['openExternal']
  profiles: ScopeDeps['profiles']
  backend: ScopeDeps['backend']
  /** The safeStorage-backed pairing store (pairing-store.ts); absent when OS encryption is unavailable. */
  pairing?: PairingStore
  /** Renderer sender (`webContents.send`). */
  send: (channel: string, payload: unknown) => void
}

export interface DegramRuntime {
  readonly session: DgSession
  readonly scope: ScopeController
  readonly dgView: DgView
  getState: () => DegramState
  /** First auth check; loads the sign-in page or the DG page. */
  start: () => Promise<void>
  selectProject: (project: string) => Promise<SelectResult>
  signOut: () => Promise<void>
  setDgMode: (mode: DgMode) => Promise<void>
  reloadDg: () => Promise<void>
  setDgBounds: (bounds: DgBounds | null) => void
  openExternalConfirmed: (url: string) => boolean
  setPairing: (token: string) => PairingSetResult
  clearPairing: () => void
  /** An agent outcome code forwarded by the renderer; false when it is not an access signal. */
  reportOutcome: (code: string) => Promise<boolean>
  /** The DeGram window gained focus: verify the DG session and the active project's membership. */
  onWindowFocus: () => Promise<void>
  /** The partition's `dg_session` cookie changed (sign-in finished in the DG page, or ended). */
  onAuthCookieChanged: () => Promise<void>
  dispose: () => void
}

function authView(auth: AuthState): DegramAuthView {
  // An unreachable DG keeps the last known identity: the renderer shows it as signed in with `reachable: false`.
  const kind: DegramAuthView['kind'] =
    auth.kind === 'signed-in' || (auth.kind === 'unreachable' && auth.username)
      ? 'signed-in'
      : auth.kind === 'unknown' || auth.kind === 'unreachable'
        ? 'unknown'
        : 'signed-out'

  return {
    kind,
    username: kind === 'signed-in' ? auth.username : null,
    isAdmin: kind === 'signed-in' ? auth.isAdmin : false,
    memberships: kind === 'signed-in' ? auth.memberships.map(m => ({ ...m })) : []
  }
}

export function createDegramRuntime(deps: DegramRuntimeDeps): DegramRuntime {
  const { logger } = deps
  let reachable = true
  let lastPublished = ''
  let viewChain: Promise<void> = Promise.resolve()

  /** View work runs one step at a time so loads cannot overlap into a stale page. */
  const viewTask = (task: () => Promise<void>): Promise<void> => {
    viewChain = viewChain.then(task, task)

    return viewChain
  }

  const session: DgSession = createDgSession({
    origin: deps.origin,
    fetch: deps.fetch,
    clock: deps.clock,
    logger,
    pairing: deps.pairing
  })

  let scope: ScopeController

  const getState = (): DegramState => ({
    auth: authView(session.state()),
    scope: scope.getState(),
    dg: { mode: dgView.getState().mode, page: dgView.getState().page, reachable },
    pairing: { ...session.pairing(), available: deps.pairing !== undefined }
  })

  const publish = (): void => {
    if (!scope.isSettled()) {
      return
    }

    const state = getState()
    const serialized = JSON.stringify(state)

    if (serialized === lastPublished) {
      return
    }

    lastPublished = serialized
    deps.send(DEGRAM_CHANNELS.stateChanged, state)
  }

  const onEvent = (event: DegramEvent): void => {
    if (event.type === 'dg-unreachable') {
      reachable = false
    } else if (event.type === 'dg-reachable') {
      reachable = true
    } else if (event.type === 'session-ended') {
      void viewTask(() => dgView.showSignIn())
    }

    deps.send(DEGRAM_CHANNELS.event, event)
    publish()
  }

  const dgView: DgView = createDgView({
    origin: deps.origin,
    createView: deps.createView,
    emit: onEvent,
    openExternal: deps.openExternal,
    logger
  })

  scope = createScopeController({
    session,
    origin: deps.origin,
    clock: deps.clock,
    logger,
    emit: onEvent,
    profiles: deps.profiles,
    backend: deps.backend,
    view: {
      reset: () => dgView.reset(),
      clearStorage: options => dgView.clearStorage(options)
    }
  })

  let previousKind: AuthState['kind'] = session.state().kind

  session.onAuth(auth => {
    const wasSignedIn = previousKind === 'signed-in'

    if (auth.kind !== 'unreachable') {
      previousKind = auth.kind
    }

    // Signing in inside the DG page: show the DG page once the session is confirmed.
    if (auth.kind === 'signed-in' && !wasSignedIn) {
      void viewTask(() => dgView.showDg())
    }

    publish()
  })

  scope.onState(() => publish())
  session.onPairing(() => publish())

  const start = async (): Promise<void> => {
    const me = await session.refresh()

    if (me.kind !== 'signed-in') {
      await viewTask(() => dgView.showSignIn())
    }

    await viewChain
    publish()
  }

  return {
    session,
    scope,
    dgView,
    getState,
    start,
    selectProject: async (project: string): Promise<SelectResult> => {
      const result = await scope.selectProject(project)

      publish()

      return result
    },
    signOut: async (): Promise<void> => {
      await scope.signOut()
      await viewTask(() => dgView.showSignIn())
      publish()
    },
    setDgMode: async (mode: DgMode): Promise<void> => {
      await viewTask(async () => {
        await dgView.setMode(mode)

        // After an access loss the view is reset to blank while the DG session stays signed in, and no sign-in
        // transition follows, so a project chosen afterwards would meet a blank DG page. Choosing the mode is
        // also the renderer's request to show the page: it is loaded here, in the chosen mode.
        if (dgView.getState().page === 'blank' && session.state().kind === 'signed-in') {
          await dgView.showDg()
        }
      })
      publish()
    },
    reloadDg: (): Promise<void> => viewTask(() => dgView.reload()),
    setDgBounds: (bounds: DgBounds | null): void => dgView.setBounds(bounds),
    openExternalConfirmed: (url: string): boolean => dgView.openExternalConfirmed(url),
    setPairing: (token: string): PairingSetResult => {
      if (!deps.pairing) {
        return { ok: false, code: 'ENCRYPTION_UNAVAILABLE' }
      }

      const result = deps.pairing.set(token)

      session.notePairingChanged()
      publish()

      return result
    },
    clearPairing: (): void => {
      deps.pairing?.clear()
      session.notePairingChanged()
      publish()
    },
    reportOutcome: async (code: string): Promise<boolean> => {
      const known = await scope.reportOutcome(code)

      publish()

      return known
    },
    onWindowFocus: async (): Promise<void> => {
      await scope.checkAccess('focus')
      await viewChain
      publish()
    },
    onAuthCookieChanged: async (): Promise<void> => {
      // A clearing sequence (sign-out, revocation) wipes the cookie itself; its own change event is not news.
      if (!scope.isSettled()) {
        return
      }

      if (session.state().kind === 'signed-in') {
        await scope.checkAccess('outcome')
      } else {
        await session.refresh()
      }

      await viewChain
      publish()
    },
    dispose: (): void => {
      scope.dispose()
      dgView.destroy()
    }
  }
}

// ─── ipcMain registration ───────────────────────────────────────────────────────────────────────────

export interface IpcMainLike {
  handle: (channel: string, handler: (event: { sender: unknown }, ...args: any[]) => unknown) => void
}

const MAX_PROJECT_LENGTH = 200

function invalid(what: string): Error {
  return new Error(`degram: invalid ${what}`)
}

function asProject(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > MAX_PROJECT_LENGTH || /[\u0000-\u001f]/.test(value)) {
    throw invalid('project')
  }

  return value
}

function asMode(value: unknown): DgMode {
  if (value !== 'graph' && value !== 'full') {
    throw invalid('mode')
  }

  return value
}

function asBounds(value: unknown): DgBounds | null {
  if (value === null) {
    return null
  }

  const rect = value as Partial<Record<keyof DgBounds, unknown>> | undefined

  if (
    !rect ||
    typeof rect !== 'object' ||
    ![rect.x, rect.y, rect.width, rect.height].every(n => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw invalid('bounds')
  }

  return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }
}

function asOutcome(value: unknown): string {
  if (typeof value !== 'string' || !AGENT_OUTCOME_CODES.includes(value)) {
    throw invalid('outcome')
  }

  return value
}

function asPairing(value: unknown): string {
  if (!isPairingToken(value)) {
    throw invalid('pairing token')
  }

  return value
}

function asUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw invalid('url')
  }

  return value
}

/**
 * Register the `degram:*` request channels. `isTrustedSender` must accept only the DeGram main window's own
 * renderer; the DG web view has no preload and cannot reach ipcMain, so this is defence in depth.
 */
export function registerDegramIpc(
  ipc: IpcMainLike,
  runtime: DegramRuntime,
  isTrustedSender: (sender: unknown) => boolean
): void {
  const guarded =
    (handler: (...args: any[]) => unknown) =>
    async (event: { sender: unknown }, ...args: unknown[]): Promise<unknown> => {
      if (!isTrustedSender(event.sender)) {
        throw new Error('degram: untrusted sender')
      }

      return handler(...args)
    }

  ipc.handle(
    DEGRAM_CHANNELS.getState,
    guarded(() => runtime.getState())
  )
  ipc.handle(
    DEGRAM_CHANNELS.selectProject,
    guarded((project: unknown) => runtime.selectProject(asProject(project)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.signOut,
    guarded(() => runtime.signOut())
  )
  ipc.handle(
    DEGRAM_CHANNELS.setDgMode,
    guarded((mode: unknown) => runtime.setDgMode(asMode(mode)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.reloadDg,
    guarded(() => runtime.reloadDg())
  )
  ipc.handle(
    DEGRAM_CHANNELS.setDgBounds,
    guarded((bounds: unknown) => runtime.setDgBounds(asBounds(bounds)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.reportOutcome,
    guarded((code: unknown) => runtime.reportOutcome(asOutcome(code)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.openExternalConfirmed,
    guarded((url: unknown) => runtime.openExternalConfirmed(asUrl(url)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.setPairing,
    guarded((token: unknown) => runtime.setPairing(asPairing(token)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.clearPairing,
    guarded(() => runtime.clearPairing())
  )
}
