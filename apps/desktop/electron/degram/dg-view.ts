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
/** What the host tells the page about the scope (D-44), exactly the vocabulary of ui-v2/src/lib/hostMode.js. */
export type DgHostState = 'connecting' | 'ready' | 'idle'
/** The regions the host may steer the page to (D-42). */
export type DgRegion = 'landing' | 'graph' | 'model' | 'connectors' | 'projects'
export type DgLocale = 'ru' | 'en'

export const DG_HOST_STATES: readonly DgHostState[] = ['connecting', 'ready', 'idle']
export const DG_REGIONS: readonly DgRegion[] = ['landing', 'graph', 'model', 'connectors', 'projects']

const HOST_STATE_FRAGMENT = /^#degram-state=(connecting|ready|idle)$/
const HOST_GO_FRAGMENT = /^#degram-go=(landing|graph|model|connectors|projects)$/
/** `#degram-project=<encodeURIComponent(name)>`; an empty value means no project is open (1301-37, F-07). */
const HOST_PROJECT_FRAGMENT = /^#degram-project=([^&#]{0,200})$/
/** The same name grammar the page's announcement is validated with (and ui-v2's 64 character cap). */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/** True for a `#degram-project=` fragment whose decoded value is empty or a valid project name. */
export function isHostProjectFragment(fragment: unknown): boolean {
  if (typeof fragment !== 'string') {
    return false
  }

  const match = HOST_PROJECT_FRAGMENT.exec(fragment)

  if (!match) {
    return false
  }

  try {
    const name = decodeURIComponent(match[1])

    return name === '' || PROJECT_NAME.test(name)
  } catch {
    return false
  }
}

/** The fragment that tells the page which project is open (`null`: none). Null when the name cannot be signalled. */
export function projectFragment(name: string | null): string | null {
  const fragment = `#degram-project=${name ? encodeURIComponent(name) : ''}`

  return isHostProjectFragment(fragment) ? fragment : null
}

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
  /** A validated project name announced by the untrusted DG page through its URL hash only. */
  onProjectAnnounced?: (name: string) => void
  /** The untrusted DG page asked for a fresh chat through the exact `#degram-new-session` hash (D-41). */
  onNewSessionRequested?: () => void
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
  /** The start screen's DG page: the whole V2 app in host mode, whose Projects region announces the choice (D-33). */
  showStart: () => Promise<void>
  /**
   * Tell the page something through a fragment of the URL it already shows (never a reload): exactly
   * `#degram-state=connecting|ready|idle`, `#degram-go=landing|graph|model|connectors` or
   * `#degram-project=<name>` (empty: no project open). Throws on anything else.
   * Nothing is loaded while the host page is not shown.
   */
  signal: (fragment: string) => Promise<void>
  /**
   * Remember the scope state synchronously (the caller serializes `signal`): every later full page load carries it
   * in its initial hash, so a reload or a sign-in round trip never shows a stale ring.
   */
  setHostState: (next: DgHostState) => void
  /** The DeGram locale, appended as `&lang=ru|en` to the host page URL of the next load. */
  setLocale: (locale: DgLocale) => void
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
  return mode === 'graph' ? `${origin}/#degram` : `${origin}/?host=degram`
}

/** The host-mode page URL (the whole V2 app); the locale rides in the query so the page renders in it. */
function hostPageUrl(origin: string, lang: DgLocale | null): string {
  return lang ? `${dgUrlFor(origin, 'full')}&lang=${lang}` : dgUrlFor(origin, 'full')
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
  let lang: DgLocale | null = null
  let hostState: DgHostState = 'idle'
  /** The host-mode page URL that is currently loaded; a fragment signal is a change of its hash only. */
  let loadedBase: string | null = null

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

  contents.on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || !isAllowedDgUrl(url, origin)) {
      return
    }
    let hash: string
    try { hash = new URL(url).hash } catch { return }
    if (hash === '#degram-new-session') {
      deps.onNewSessionRequested?.()

      return
    }
    const match = /^#degram-select=([^&]{1,200})$/.exec(hash)
    if (!match) {
      return
    }
    try {
      const name = decodeURIComponent(match[1])
      if (/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) {
        deps.onProjectAnnounced?.(name)
      }
    } catch {
      // Ignore malformed untrusted hashes without logging their content.
    }
  })

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

  /** Load a page of this view and remember which host base URL it is (`null` for a page that takes no fragment). */
  const loadPage = async (base: string | null, url: string): Promise<void> => {
    loadedBase = base
    await load(url)
  }

  /** The URL of a full-mode load: the base, carrying the remembered host state so a reload keeps the ring state. */
  const hostLoadUrl = (base: string): string => (hostState === 'idle' ? base : `${base}#degram-state=${hostState}`)

  const showSignIn = async (): Promise<void> => {
    state = { ...state, page: 'sign-in' }

    const base = hostPageUrl(origin, lang)

    await loadPage(base, base)
  }

  const showMode = async (mode: DgMode): Promise<void> => {
    if (mode === 'graph') {
      await loadPage(null, dgUrlFor(origin, 'graph'))

      return
    }

    const base = hostPageUrl(origin, lang)

    await loadPage(base, hostLoadUrl(base))
  }

  const showDg = async (): Promise<void> => {
    state = { ...state, page: 'dg' }
    await showMode(state.mode)
  }

  // The #degram graph slice has no project announcement, so a start screen showing it is a dead end.
  const showStart = async (): Promise<void> => {
    state = { page: 'dg', mode: 'full' }
    await showMode('full')
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
        await showMode(mode)
      }
    },
    signal: async (fragment: string): Promise<void> => {
      if (
        typeof fragment !== 'string' ||
        !(HOST_STATE_FRAGMENT.test(fragment) || HOST_GO_FRAGMENT.test(fragment) || isHostProjectFragment(fragment))
      ) {
        throw new Error('unknown DG signal')
      }

      // Only a loaded host page can take a fragment: not the #degram slice, a blank view or a foreign page.
      if (state.page === 'dg' && state.mode === 'full' && loadedBase) {
        // Same document, new hash: Chromium treats it as an in-page navigation and does not reload.
        await load(`${loadedBase}${fragment}`)
      }
    },
    setHostState: (next: DgHostState): void => {
      if (!DG_HOST_STATES.includes(next)) {
        throw new Error('unknown DG host state')
      }

      hostState = next
    },
    setLocale: (locale: DgLocale): void => {
      if (locale !== 'ru' && locale !== 'en') {
        throw new Error('unknown DG locale')
      }

      lang = locale
    },
    showSignIn,
    showDg,
    showStart,
    reload: async (): Promise<void> => {
      if (state.page === 'blank') {
        await loadPage(null, 'about:blank')

        return
      }

      contents.reload()
    },
    reset: async (): Promise<void> => {
      state = { ...state, page: 'blank' }
      await loadPage(null, 'about:blank')
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
