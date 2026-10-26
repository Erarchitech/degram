// environment-controller.ts — main-owned DGMODE runtime switching (Phase 1301-44).
//
// This coordinator is deliberately independent of Electron objects. main-wiring supplies the
// target-bound runtime factory; this module serializes its lifecycle and is the authority for
// switching and operation leases. The renderer may display state and hold a lease, but never
// decides that a backend is idle.

import type { DgTargetDescriptor, DgTargetMode } from './dg-target-config'

export type EnvironmentStatus = 'idle' | 'ready' | 'switching' | 'error'

export type EnvironmentErrorCode =
  | 'BUSY'
  | 'INVALID_TARGET'
  | 'OVERRIDE_ACTIVE'
  | 'PERSIST_FAILED'
  | 'QUIESCE_FAILED'
  | 'TEARDOWN_FAILED'
  | 'START_FAILED'
  | 'SWITCH_IN_PROGRESS'

export interface EnvironmentState {
  selected: DgTargetDescriptor
  effectiveRuntime: DgTargetDescriptor | null
  status: EnvironmentStatus
  error: EnvironmentErrorCode | null
  /** Globally monotonic fence for every target-bound async publication. */
  generation: number
  override: boolean
}

export interface EnvironmentConfigurationError {
  selected: null
  effectiveRuntime: null
  status: 'error'
  error: 'CONFIG_INVALID'
  generation: 0
  override: boolean
}

export type EnvironmentViewState = EnvironmentState | EnvironmentConfigurationError

export interface EnvironmentLease {
  id: number
  environmentId: string
  generation: number
  release: () => void
}

export interface TargetRuntime {
  /**
   * Stop accepting old-generation work and prove that the backend has no live operation.
   * The matching resume is used only when persistence did not complete.
   */
  quiesce: (target: { environmentId: string; generation: number }) => Promise<void>
  resume: (target: { environmentId: string; generation: number }) => Promise<void>
  /** Clear in-memory credential then release the backend. Must reject on either failure. */
  closeForEnvironmentSwitch: () => Promise<void>
  /** Dispose target-bound view/listener/timer resources after close succeeds. */
  dispose: () => Promise<void> | void
  /** Authenticate and initialise only this immutable descriptor. */
  start: () => Promise<void>
}

export interface EnvironmentRuntimeDescriptor extends DgTargetDescriptor {
  generation: number
  /** True only while this descriptor is still the effective runtime generation. */
  isCurrent: () => boolean
}

export interface EnvironmentControllerDeps {
  targets: Record<DgTargetMode, DgTargetDescriptor>
  selected: DgTargetDescriptor
  overrideActive?: boolean
  /** Atomic intent write. It must finish before old runtime teardown begins. */
  persist: (mode: DgTargetMode) => Promise<void> | void
  createRuntime: (descriptor: EnvironmentRuntimeDescriptor) => Promise<TargetRuntime> | TargetRuntime
  /** Existing boot runtime, if initial main composition already created one. */
  initialRuntime?: TargetRuntime | null
}

export type EnvironmentSwitchResult =
  | { ok: true; state: EnvironmentState }
  | { ok: false; code: EnvironmentErrorCode; state: EnvironmentState }

export interface EnvironmentController {
  getState: () => EnvironmentState
  onState: (listener: (state: EnvironmentState) => void) => () => void
  selectTarget: (mode: DgTargetMode) => Promise<EnvironmentSwitchResult>
  /** An explicit retry of the selected target. It never replays an operation. */
  retrySelectedTarget: () => Promise<EnvironmentSwitchResult>
  /** Main issues a lease before preview, armed confirmation, native, mapping or streaming work. */
  acquireLease: () => EnvironmentLease | null
  dispose: () => Promise<void>
}

const sameTarget = (left: DgTargetDescriptor, right: DgTargetDescriptor): boolean =>
  left.mode === right.mode && left.origin === right.origin && left.environmentId === right.environmentId && left.partition === right.partition

