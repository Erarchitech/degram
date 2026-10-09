// dg-view.ts — the embedded DG web page (Phase 1301-12, D-05/D-07).
//
// DG is shown in a `WebContentsView` of the isolated partition `persist:degram-dg`: the user signs in on
// the real DG login page (top-level, never an iframe, never a DeGram form), and the same view later shows
// the `#degram` graph slice or the full V2 app including the Model Viewer. The remote page is untrusted
// content inside a desktop shell, so the view gets:
//
//   * no preload, contextIsolation + sandbox on, nodeIntegration off, no webview tag (T-1301-12-01);
//   * navigation, redirects and window.open allowed only for the configured DG origin, exact scheme +
//     host + port; everything else is blocked and REPORTED so the renderer can offer an explicit
//     "Open in browser" action (T-1301-12-02);
//   * every permission request denied;
//   * DG's own response headers untouched (nothing here rewrites headers or injects scripts).
//
// Electron is injected (`createView`), so the suite runs without it.

import { DEGRAM_DG_PARTITION } from './dg-config'
import type { Logger } from './dg-session'
import type { DegramEvent } from './scope'

export type DgMode = 'graph' | 'full'
export type DgViewPage = 'blank' | 'sign-in' | 'dg'

export interface DgViewState {
  page: DgViewPage
  mode: DgMode
}

/** The web preferences of the DG view. Deliberately has no `preload`. */
export const DG_VIEW_WEB_PREFERENCES = Object.freeze({
  partition: DEGRAM_DG_PARTITION,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false
})

export type DgViewWebPreferences = typeof DG_VIEW_WEB_PREFERENCES

export interface DgWebContentsLike {
  loadURL: (url: string) => Promise<void>
  reload: () => void
  /** The committed URL; the error page of a failed load is not a DG URL. */
  getURL?: () => string
  on: (event: string, listener: (...args: any[]) => void) => unknown
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void
  isDestroyed: () => boolean
  close?: () => void
  session: {
    clearStorageData: (options?: { storages?: string[] }) => Promise<void>
    clearCache: () => Promise<void>
    setPermissionRequestHandler?: (
      handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void
    ) => void
  }
}

export interface DgWebViewLike {
  webContents: DgWebContentsLike
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
  setVisible: (visible: boolean) => void
}

export interface DgViewDeps {
  origin: string
  /** `new WebContentsView({ webPreferences })`. */
  createView: (webPreferences: DgViewWebPreferences) => DgWebViewLike
  emit: (event: DegramEvent) => void
  /** `shell.openExternal`. */
  openExternal: (url: string) => unknown
  logger: Logger
}

export interface DgBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DgView {
  /** The native view; main mounts it with `window.contentView.addChildView`. */
  readonly view: DgWebViewLike
  getState: () => DgViewState
  setMode: (mode: DgMode) => Promise<void>
  showSignIn: () => Promise<void>
  showDg: () => Promise<void>
  reload: () => Promise<void>
  /** Blank the view so no tenant page stays painted. */
  reset: () => Promise<void>
  /** Wipe the partition's cookies, storage and cache (`keepCookies` keeps the DG sign-in). */
  clearStorage: (options?: { keepCookies?: boolean }) => Promise<void>
  setBounds: (bounds: DgBounds | null) => void
  openExternalConfirmed: (url: string) => boolean
  destroy: () => void
}

/** Exact-origin allowlist (scheme, host, port). Userinfo, other schemes and unparseable input never match. */
export function isAllowedDgUrl(url: unknown, origin: string): boolean {
  if (typeof url !== 'string' || !url) {
    return false
  }

  let target: URL
  let base: URL

  try {
    target = new URL(url)
    base = new URL(origin)
  } catch {
    return false
  }

  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return false
  }

  if (target.username || target.password) {
    return false
  }

  return target.protocol === base.protocol && target.origin === base.origin
}

/** The page URL of a mode: the `#degram` slice, or the whole V2 app. */
export function dgUrlFor(origin: string, mode: DgMode): string {
  return mode === 'graph' ? `${origin}/#degram` : `${origin}/`
}

