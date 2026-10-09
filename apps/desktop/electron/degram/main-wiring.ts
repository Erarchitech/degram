// main-wiring.ts — the thin Electron-facing shell around the DeGram runtime (Phase 1301-12).
//
// main.ts hands this module the Electron primitives (net-backed partition fetch, WebContentsView factory,
// ipcMain, the DG partition session) and gets back a runtime plus `attachWindow`. Everything with logic
// lives in ipc.ts / scope.ts / dg-view.ts; this file only decides which window is "the DeGram window":
// it mounts the DG view into it, sends state to it, and accepts IPC only from its renderer.

import {
  createDegramRuntime,
  type DegramRuntime,
  type DegramRuntimeDeps,
  type IpcMainLike,
  registerDegramIpc
} from './ipc'

/** The cookie whose change means the DG sign-in started or ended (set by the DG data-service). */
const DG_SESSION_COOKIE = 'dg_session'

export interface DegramWindowLike {
  webContents: {
    send: (channel: string, payload: unknown) => void
    isDestroyed: () => boolean
  }
  isDestroyed: () => boolean
  contentView: {
    addChildView: (view: any) => void
    removeChildView: (view: any) => void
  }
  on: (event: 'closed' | 'focus', listener: () => void) => unknown
}

export interface CookieSessionLike {
  cookies: {
    on: (event: 'changed', listener: (event: unknown, cookie: { name: string }) => void) => unknown
  }
}

export interface DegramMainDeps extends Omit<DegramRuntimeDeps, 'send'> {
  /** Bring the DeGram window forward (the tray's sign-out entry shows the window before it asks). */
  showWindow?: () => void
  ipcMain: IpcMainLike
  /** `session.fromPartition(DEGRAM_DG_PARTITION)`. */
  cookieSession: CookieSessionLike
}

export interface DegramMainWiring {
  readonly runtime: DegramRuntime
  /** Mount the DG view into this window and make it the window DeGram talks to. */
  attachWindow: (window: DegramWindowLike) => void
  /** Resolves when the first auth check and DG page load of the runtime have settled. */
  started: () => Promise<void>
  /** Extra native tray entries of this variant: sign out of DG, shown between Show and Quit (G-17). */
  trayItems: () => { label: string; click: () => void }[]
}

export function createDegramMainWiring(deps: DegramMainDeps): DegramMainWiring {
  let current: DegramWindowLike | null = null
  let startPromise: Promise<void> | null = null

  const live = (): DegramWindowLike | null =>
    current && !current.isDestroyed() && !current.webContents.isDestroyed() ? current : null

  const runtime: DegramRuntime = createDegramRuntime({
    origin: deps.origin,
    fetch: deps.fetch,
    clock: deps.clock,
    logger: deps.logger,
    createView: deps.createView,
    openExternal: deps.openExternal,
    profiles: deps.profiles,
    backend: deps.backend,
    pairing: deps.pairing,
    onTrayLabelsChanged: deps.onTrayLabelsChanged,
    send: (channel, payload) => live()?.webContents.send(channel, payload)
  })

  registerDegramIpc(deps.ipcMain, runtime, sender => current !== null && sender === (current.webContents as unknown))

  deps.cookieSession.cookies.on('changed', (_event, cookie) => {
    if (cookie.name === DG_SESSION_COOKIE) {
      void runtime
        .onAuthCookieChanged()
        .catch(() => deps.logger.warn('[degram] session re-check after a cookie change failed'))
    }
  })

  const attachWindow = (window: DegramWindowLike): void => {
    current = window
    // Hidden until the renderer's DG page reports where it sits (setDgBounds).
    runtime.dgView.setBounds(null)
    window.contentView.addChildView(runtime.dgView.view)

    // D-08: a focus check is the third way an access loss is noticed (after any 401 and the heartbeat).
    window.on('focus', () => {
      void runtime.onWindowFocus().catch(() => deps.logger.warn('[degram] focus access check failed'))
    })

    window.on('closed', () => {
      if (current === window) {
        current = null
      }

      try {
        window.contentView.removeChildView(runtime.dgView.view)
      } catch {
        // the window is already gone
      }
    })

    if (!startPromise) {
      startPromise = runtime.start().catch(() => {
        deps.logger.error('[degram] the DG session could not be started')
      })
    }
  }

  const trayItems = (): { label: string; click: () => void }[] => [
    {
      label: runtime.getTrayLabels().signOut,
      click: () => {
        // Show the window first: the confirmation (a response is running) and the sign-in surface live in it.
        deps.showWindow?.()
        runtime.requestSignOut()
      }
    }
  ]

  return { runtime, attachWindow, started: (): Promise<void> => startPromise ?? Promise.resolve(), trayItems }
}
