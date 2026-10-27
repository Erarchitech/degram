// main-wiring.ts — the thin Electron-facing shell around the DeGram runtime (Phase 1301-12).
//
// main.ts hands this module the Electron primitives (net-backed partition fetch, WebContentsView factory,
// ipcMain, the DG partition session) and gets back a runtime plus `attachWindow`. Everything with logic
// lives in ipc.ts / scope.ts / dg-view.ts; this file only decides which window is "the DeGram window":
// it mounts the DG view into it, sends state to it, and accepts IPC only from its renderer.

import { DEGRAM_CHANNELS } from './channels'
import { createEnvironmentController, type EnvironmentController, type EnvironmentRuntimeDescriptor, type EnvironmentState } from './environment-controller'
import type { DgTargetDescriptor, DgTargetMode } from './dg-target-config'
import type { DgBounds, DgLocale, DgMode } from './dg-view'
import type { DegramTrayLabels } from './ipc'
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
  removeListener?: (event: 'closed' | 'focus', listener: () => void) => unknown
}

export interface CookieSessionLike {
  cookies: {
    on: (event: 'changed', listener: (event: unknown, cookie: { name: string }) => void) => unknown
    removeListener?: (event: 'changed', listener: (event: unknown, cookie: { name: string }) => void) => unknown
  }
}

export interface DegramMainDeps extends Omit<DegramRuntimeDeps, 'send'> {
  registerIpc?: boolean
  autoStart?: boolean
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
  /** Strict switch-only release of credential/backend plus listeners, view and timers. */
  closeForEnvironmentSwitch: () => Promise<void>
  /** The gateway-backed activity fence of this target-bound runtime. */
  quiesceForEnvironmentSwitch: (target: { environmentId: string; generation: number }) => Promise<void>
  resumeForEnvironmentSwitch: (target: { environmentId: string; generation: number }) => Promise<void>
}

export interface DegramEnvironmentWiring {
  controller: EnvironmentController
  attachWindow: (window: DegramWindowLike) => void
  started: () => Promise<unknown>
  trayItems: DegramMainWiring['trayItems']
}