export function createEnvironmentController(deps: EnvironmentControllerDeps): EnvironmentController {
  let generation = 0
  let runtime = deps.initialRuntime ?? null
  let blockedRuntime: TargetRuntime | null = null
  let switching = false
  let nextLease = 0
  const leases = new Map<number, { environmentId: string; generation: number }>()
  const listeners = new Set<(state: EnvironmentState) => void>()
  let state: EnvironmentState = {
    selected: deps.selected,
    effectiveRuntime: runtime ? deps.selected : null,
    status: runtime ? 'ready' : 'idle',
    error: null,
    generation,
    override: deps.overrideActive === true
  }

  const publish = (): void => {
    const snapshot = { ...state }

    for (const listener of [...listeners]) {
      listener(snapshot)
    }
  }

  const setState = (next: Partial<EnvironmentState>): void => {
    state = { ...state, ...next }
    publish()
  }

  const result = (code: EnvironmentErrorCode): EnvironmentSwitchResult => ({ ok: false, code, state: { ...state } })

  const acquireLease = (): EnvironmentLease | null => {
    if (switching || state.status !== 'ready' || !state.effectiveRuntime) {
      return null
    }

    const id = ++nextLease
    const lease = { environmentId: state.effectiveRuntime.environmentId, generation: state.generation }
    leases.set(id, lease)
    let released = false

    return {
      id,
      ...lease,
      release: () => {
        if (!released) {
          released = true
          leases.delete(id)
        }
      }
    }
  }

  const descriptorFor = (target: DgTargetDescriptor, nextGeneration: number): EnvironmentRuntimeDescriptor => ({
    ...target,
    generation: nextGeneration,
    isCurrent: () => state.selected.environmentId === target.environmentId && state.generation === nextGeneration
  })

  const selectTarget = async (mode: DgTargetMode): Promise<EnvironmentSwitchResult> => {
    if (switching) {
      return result('SWITCH_IN_PROGRESS')
    }

    const target = deps.targets[mode]

    if (!target || !sameTarget(target, deps.targets[target.mode])) {
      return result('INVALID_TARGET')
    }

    if (state.override && target.environmentId !== state.selected.environmentId) {
      return result('OVERRIDE_ACTIVE')
    }

    if (leases.size > 0) {
      return result('BUSY')
    }

    // A failed teardown leaves the previous runtime action-blocked. The only recovery is an
    // explicit retry, which retries its strict close before a new runtime can authenticate.
    if (blockedRuntime) {
      switching = true
      setState({ status: 'switching', error: null, effectiveRuntime: null })
      try {
        await blockedRuntime.closeForEnvironmentSwitch()
        await blockedRuntime.dispose()
        blockedRuntime = null
      } catch {
        switching = false
        setState({ status: 'error', error: 'TEARDOWN_FAILED', effectiveRuntime: null })
        return result('TEARDOWN_FAILED')
      }
      switching = false
    }

    const oldRuntime = runtime
    const oldDescriptor = state.effectiveRuntime
    switching = true
    setState({ status: 'switching', error: null })

    // Freeze before persistence, closing the idle -> busy race. A persistence failure is the
    // only abort path that resumes the old runtime because its selected intent never changed.
    if (oldRuntime && oldDescriptor) {
      try {
        await oldRuntime.quiesce({ environmentId: oldDescriptor.environmentId, generation: state.generation })
      } catch {
        switching = false
        setState({ status: 'ready', error: 'QUIESCE_FAILED' })
        return result('QUIESCE_FAILED')
      }
    }

    try {
      await deps.persist(target.mode)
    } catch {
      if (oldRuntime && oldDescriptor) {
        try {
          await oldRuntime.resume({ environmentId: oldDescriptor.environmentId, generation: state.generation })
        } catch {
          // The old runtime cannot safely receive work if the backend could not resume.
          blockedRuntime = oldRuntime
          runtime = null
          switching = false
          setState({ status: 'error', error: 'TEARDOWN_FAILED', effectiveRuntime: null })
          return result('TEARDOWN_FAILED')
        }
      }
      switching = false
      setState({ status: oldRuntime ? 'ready' : 'idle', error: 'PERSIST_FAILED', effectiveRuntime: oldDescriptor ?? null })
      return result('PERSIST_FAILED')
    }

    // The durable selected target is now visible even if teardown/start fails. No fallback may
    // re-authenticate the previous origin after this point.
    generation += 1
    setState({ selected: target, effectiveRuntime: null, generation, status: 'switching', error: null })

    if (oldRuntime) {
      try {
        await oldRuntime.closeForEnvironmentSwitch()
        await oldRuntime.dispose()
      } catch {
        runtime = null
        blockedRuntime = oldRuntime
        switching = false
        setState({ status: 'error', error: 'TEARDOWN_FAILED', effectiveRuntime: null })
        return result('TEARDOWN_FAILED')
      }
    }

    runtime = null
    const descriptor = descriptorFor(target, generation)

    let nextRuntime: TargetRuntime | null = null
    try {
      nextRuntime = await deps.createRuntime(descriptor)

      // A factory must not start an obsolete descriptor. The controller currently rejects
      // concurrent selections, but this guard keeps delayed factory results fail-closed.
      if (!descriptor.isCurrent()) {
        await nextRuntime.closeForEnvironmentSwitch().catch(() => undefined)
        await Promise.resolve(nextRuntime.dispose()).catch(() => undefined)
        switching = false
        setState({ status: 'error', error: 'START_FAILED', effectiveRuntime: null })
        return result('START_FAILED')
      }

      runtime = nextRuntime
      await nextRuntime.start()
      if (!descriptor.isCurrent()) {
        await nextRuntime.closeForEnvironmentSwitch().catch(() => undefined)
        await Promise.resolve(nextRuntime.dispose()).catch(() => undefined)
        runtime = null
        switching = false
        setState({ status: 'error', error: 'START_FAILED', effectiveRuntime: null })
        return result('START_FAILED')
      }
    } catch {
      if (nextRuntime) {
        try {
          await nextRuntime.closeForEnvironmentSwitch()
          await nextRuntime.dispose()
        } catch {
          blockedRuntime = nextRuntime
        }
      }
      runtime = null
      switching = false
      setState({ status: 'error', error: blockedRuntime ? 'TEARDOWN_FAILED' : 'START_FAILED', effectiveRuntime: null })
      return result(blockedRuntime ? 'TEARDOWN_FAILED' : 'START_FAILED')
    }

    switching = false
    setState({ status: 'ready', error: null, effectiveRuntime: target })

    return { ok: true, state: { ...state } }
  }

  return {
    getState: () => ({ ...state }),
    onState: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    selectTarget,
    retrySelectedTarget: () => selectTarget(state.selected.mode),
    acquireLease,
    dispose: async (): Promise<void> => {
      switching = true
      leases.clear()
      const closing = runtime ?? blockedRuntime
      runtime = null
      blockedRuntime = null
      if (closing) {
        await closing.closeForEnvironmentSwitch()
        await closing.dispose()
      }
      switching = false
      setState({ effectiveRuntime: null, status: 'idle', error: null })
    }
  }
}
