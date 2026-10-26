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
import { DEGRAM_CHANNELS } from './channels'
import type { EnvironmentViewState, EnvironmentSwitchResult } from './environment-controller'
import type { DgTargetMode } from './dg-target-config'

import type { AuthState, Clock, DgSession, Logger, Membership, PartitionFetch } from './dg-session'
import { createDgSession } from './dg-session'
import type { DgBounds, DgHostState, DgLocale, DgMode, DgRegion, DgView, DgViewDeps, DgViewPage } from './dg-view'
import { createDgView, DG_REGIONS, projectFragment } from './dg-view'
import type { DegramEvent, ScopeController, ScopeDeps, ScopeState, SelectResult } from './scope'
import { AGENT_OUTCOME_CODES, createScopeController } from './scope'

export { DEGRAM_CHANNELS, type DegramChannel } from './channels'

export interface EnvironmentStamp { environmentId: string; generation: number }
export interface OperationStamp extends EnvironmentStamp { id: number }

/** What the renderer may know about the DG session. No token, no cookie, no password. */
export interface DegramAuthView {
  kind: 'unknown' | 'signed-out' | 'signed-in'
  username: string | null
  isAdmin: boolean
  memberships: Membership[]
}

/** Texts of native menus (the tray) that the renderer owns because it owns the locale. */
export interface DegramTrayLabels {
  signOut: string
}

/** Shown in the tray until the renderer has loaded its locale and sent the real label (G-17). */
export const DEFAULT_TRAY_LABELS: DegramTrayLabels = { signOut: 'Выйти из DG' }

export interface DegramState {
  /** Present on coordinator-owned runtimes; legacy isolated-runtime fixtures have no target. */
  environment?: EnvironmentStamp
  auth: DegramAuthView
  scope: ScopeState
  dg: { mode: DgMode; page: DgViewPage; reachable: boolean }
}

/** The renderer-facing bridge exposed by preload.ts as `window.hermesDesktop.degram`. No credential getter. */
export interface DegramBridge {
  getEnvironment: () => Promise<EnvironmentViewState>
  onEnvironment: (callback: (state: EnvironmentViewState) => void) => () => void
  selectTarget: (request: EnvironmentStamp & { mode: DgTargetMode }) => Promise<EnvironmentSwitchResult>
  retryTarget: (request: EnvironmentStamp) => Promise<EnvironmentSwitchResult>
  acquireOperation: (request: EnvironmentStamp) => Promise<OperationStamp>
  releaseOperation: (request: OperationStamp) => Promise<void>
  getState: () => Promise<DegramState>
  onState: (callback: (state: DegramState) => void) => () => void
  onEvent: (callback: (event: DegramEvent) => void) => () => void
  selectProject: (project: string) => Promise<SelectResult>
  signOut: () => Promise<void>
  setDgMode: (mode: DgMode) => Promise<void>
  reloadDg: () => Promise<void>
  /** DG was unreachable: re-run the /auth/me check, then show the sign-in or the DG page (G-16). */
  retryDg: () => Promise<void>
  /** The rectangle (window content coordinates) the DG page occupies; `null` hides the view. */
  setDgBounds: (bounds: DgBounds | null) => Promise<void>
  /** Send the localized text of the tray's sign-out entry (the renderer owns the locale). */
  setTrayLabels: (labels: DegramTrayLabels) => Promise<void>
  /** Steer the embedded DG page to a region (the sidebar rows, D-42). */
  dgGo: (region: DgRegion) => Promise<void>
  /** The DeGram locale; signal the open DG page in place and carry `&lang=` on later loads. */
  setLocale: (locale: DgLocale) => Promise<void>
  /** The tray's sign-out entry was clicked: the renderer shows its confirmation or signs out (G-17). */
  onRequestSignOut: (callback: () => void) => () => void
  /** Forward an operational outcome code the agent reported (for example CREDENTIALS_EXPIRED). */
  reportOutcome: (code: string) => Promise<boolean>
  /** Open a URL the DG view refused to show in the system browser. Call only from a user action. */
  openExternalConfirmed: (url: string) => Promise<boolean>
}

