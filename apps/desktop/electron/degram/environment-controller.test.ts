import { describe, expect, it, vi } from 'vitest'

import { descriptorForDgTarget } from './dg-target-config'
import { createEnvironmentController, type EnvironmentControllerDeps, type TargetRuntime } from './environment-controller'

const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
const demo = descriptorForDgTarget('demo', 'https://dg.example.test')

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

function controller(options: {
  initialRuntime?: TargetRuntime | null
  persist?: (mode: 'developer' | 'demo') => Promise<void> | void
  createRuntime?: (descriptor: Parameters<EnvironmentControllerDeps['createRuntime']>[0]) => TargetRuntime | Promise<TargetRuntime>
} = {}) {
  const initialRuntime = options.initialRuntime ?? runtime()
  const created = options.createRuntime ? undefined : runtime()
  const persist = options.persist ?? vi.fn(async () => undefined)
  const createRuntime = options.createRuntime ?? vi.fn(() => created!)
  const subject = createEnvironmentController({
    targets: { developer, demo },
    selected: developer,
    initialRuntime,
    persist,
    createRuntime
  })

  return { subject, initialRuntime, created, persist, createRuntime }
}

describe('createEnvironmentController', () => {
  it('refuses a switch while a target-bound operation lease is held', async () => {
    const r = controller()
    const lease = r.subject.acquireLease()

    expect(lease).not.toBeNull()
    expect(await r.subject.selectTarget('demo')).toMatchObject({ ok: false, code: 'BUSY' })
    expect(r.persist).not.toHaveBeenCalled()
    expect(r.initialRuntime.quiesce).not.toHaveBeenCalled()

    lease!.release()
    await expect(r.subject.selectTarget('demo')).resolves.toMatchObject({ ok: true })
  })

  it('freezes the old backend before persistence and resumes it when the write fails', async () => {
    const persist = vi.fn(async () => {
      throw new Error('disk full')
    })
    const r = controller({ persist })

    await expect(r.subject.selectTarget('demo')).resolves.toMatchObject({ ok: false, code: 'PERSIST_FAILED' })

    expect(r.initialRuntime.quiesce).toHaveBeenCalledTimes(1)
    expect(r.initialRuntime.resume).toHaveBeenCalledTimes(1)
    expect(r.initialRuntime.closeForEnvironmentSwitch).not.toHaveBeenCalled()
    expect(r.subject.getState()).toMatchObject({ selected: developer, effectiveRuntime: developer, status: 'ready' })
  })

  it('persists intent before strict teardown and starts only the selected descriptor afterwards', async () => {
    const order: string[] = []
    const old = runtime({
      quiesce: async () => { order.push('quiesce') },
      closeForEnvironmentSwitch: async () => { order.push('close') },
      dispose: async () => { order.push('dispose') }
    })
    const next = runtime({ start: async () => { order.push('start') } })
    const r = controller({
      initialRuntime: old,
      persist: async () => { order.push('persist') },
      createRuntime: descriptor => {
        expect(descriptor).toMatchObject({ ...demo, generation: 1 })
        expect(descriptor.isCurrent()).toBe(true)
        order.push('create')
        return next
      }
    })

    await expect(r.subject.selectTarget('demo')).resolves.toMatchObject({ ok: true })

    expect(order).toEqual(['quiesce', 'persist', 'close', 'dispose', 'create', 'start'])
    expect(r.subject.getState()).toMatchObject({ selected: demo, effectiveRuntime: demo, status: 'ready', generation: 1 })
  })

  it('retains the selected target and blocks actions after strict credential/backend release fails', async () => {
    const old = runtime({ closeForEnvironmentSwitch: async () => { throw new Error('backend still running') } })
    const r = controller({ initialRuntime: old })

    await expect(r.subject.selectTarget('demo')).resolves.toMatchObject({ ok: false, code: 'TEARDOWN_FAILED' })

    expect(r.subject.getState()).toMatchObject({
      selected: demo,
      effectiveRuntime: null,
      status: 'error',
      error: 'TEARDOWN_FAILED',
      generation: 1
    })
    expect(r.subject.acquireLease()).toBeNull()
    expect(r.createRuntime).not.toHaveBeenCalled()
  })

  it('requires an explicit retry to recover a failed teardown and never replays an operation', async () => {
    let attempts = 0
    const old = runtime({ closeForEnvironmentSwitch: vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('release failed')
    }) })
    const r = controller({ initialRuntime: old })

    await r.subject.selectTarget('demo')
    await expect(r.subject.retrySelectedTarget()).resolves.toMatchObject({ ok: true })

    expect(old.closeForEnvironmentSwitch).toHaveBeenCalledTimes(2)
    expect(r.created!.start).toHaveBeenCalledTimes(1)
    expect(r.subject.getState()).toMatchObject({ selected: demo, effectiveRuntime: demo, generation: 2 })
  })

  it('reports and blocks a failed partial-start cleanup until explicit teardown retry', async () => {
    let closeAttempts = 0
    const partial = runtime({
      start: async () => { throw new Error('TLS unavailable') },
      closeForEnvironmentSwitch: async () => {
        closeAttempts += 1
        if (closeAttempts === 1) throw new Error('release unknown')
      }
    })
    const recovered = runtime()
    let factories = 0
    const r = controller({ createRuntime: () => ++factories === 1 ? partial : recovered })
    await expect(r.subject.selectTarget('demo')).resolves.toMatchObject({ ok: false, code: 'TEARDOWN_FAILED' })
    expect(r.subject.acquireLease()).toBeNull()
    expect(r.subject.getState()).toMatchObject({ selected: demo, effectiveRuntime: null, error: 'TEARDOWN_FAILED' })
    await expect(r.subject.retrySelectedTarget()).resolves.toMatchObject({ ok: true })
    expect(closeAttempts).toBe(2)
    expect(recovered.start).toHaveBeenCalledTimes(1)
  })

  it('serializes a concurrent selection instead of creating another target runtime', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const next = runtime({ start: async () => startGate })
    const createRuntime = vi.fn(() => next)
    const r = controller({ createRuntime })

    const first = r.subject.selectTarget('demo')
    await Promise.resolve()
    await expect(r.subject.selectTarget('developer')).resolves.toMatchObject({ ok: false, code: 'SWITCH_IN_PROGRESS' })
    releaseStart()
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(createRuntime).toHaveBeenCalledTimes(1)
  })
})
