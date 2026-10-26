import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'

import type { EnvironmentState } from '../../electron/degram/environment-controller'
import type { DegramBridge, DegramState } from '../../electron/degram/ipc'
import type { DegramEvent } from '../../electron/degram/scope'

import { degramPromptSubmit } from './composer-seam'
import { $documents, refreshDocuments, resetDocuments, scopeKeyOf, syncDocumentsScope } from './documents-store'
import {
  $lifecycle,
  composerGate,
  handleTurnEvent,
  refreshPreview,
  resetLifecycle,
  resolveConsent,
  stopRequest,
  syncLifecycleScope
} from './request-lifecycle'
import { degramScopeTag } from './scope-route'
import { listScopeSessions } from './session-list'
import { install, makeState } from './test-harness'
import { request, setDegramGatewayForTests } from './use-degram-gateway'
import { $degram, resetDegramStore, startDegramSync } from './use-degram-state'
import { useMappingSession } from './use-mapping-session'

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function environment(id: string, generation: number): EnvironmentState {
  const target = {
    mode: id === 'a' ? ('developer' as const) : ('demo' as const),
    origin: id === 'a' ? 'http://localhost:8080' : 'https://stand.example',
    environmentId: id,
    partition: `persist:${id}`
  }

  return { selected: target, effectiveRuntime: target, status: 'ready', error: null, generation, override: false }
}

function runtime(id: string, generation: number): DegramState {
  return {
    ...makeState(),
    environment: { environmentId: id, generation },
    scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'default', epoch: 1, error: null }
  }
}

const stops: Array<() => void> = []

function mirror(id = 'a', generation = 1) {
  const h = install(makeState())
  h.stop()
  let stateListener!: (state: DegramState) => void
  let environmentListener!: (state: EnvironmentState) => void
  let eventListener!: (event: DegramEvent) => void
  let lease = 0
  const initial = deferred<DegramState>()
  const envRead = deferred<EnvironmentState>()
  h.bridge.getState = vi.fn(() => initial.promise)
  h.bridge.getEnvironment = vi.fn(() => envRead.promise)

  h.bridge.onState = cb => {
    stateListener = cb

    return () => undefined
  }

  h.bridge.onEnvironment = cb => {
    environmentListener = cb

    return () => undefined
  }

  h.bridge.onEvent = cb => {
    eventListener = cb

    return () => undefined
  }

  h.bridge.acquireOperation = vi.fn(async stamp => ({ ...stamp, id: ++lease }))
  stops.push(startDegramSync(h.bridge))
  const emitEnvironment = (env: EnvironmentState) => act(() => environmentListener(env))
  const emitState = (state: DegramState) => act(() => stateListener(state))
  emitEnvironment(environment(id, generation))
  emitState(runtime(id, generation))

  return {
    bridge: h.bridge,
    initial,
    envRead,
    emitEnvironment,
    emitState,
    emitEvent: (event: DegramEvent) => act(() => eventListener(event))
  }
}

afterEach(() => {
  cleanup()
  stops.splice(0).forEach(stop => stop())
  resetLifecycle()
  resetDocuments()
  resetDegramStore()
  setDegramGatewayForTests(null)
  $degramEnabled.set(false)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  vi.useRealTimers()
})

it('rejects late initial reads, old events and equal-epoch state after A → B → A', async () => {
  const h = mirror()
  const firstKey = scopeKeyOf($degram.get())
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  expect(scopeKeyOf($degram.get())).not.toBe(firstKey)
  h.emitEnvironment(environment('a', 3))
  h.emitState(runtime('a', 3))
  const lastKey = scopeKeyOf($degram.get())
  expect(lastKey).not.toBe(firstKey)
  h.emitState(runtime('a', 1))
  h.emitEvent({ type: 'session-ended', environment: { environmentId: 'a', generation: 1 } })
  h.initial.resolve(runtime('a', 1))
  h.envRead.resolve(environment('a', 1))
  await Promise.resolve()
  expect($degram.get().state?.environment).toEqual({ environmentId: 'a', generation: 3 })
  expect($degram.get().sessionEnded).toBe(false)
  expect(scopeKeyOf($degram.get())).toBe(lastKey)
  // Durable sidebar history belongs to the environment/user/project, not its runtime generation.
  expect(degramScopeTag(runtime('a', 1))).toBe(degramScopeTag(runtime('a', 3)))
  expect(degramScopeTag(runtime('a', 1))).not.toBe(degramScopeTag(runtime('b', 2)))
})