export interface DegramRuntimeDeps {
  generation?: number
  partition?: string
  isCurrent?: () => boolean
  environmentId: string
  origin: string
  fetch: PartitionFetch
  clock: Clock
  logger: Logger
  createView: DgViewDeps['createView']
  openExternal: DgViewDeps['openExternal']
  profiles: ScopeDeps['profiles']
  backend: ScopeDeps['backend']
  /** Renderer sender (`webContents.send`). */
  send: (channel: string, payload: unknown) => void
  /** The tray labels changed: rebuild the native menu. */
  onTrayLabelsChanged?: () => void
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
  retryDg: () => Promise<void>
  setDgBounds: (bounds: DgBounds | null) => void
  setTrayLabels: (labels: DegramTrayLabels) => void
  dgGo: (region: DgRegion) => Promise<void>
  setLocale: (locale: DgLocale) => Promise<void>
  getTrayLabels: () => DegramTrayLabels
  /** Ask the renderer to run its sign-out flow (the tray entry). */
  requestSignOut: () => void
  openExternalConfirmed: (url: string) => boolean
  /** An agent outcome code forwarded by the renderer; false when it is not an access signal. */
  reportOutcome: (code: string) => Promise<boolean>
  /** The DeGram window gained focus: verify the DG session and the active project's membership. */
  onWindowFocus: () => Promise<void>
  /** Strict target-switch teardown; unlike signOut it preserves partition storage/history. */
  closeForEnvironmentSwitch: () => Promise<void>
  /** Gateway-backed operation barrier for the active profile runtime. */
  quiesceForEnvironmentSwitch: (target: { environmentId: string; generation: number }) => Promise<void>
  resumeForEnvironmentSwitch: (target: { environmentId: string; generation: number }) => Promise<void>
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
  let trayLabels: DegramTrayLabels = { ...DEFAULT_TRAY_LABELS }
  let disposed = false
  const isCurrent = (): boolean => !disposed && (deps.isCurrent?.() ?? true)

  /** View work runs one step at a time so loads cannot overlap into a stale page. */
  const viewTask = (task: () => Promise<void>): Promise<void> => {
    const guarded = (): Promise<void> => isCurrent() ? task() : Promise.resolve()
    viewChain = viewChain.then(guarded, guarded)

    return viewChain
  }

  const session: DgSession = createDgSession({
    origin: deps.origin,
    fetch: async request => {
      if (!isCurrent()) throw new Error('degram: obsolete environment')
      const response = await deps.fetch(request)
      if (!isCurrent()) throw new Error('degram: obsolete environment')
      return response
    },
    clock: deps.clock,
    logger
  })

  let scope: ScopeController

  const environment = deps.generation === undefined ? undefined : { environmentId: deps.environmentId, generation: deps.generation }
  const getState = (): DegramState => ({
    ...(environment ? { environment } : {}),
    auth: authView(session.state()),
    scope: scope.getState(),
    dg: { mode: dgView.getState().mode, page: dgView.getState().page, reachable }
  })