const ABORTED = -3
/** Storage kinds wiped when the DG sign-in cookie is to survive (an access loss on one project). */
const TENANT_STORAGES = ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'websql']

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) {
    return false
  }

  try {
    const parsed = new URL(url)

    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function validBounds(bounds: DgBounds): boolean {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
  )
}

export function createDgView(deps: DgViewDeps): DgView {
  const { origin, logger } = deps
  const view: DgWebViewLike = deps.createView(DG_VIEW_WEB_PREFERENCES)
  const contents = view.webContents
  let state: DgViewState = { page: 'blank', mode: 'graph' }

  const load = async (url: string): Promise<void> => {
    try {
      await contents.loadURL(url)
    } catch (error) {
      // Never put the URL (it may carry a query) into a log: origin and cause only.
      logger.warn(`[degram] DG view load did not complete (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }

  const block = (url: string): void => {
    deps.emit({ type: 'external-link-blocked', url })
  }

  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedDgUrl(url, origin)) {
      event.preventDefault()
      block(url)
    }
  }

  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-attach-webview', (event: { preventDefault: () => void }) => event.preventDefault())

  contents.setWindowOpenHandler((details: { url: string }): { action: 'deny' } => {
    if (isAllowedDgUrl(details.url, origin)) {
      // A DG link that wants a new window opens in this view instead: no second window, no popup.
      void load(details.url)
    } else {
      block(details.url)
    }

    return { action: 'deny' }
  })

  // A failed main-frame load is followed by did-finish-load of Chromium's error page (G-16); only a navigation
  // that did not fail and committed a DG page may report DG reachable.
  let navigationFailed = false

  contents.on('did-start-loading', () => {
    navigationFailed = false
  })
  contents.on(
    'did-fail-load',
    (_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && errorCode !== ABORTED) {
        navigationFailed = true
        deps.emit({ type: 'dg-unreachable' })
      }
    }
  )
  contents.on('did-finish-load', () => {
    if (navigationFailed) {
      return
    }

    const committed = contents.getURL?.()

    if (committed !== undefined && !isAllowedDgUrl(committed, origin)) {
      return
    }

    deps.emit({ type: 'dg-reachable' })
  })

  contents.session.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false))

  const showSignIn = async (): Promise<void> => {
    state = { ...state, page: 'sign-in' }
    await load(`${origin}/`)
  }

  const showDg = async (): Promise<void> => {
    state = { ...state, page: 'dg' }
    await load(dgUrlFor(origin, state.mode))
  }

  return {
    view,
    getState: (): DgViewState => state,
    setMode: async (mode: DgMode): Promise<void> => {
      if (mode !== 'graph' && mode !== 'full') {
        throw new Error('unknown DG mode')
      }

      state = { ...state, mode }

      if (state.page === 'dg') {
        await load(dgUrlFor(origin, mode))
      }
    },
    showSignIn,
    showDg,
    reload: async (): Promise<void> => {
      if (state.page === 'blank') {
        await load('about:blank')

        return
      }

      contents.reload()
    },
    reset: async (): Promise<void> => {
      state = { ...state, page: 'blank' }
      await load('about:blank')
    },
    clearStorage: async (options?: { keepCookies?: boolean }): Promise<void> => {
      if (options?.keepCookies) {
        await contents.session.clearStorageData({ storages: TENANT_STORAGES })
      } else {
        await contents.session.clearStorageData()
      }

      await contents.session.clearCache()
    },
    setBounds: (bounds: DgBounds | null): void => {
      if (!bounds || !validBounds(bounds)) {
        view.setVisible(false)

        return
      }

      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
      view.setVisible(true)
    },
    openExternalConfirmed: (url: string): boolean => {
      if (!isHttpUrl(url)) {
        return false
      }

      void deps.openExternal(url)

      return true
    },
    destroy: (): void => {
      if (!contents.isDestroyed()) {
        contents.close?.()
      }
    }
  }
}