it('buffers startup state before its environment publication and clears transient stores', () => {
  const h = mirror()
  $documents.set({ ...$documents.get(), scopeKey: 'old' })
  $lifecycle.set({ ...$lifecycle.get(), lastText: 'old draft' })
  h.emitState(runtime('b', 2))
  expect($degram.get().state?.environment?.environmentId).toBe('a')
  h.emitEnvironment({ ...environment('b', 2), status: 'switching', effectiveRuntime: null })
  expect($degram.get().state).toBeNull()
  expect($documents.get().scopeKey).not.toBe('old')
  expect($lifecycle.get().lastText).toBeNull()
  h.emitEnvironment(environment('b', 2))
  expect($degram.get().state?.environment).toEqual({ environmentId: 'b', generation: 2 })
})

it('does not publish session history from a departed generation with the same route', async () => {
  const h = mirror()
  const reply = deferred<unknown>()
  const requester = { request: vi.fn(() => reply.promise) as never }
  const pending = listScopeSessions(20, runtime('a', 1), { get: () => 'default' }, requester)
  h.emitEnvironment(environment('a', 3))
  h.emitState(runtime('a', 3))
  reply.resolve({ sessions: [{ id: 'old', title: 'old environment' }] })
  expect(await pending).toEqual({ failed: true, sessions: [] })
})

it('holds a gateway lease until settlement and rejects an obsolete result without retry', async () => {
  const h = mirror()
  const reply = deferred<string>()
  const transport = vi.fn(() => reply.promise)
  setDegramGatewayForTests(transport as never)
  const pending = request('degram.mapping.session')
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
  expect(h.bridge.releaseOperation).not.toHaveBeenCalled()
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  reply.resolve('old')
  await expect(pending).rejects.toThrow('obsolete environment')
  expect(h.bridge.releaseOperation).toHaveBeenCalledWith({ environmentId: 'a', generation: 1, id: 1 })
  expect(transport).toHaveBeenCalledTimes(1)
})

it('fails closed on invalid configuration and releases a late acquired lease', async () => {
  const h = mirror()
  const lease = deferred<Awaited<ReturnType<DegramBridge['acquireOperation']>>>()
  vi.mocked(h.bridge.acquireOperation).mockReturnValueOnce(lease.promise)
  const transport = vi.fn(async () => 'unused')
  setDegramGatewayForTests(transport as never)
  const pending = request('degram.mapping.session')
  h.emitEnvironment(environment('b', 2))
  lease.resolve({ environmentId: 'a', generation: 1, id: 99 })
  await expect(pending).rejects.toThrow()
  expect(h.bridge.releaseOperation).toHaveBeenCalledWith({ environmentId: 'a', generation: 1, id: 99 })
  $degram.set({
    ...$degram.get(),
    environment: {
      selected: null,
      effectiveRuntime: null,
      status: 'error',
      error: 'CONFIG_INVALID',
      generation: 0,
      override: false
    }
  })
  await expect(request('degram.mapping.session')).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
})

it('cannot send an arming to another target and expires an abandoned arming', async () => {
  const h = mirror()
  expect(await composerGate({ text: 'hello' })).toEqual({ text: 'hello' })
  expect(h.bridge.releaseOperation).not.toHaveBeenCalled()
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  const rpc = vi.fn(async () => ({}))
  await expect(degramPromptSubmit(rpc as never, { session_id: 'same', text: 'hello' })).rejects.toThrow(
    'ROUTE_MISMATCH'
  )
  expect(rpc).not.toHaveBeenCalled()
  vi.useFakeTimers()
  await composerGate({ text: 'new' })
  const before = vi.mocked(h.bridge.releaseOperation).mock.calls.length
  await vi.advanceTimersByTimeAsync(30_001)
  expect(vi.mocked(h.bridge.releaseOperation).mock.calls.length).toBe(before + 1)
})

