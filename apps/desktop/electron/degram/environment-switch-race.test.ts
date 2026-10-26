// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { descriptorForDgTarget } from './dg-target-config'
import { createEnvironmentController, type TargetRuntime } from './environment-controller'

const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
const demo = descriptorForDgTarget('demo', 'https://dg.example.test')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function runtime(overrides: Partial<TargetRuntime> = {}): TargetRuntime {
  return {
    quiesce: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    closeForEnvironmentSwitch: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('DGMODE switch races', () => {
  it('refuses a second switch while target persistence/start is unsettled and never falls back to localhost', async () => {
    const persisted = deferred<void>()
    const old = runtime()
    const remote = runtime()
    const controller = createEnvironmentController({
      targets: { developer, demo }, selected: developer, initialRuntime: old,
      persist: async mode => {
        expect(mode).toBe('demo')
        await persisted.promise
      },
      createRuntime: descriptor => {
        expect(descriptor).toMatchObject({ ...demo, generation: 1 })
        return remote
      }
    })

    const first = controller.selectTarget('demo')
    await Promise.resolve()
    await expect(controller.selectTarget('developer')).resolves.toMatchObject({ ok: false, code: 'SWITCH_IN_PROGRESS' })
    expect(controller.acquireLease()).toBeNull()
    persisted.resolve()
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(controller.getState()).toMatchObject({ selected: demo, effectiveRuntime: demo, status: 'ready' })
    expect(old.closeForEnvironmentSwitch).toHaveBeenCalledOnce()
    expect(remote.start).toHaveBeenCalledOnce()
  })

  it('keeps a persisted Demo selection after a TLS-shaped start failure and requires explicit retry', async () => {
    const tlsFailure = runtime({ start: async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID') } })
    const recovered = runtime()
    let creates = 0
    const controller = createEnvironmentController({
      targets: { developer, demo }, selected: developer, initialRuntime: runtime(), persist: async () => undefined,
      createRuntime: () => ++creates === 1 ? tlsFailure : recovered
    })

    await expect(controller.selectTarget('demo')).resolves.toMatchObject({ ok: false, code: 'START_FAILED' })
    expect(controller.getState()).toMatchObject({ selected: demo, effectiveRuntime: null, status: 'error', error: 'START_FAILED' })
    expect(controller.acquireLease()).toBeNull()
    expect(tlsFailure.closeForEnvironmentSwitch).toHaveBeenCalledOnce()
    await expect(controller.retrySelectedTarget()).resolves.toMatchObject({ ok: true })
    expect(controller.getState()).toMatchObject({ selected: demo, effectiveRuntime: demo, status: 'ready' })
    expect(recovered.start).toHaveBeenCalledOnce()
  })
})