/** Register once against the coordinator; replacing a target never leaves IPC pointing at its old runtime. */
export function createDegramEnvironmentWiring(deps: {
  targets: Record<DgTargetMode, DgTargetDescriptor>
  selected: DgTargetDescriptor
  overrideActive?: boolean
  persist: (mode: DgTargetMode) => void | Promise<void>
  ipcMain: IpcMainLike
  createDeps: (descriptor: EnvironmentRuntimeDescriptor) => Omit<DegramMainDeps, 'ipcMain'>
}): DegramEnvironmentWiring {
  let window: DegramWindowLike | null = null
  let active: DegramMainWiring | null = null
  let boot: Promise<unknown> = Promise.resolve()
  let bounds: DgBounds | null = null
  let locale: DgLocale = 'ru'
  let viewMode: DgMode | null = null
  let trayLabels: DegramTrayLabels | null = null
  const operations = new Map<number, ReturnType<EnvironmentController['acquireLease']>>()
  const controller = createEnvironmentController({
    targets: deps.targets,
    selected: deps.selected,
    overrideActive: deps.overrideActive,
    persist: deps.persist,
    createRuntime: descriptor => {
      const wiring: DegramMainWiring = createDegramMainWiring({
        ...deps.createDeps(descriptor),
        ipcMain: deps.ipcMain,
        environmentId: descriptor.environmentId,
        generation: descriptor.generation,
        targetPresentation: { mode: descriptor.mode, generation: descriptor.generation, locked: deps.overrideActive === true },
        onTargetRequested: (mode, generation) => {
          const state = controller.getState()
          if (!descriptor.isCurrent() || state.generation !== generation || state.status !== 'ready' || deps.overrideActive) return
          void controller.selectTarget(mode).then(result => {
            if (!result.ok && descriptor.isCurrent()) void wiring.runtime.dgView.signal('#degram-target-refused')
          }).catch(() => {
            if (descriptor.isCurrent()) void wiring.runtime.dgView.signal('#degram-target-refused')
          })
        },
        origin: descriptor.origin,
        partition: descriptor.partition,
        isCurrent: descriptor.isCurrent,
        registerIpc: false,
        autoStart: false
      })
      active = wiring
      return {
        quiesce: wiring.quiesceForEnvironmentSwitch,
        resume: wiring.resumeForEnvironmentSwitch,
        closeForEnvironmentSwitch: wiring.closeForEnvironmentSwitch,
        dispose: () => { if (active === wiring) active = null },
        start: async () => {
          if (window) wiring.attachWindow(window)
          wiring.runtime.setDgBounds(bounds)
          await wiring.runtime.setLocale(locale)
          if (viewMode) await wiring.runtime.setDgMode(viewMode)
          if (trayLabels) wiring.runtime.setTrayLabels(trayLabels)
          await wiring.runtime.start()
          if (!wiring.runtime.getState().dg.reachable) throw new Error('DG unavailable')
        }
      }
    }
  })
  controller.onState(state => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(DEGRAM_CHANNELS.environmentChanged, state)
    }
  })
  const trusted = (sender: unknown): boolean => Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed() && sender === window.webContents)
  const currentRuntime = (): DegramRuntime => {
    if (!active || controller.getState().status !== 'ready') throw new Error('degram: environment not ready')
    return active.runtime
  }
  registerDegramIpc(deps.ipcMain, new Proxy({} as DegramRuntime, {
    get: (_target, key) => (...args: unknown[]) => {
      const runtime = currentRuntime()
      const lease = controller.acquireLease()
      if (!lease) throw new Error('degram: environment not ready')
      try {
        const result = (runtime[key as keyof DegramRuntime] as (...args: unknown[]) => unknown)(...args)
        // Only validated calls reach this proxy; presentation preferences survive runtime replacement.
        if (key === 'setDgBounds') bounds = args[0] as DgBounds | null
        if (key === 'setLocale') locale = args[0] as DgLocale
        if (key === 'setDgMode') viewMode = args[0] as DgMode
        if (key === 'setTrayLabels') trayLabels = args[0] as DegramTrayLabels
        if (result instanceof Promise) return result.finally(lease.release)
        lease.release()
        return result
      } catch (error) {
        lease.release()
        throw error
      }
    }
  }), trusted)
  const guarded = (handler: (payload: any) => unknown) => (event: { sender: unknown }, payload: unknown): unknown => {
    if (!trusted(event.sender)) throw new Error('degram: untrusted sender')
    return handler(payload)
  }
  const expected = (payload: unknown): EnvironmentState => {
    const state = controller.getState()
    const value = payload as { environmentId?: unknown; generation?: unknown } | null
    if (!value || value.environmentId !== state.selected.environmentId || value.generation !== state.generation) {
      throw new Error('degram: stale environment generation')
    }
    return state
  }
  deps.ipcMain.handle(DEGRAM_CHANNELS.getEnvironment, guarded(() => controller.getState()))
  deps.ipcMain.handle(DEGRAM_CHANNELS.selectTarget, guarded(payload => {
    expected(payload)
    if (payload.mode !== 'developer' && payload.mode !== 'demo') throw new Error('degram: invalid target')
    return controller.selectTarget(payload.mode)
  }))
  deps.ipcMain.handle(DEGRAM_CHANNELS.retryTarget, guarded(payload => {
    expected(payload)
    return controller.retrySelectedTarget()
  }))
  deps.ipcMain.handle(DEGRAM_CHANNELS.acquireOperation, guarded(payload => {
    expected(payload)
    const lease = controller.acquireLease()
    if (!lease) throw new Error('degram: environment not ready')
    operations.set(lease.id, lease)
    return { id: lease.id, environmentId: lease.environmentId, generation: lease.generation }
  }))
  deps.ipcMain.handle(DEGRAM_CHANNELS.releaseOperation, guarded(payload => {
    expected(payload)
    const lease = operations.get(payload.id)
    if (!lease || lease.environmentId !== payload.environmentId || lease.generation !== payload.generation) {
      throw new Error('degram: invalid operation lease')
    }
    lease.release()
    operations.delete(lease.id)
  }))
  return {
    controller,
    attachWindow: next => {
      window = next
      if (controller.getState().status === 'idle') boot = controller.retrySelectedTarget()
      else active?.attachWindow(next)
    },
    started: () => boot,
    trayItems: () => active?.trayItems() ?? []
  }
}