  const publish = (): void => {
    if (!isCurrent() || !scope.isSettled()) {
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

  /**
   * The DG page of a signed-in session: the chosen mode once a project is open, otherwise the start page, the only
   * page whose project choice reaches DeGram (D-33; the #degram slice cannot announce one).
   */
  const showDgForScope = (): Promise<void> =>
    scope.getState().status === 'ready' ? dgView.showDg() : dgView.showStart()

  /** Back on the start screen with the DG session intact: show the start page unless it is already there. */
  const restoreStartPage = async (): Promise<void> => {
    const { page, mode } = dgView.getState()

    if (session.state().kind !== 'signed-in' || scope.getState().status === 'ready' || (page === 'dg' && mode === 'full')) {
      return
    }

    await dgView.showStart()
  }

  const onEvent = (event: DegramEvent): void => {
    if (!isCurrent()) return
    if (event.type === 'dg-unreachable') {
      reachable = false
    } else if (event.type === 'dg-reachable') {
      reachable = true
    } else if (event.type === 'session-ended') {
      void viewTask(() => dgView.showSignIn())
    } else if (event.type === 'access-revoked' || event.type === 'grant-required') {
      // A project lost its access while the DG sign-in remains intact; return to the project choice.
      void viewTask(restoreStartPage)
    }

    deps.send(DEGRAM_CHANNELS.event, environment ? { ...event, environment } : event)
    publish()
  }

  /** The ring state the DG page was last told (D-44); the page starts idle. */
  let hostState: DgHostState = 'idle'

  /** Tell the DG page the scope state: remembered at once (loads carry it), signalled in view order. */
  const noteHostState = (next: DgHostState): void => {
    if (next === hostState) {
      return
    }

    hostState = next
    dgView.setHostState(next)
    void viewTask(() => dgView.signal(`#degram-state=${next}`))
  }

  const hostStateOf = (status: ScopeState['status']): DgHostState =>
    status === 'ready' ? 'ready' : status === 'opening' ? 'connecting' : 'idle'

  /**
   * A selection that did not open the requested project (no grant, access lost, DG unreachable, a failed start)
   * leaves the DG page showing the refused project as picked. Put it back on the project that is actually open, or
   * on none, and settle the ring (F-07, D-48). A superseded selection is left to the one that superseded it.
   */
  const settleAfterSelection = (result: SelectResult): void => {
    // `in` narrows without strictNullChecks, where `ok` alone does not discriminate the union.
    if (result.ok || ('code' in result && result.code === 'SUPERSEDED')) {
      return
    }

    const { status, project } = scope.getState()
    const fragment = projectFragment(status === 'ready' ? project : null)

    if (fragment) {
      void viewTask(() => dgView.signal(fragment))
    }

    noteHostState(hostStateOf(status))
  }

  const dgView: DgView = createDgView({
    origin: deps.origin,
    partition: deps.partition,
    isCurrent,
    createView: deps.createView,
    emit: onEvent,
    openExternal: deps.openExternal,
    logger,
    onProjectAnnounced: name => {
      // The page already shows its own connecting sphere; the host confirms it, then settles on the outcome
      // (a refused project never changes the scope state, so the final state is read once the call returns).
      noteHostState('connecting')
      void scope
        .selectProject(name)
        .then(settleAfterSelection)
        .finally(() => noteHostState(hostStateOf(scope.getState().status)))
    },
    // D-41: a fresh chat only while a scope is ready; the page's hash is a request, never an authority.
    onNewSessionRequested: () => {
      if (scope.getState().status === 'ready') {
        onEvent({ type: 'new-session-requested' })
      }
    }
  })

  scope = createScopeController({
    session,
    origin: deps.origin,
    environmentId: deps.environmentId,
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

  const unsubscribeAuth = session.onAuth(auth => {
    const wasSignedIn = previousKind === 'signed-in'

    if (auth.kind !== 'unreachable') {
      previousKind = auth.kind
    }

    // Signing in inside the DG page: show the DG page once the session is confirmed.
    if (auth.kind === 'signed-in' && !wasSignedIn) {
      void viewTask(showDgForScope)
    }

    publish()
  })

  const unsubscribeScope = scope.onState(next => {
    noteHostState(hostStateOf(next.status))
    publish()
  })

  const start = async (): Promise<void> => {
    const me = await session.refresh()

    if (me.kind === 'unreachable') {
      // G-16: DG reset or refused the first check. Say so now (the renderer shows the DG-unreachable state with
      // a Retry) instead of loading a page that would fail into a blank window.
      onEvent({ type: 'dg-unreachable' })
    } else if (me.kind !== 'signed-in') {
      await viewTask(() => dgView.showSignIn())
    }

    await viewChain
    publish()
  }

  /** At most one re-check in flight, so a burst of Retry clicks or focus events never floods DG (T-1301-20-03). */
  let retrying: Promise<void> | null = null

  const retryDg = (): Promise<void> => {
    if (retrying) {
      return retrying
    }

    retrying = (async (): Promise<void> => {
      const wasSignedIn = previousKind === 'signed-in'
      const me = await session.refresh()

      if (me.kind === 'unreachable') {
        if (reachable) {
          onEvent({ type: 'dg-unreachable' })
        }

        return
      }

      if (me.kind === 'signed-in') {
        // A first sign-in already queued the DG page through the auth listener; a session that was signed in all
        // along (unreachable in between) has to be loaded here.
        if (wasSignedIn) {
          await viewTask(showDgForScope)
        }
      } else {
        await viewTask(() => dgView.showSignIn())
      }

      await viewChain
      publish()
    })().finally(() => {
      retrying = null
    })

    return retrying
  }

  return {
    session,
    scope,
    dgView,
    getState,
    start,
    selectProject: async (project: string): Promise<SelectResult> => {
      const result = await scope.selectProject(project)

      settleAfterSelection(result)
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
    retryDg,
    setDgBounds: (bounds: DgBounds | null): void => dgView.setBounds(bounds),
    setTrayLabels: (labels: DegramTrayLabels): void => {
      trayLabels = { signOut: labels.signOut }
      deps.onTrayLabelsChanged?.()
    },
    getTrayLabels: (): DegramTrayLabels => trayLabels,
    dgGo: (region: DgRegion): Promise<void> => viewTask(() => dgView.signal(`#degram-go=${region}`)),
    setLocale: (locale: DgLocale): Promise<void> => viewTask(() => dgView.setLocale(locale)),
    requestSignOut: (): void => deps.send(DEGRAM_CHANNELS.requestSignOut, null),
    openExternalConfirmed: (url: string): boolean => dgView.openExternalConfirmed(url),
    reportOutcome: async (code: string): Promise<boolean> => {
      const known = await scope.reportOutcome(code)

      publish()

      return known
    },
    closeForEnvironmentSwitch: async (): Promise<void> => {
      await scope.closeForEnvironmentSwitch()
    },
    quiesceForEnvironmentSwitch: (target): Promise<void> => scope.quiesceForEnvironmentSwitch(target),
    resumeForEnvironmentSwitch: (target): Promise<void> => scope.resumeForEnvironmentSwitch(target),
    onWindowFocus: async (): Promise<void> => {
      if (!reachable) {
        // D-08: focus is the re-check trigger while DG is unreachable (no timer polling), through the same
        // single-flight path as the Retry button.
        await retryDg()
      }

      await scope.checkAccess('focus')
      await viewChain
      publish()
    },
    onAuthCookieChanged: async (): Promise<void> => {
      // A clearing sequence (sign-out, revocation) wipes the cookie itself; its own change event is not news.
      if (!isCurrent() || !scope.isSettled()) {
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
      disposed = true
      unsubscribeAuth()
      unsubscribeScope()
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

function asRegion(value: unknown): DgRegion {
  if (typeof value !== 'string' || !(DG_REGIONS as readonly string[]).includes(value)) {
    throw invalid('region')
  }

  return value as DgRegion
}

function asLocale(value: unknown): DgLocale {
  if (value !== 'ru' && value !== 'en') {
    throw invalid('locale')
  }

  return value
}

const MAX_LABEL_LENGTH = 80

function asTrayLabels(value: unknown): DegramTrayLabels {
  const signOut = (value as { signOut?: unknown } | null)?.signOut

  if (typeof signOut !== 'string' || !signOut.trim() || signOut.length > MAX_LABEL_LENGTH || hasControl(signOut)) {
    throw invalid('tray labels')
  }

  return { signOut: signOut.trim() }
}

function hasControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(text)
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
    DEGRAM_CHANNELS.retryDg,
    guarded(() => runtime.retryDg())
  )
  ipc.handle(
    DEGRAM_CHANNELS.setTrayLabels,
    guarded((labels: unknown) => runtime.setTrayLabels(asTrayLabels(labels)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.dgGo,
    guarded((region: unknown) => runtime.dgGo(asRegion(region)))
  )
  ipc.handle(
    DEGRAM_CHANNELS.setLocale,
    guarded((locale: unknown) => runtime.setLocale(asLocale(locale)))
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
}