it('invalidates whole-definition consent without sending it to the replacement target', async () => {
  const h = mirror()
  syncDocumentsScope()
  syncLifecycleScope()
  $documents.set({
    ...$documents.get(),
    pinned: { grasshopper: { app: 'grasshopper', name: 'same', path: null, unsaved: true, identity: {} } }
  })
  $lifecycle.set({ ...$lifecycle.get(), phase: 'ready', preview: { previewId: 'old', requiresConsent: true } as never })
  const pending = composerGate({ text: 'whole definition' })
  await waitFor(() => expect($lifecycle.get().confirmOpen).toBe(true))
  expect(h.bridge.releaseOperation).not.toHaveBeenCalled()
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  resolveConsent(true)
  expect(await pending).toBeNull()
  expect($lifecycle.get().confirmOpen).toBe(false)
  expect(h.bridge.releaseOperation).toHaveBeenCalledWith({ environmentId: 'a', generation: 1, id: 1 })
})

it('retains the streaming lease through both Stop RPC settlements', async () => {
  const h = mirror()
  const cancel = deferred<unknown>()
  const interrupt = deferred<unknown>()
  setDegramGatewayForTests(vi.fn(() => cancel.promise) as never)
  await composerGate({ text: 'hello' })
  await degramPromptSubmit((async () => ({})) as never, { session_id: 'same', text: 'hello' })
  const stopped = stopRequest({ interrupt: () => interrupt.promise })
  expect($lifecycle.get().phase).toBe('interrupted')
  await Promise.resolve()
  cancel.resolve({ status: 'ok' })
  await Promise.resolve()
  expect(vi.mocked(h.bridge.releaseOperation).mock.calls.some(([lease]) => lease.id === 1)).toBe(false)
  interrupt.resolve(undefined)
  await stopped
  expect(vi.mocked(h.bridge.releaseOperation).mock.calls.filter(([lease]) => lease.id === 1)).toHaveLength(1)
  const phase = $lifecycle.get().phase
  handleTurnEvent({ type: 'message.complete', session_id: 'same' })
  expect($lifecycle.get().phase).toBe(phase)
})

it('discards preview completion and bridge side effects after A → B → A', async () => {
  const h = mirror()
  syncDocumentsScope()
  $documents.set({
    ...$documents.get(),
    pinned: { grasshopper: { app: 'grasshopper', name: 'same', path: null, unsaved: true, identity: {} } }
  })
  const reply = deferred<unknown>()
  const transport = vi.fn(() => reply.promise)
  setDegramGatewayForTests(transport as never)
  const pending = refreshPreview()
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  h.emitEnvironment(environment('a', 3))
  h.emitState(runtime('a', 3))
  reply.resolve({
    status: 'ok',
    preview: { previewId: 'old', payload: 'old', summary: { excluded: [], documents: [] } }
  })
  await pending
  expect($lifecycle.get().preview).toBeNull()
  expect($lifecycle.get().previewError).toBeNull()
  expect($documents.get().pinned).toEqual({})
})

it('does not restore an old document list after A → B → A with identical scope IDs', async () => {
  const h = mirror()
  const reply = deferred<unknown>()
  const transport = vi.fn(() => reply.promise)
  setDegramGatewayForTests(transport as never)
  const pending = refreshDocuments('revit')
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  h.emitEnvironment(environment('a', 3))
  h.emitState(runtime('a', 3))
  syncDocumentsScope()
  reply.resolve({
    status: 'ok',
    groups: [{ app: 'revit', state: 'ready', documents: [{ name: 'old', pinned: true }] }],
    pinned: {}
  })
  await pending
  expect($documents.get().apps.revit.group).toBeNull()
  expect($documents.get().pinned).toEqual({})
  expect(transport).toHaveBeenCalledTimes(1)
})

it('drops a late mapping read and local adoption for identical IDs after target change', async () => {
  const h = mirror()
  const reply = deferred<unknown>()
  setDegramGatewayForTests(vi.fn(() => reply.promise) as never)

  const { result, rerender } = renderHook(({ scope }) => useMappingSession('revit', 'same-doc', true, scope), {
    initialProps: { scope: scopeKeyOf($degram.get()) }
  })

  const oldAdopt = result.current.adopt
  h.emitEnvironment(environment('b', 2))
  h.emitState(runtime('b', 2))
  rerender({ scope: scopeKeyOf($degram.get()) })
  act(() => oldAdopt({ sessionId: 'old' } as never))
  reply.resolve({ status: 'ok', sessions: [] })
  await waitFor(() => expect(result.current.state.loading).toBe(false))
  expect(result.current.state.session).toBeNull()
})