export function createDegramMainWiring(deps: DegramMainDeps): DegramMainWiring {
  let current: DegramWindowLike | null = null
  let startPromise: Promise<void> | null = null
  let removeWindowListeners = (): void => undefined

  const live = (): DegramWindowLike | null =>
    current && !current.isDestroyed() && !current.webContents.isDestroyed() ? current : null

  const runtime: DegramRuntime = createDegramRuntime({
    origin: deps.origin,
    environmentId: deps.environmentId,
    generation: deps.generation,
    targetPresentation: deps.targetPresentation,
    onTargetRequested: deps.onTargetRequested,
    partition: deps.partition,
    isCurrent: deps.isCurrent,
    fetch: deps.fetch,
    clock: deps.clock,
    logger: deps.logger,
    createView: deps.createView,
    openExternal: deps.openExternal,
    profiles: deps.profiles,
    backend: deps.backend,
    onTrayLabelsChanged: deps.onTrayLabelsChanged,
    connectors: deps.connectors,
    confirmInstall: deps.confirmInstall,
    send: (channel, payload) => live()?.webContents.send(channel, payload)
  })

  if (deps.registerIpc !== false) {
    registerDegramIpc(deps.ipcMain, runtime, sender => current !== null && sender === (current.webContents as unknown))
  }

  let closed = false
  const onCookieChanged = (_event: unknown, cookie: { name: string }): void => {
    if (closed || (deps.isCurrent && !deps.isCurrent())) return
    if (cookie.name === DG_SESSION_COOKIE) {
      void runtime
        .onAuthCookieChanged()
        .catch(() => deps.logger.warn('[degram] session re-check after a cookie change failed'))
    }
  }

  deps.cookieSession.cookies.on('changed', onCookieChanged)

  const attachWindow = (window: DegramWindowLike): void => {
    removeWindowListeners()
    current = window
    // Hidden until the renderer's DG page reports where it sits (setDgBounds).
    runtime.dgView.setBounds(null)
    window.contentView.addChildView(runtime.dgView.view)

    // D-08: a focus check is the third way an access loss is noticed (after any 401 and the heartbeat).
    const onFocus = (): void => {
      if (!closed && current === window && (deps.isCurrent?.() ?? true)) {
        void runtime.onWindowFocus().catch(() => deps.logger.warn('[degram] focus access check failed'))
      }
    }

    const onClosed = (): void => {
      if (current === window) {
        current = null
      }

      try {
        window.contentView.removeChildView(runtime.dgView.view)
      } catch {
        // the window is already gone
      }
      removeWindowListeners()
    }
    window.on('focus', onFocus)
    window.on('closed', onClosed)
    removeWindowListeners = () => {
      window.removeListener?.('focus', onFocus)
      window.removeListener?.('closed', onClosed)
    }

    if (!startPromise && deps.autoStart !== false) {
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

  const closeForEnvironmentSwitch = async (): Promise<void> => {
    // Credentials/backend must be released before removing the remaining target-bound resources.
    await runtime.closeForEnvironmentSwitch()
    closed = true
    removeWindowListeners()
    deps.cookieSession.cookies.removeListener?.('changed', onCookieChanged)
    runtime.dispose()

    const window = current
    current = null
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(runtime.dgView.view)
      } catch {
        // The view/window may already have been detached by Electron.
      }
    }
  }

  return {
    runtime,
    attachWindow,
    started: (): Promise<void> => startPromise ?? Promise.resolve(),
    trayItems,
    closeForEnvironmentSwitch,
    quiesceForEnvironmentSwitch: target => runtime.quiesceForEnvironmentSwitch(target),
    resumeForEnvironmentSwitch: target => runtime.resumeForEnvironmentSwitch(target)
  }
}
