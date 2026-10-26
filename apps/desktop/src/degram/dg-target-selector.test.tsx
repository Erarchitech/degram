import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'
import { stubMenuDomApis } from '@/test/jsdom'

import type { EnvironmentState } from '../../electron/degram/environment-controller'

import { DgTargetSelector } from './dg-target-selector'
import { install, makeState } from './test-harness'
import { $degram, resetDegramStore } from './use-degram-state'

const target = {
  mode: 'developer' as const,
  origin: 'http://localhost:8080',
  environmentId: 'a',
  partition: 'persist:a'
}

const ready: EnvironmentState = {
  selected: target,
  effectiveRuntime: target,
  generation: 1,
  status: 'ready',
  error: null,
  override: false
}

beforeEach(stubMenuDomApis)
afterEach(() => {
  cleanup()
  resetDegramStore()
  $degramEnabled.set(false)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

it.each(['signed-out', 'ready', 'switching', 'locked', 'failed'] as const)(
  'keeps mode and target visible: %s',
  async kind => {
    const h = install(makeState())
    await Promise.resolve()

    const environment: EnvironmentState = {
      ...ready,
      ...(kind === 'switching' ? { status: 'switching', effectiveRuntime: null } : {}),
      ...(kind === 'locked' ? { override: true } : {}),
      ...(kind === 'failed' ? { status: 'error', effectiveRuntime: null, error: 'START_FAILED' } : {})
    }

    const state = makeState()

    if (kind === 'signed-out') {
      state.auth = { ...state.auth, kind: 'signed-out', username: null, memberships: [] }
    }

    $degram.set({ ...$degram.get(), state, environment })
    render(<DgTargetSelector />)
    const control = screen.getByRole('combobox', { name: 'DG environment' })
    expect(control.textContent).toContain('Developer Mode')
    expect(screen.getByText('Selected: http://localhost:8080')).toBeTruthy()
    expect((control as HTMLButtonElement).disabled).toBe(kind === 'locked' || kind === 'switching')

    if (kind === 'failed') {
      expect(screen.getByRole('button', { name: 'Retry target' })).toBeTruthy()
    }

    h.stop()
  }
)

it('uses keyboard selection with expected main generation and reports busy without changing mode', async () => {
  const h = install(makeState())
  await Promise.resolve()
  $degram.set({ ...$degram.get(), environment: ready })
  vi.mocked(h.bridge.selectTarget).mockResolvedValue({ ok: false, code: 'BUSY', state: ready })
  render(<DgTargetSelector />)
  const control = screen.getByRole('combobox', { name: 'DG environment' })
  control.focus()
  fireEvent.keyDown(control, { key: 'ArrowDown' })
  await screen.findByRole('option', { name: 'Demo Mode' })
  fireEvent.click(screen.getByRole('option', { name: 'Demo Mode' }))
  await waitFor(() =>
    expect(h.bridge.selectTarget).toHaveBeenCalledWith({ mode: 'demo', environmentId: 'a', generation: 1 })
  )
  expect(await screen.findByText('Finish or Stop the current operation, then retry')).toBeTruthy()
  expect(control.textContent).toContain('Developer Mode')
  await waitFor(() => expect(window.document.activeElement).toBe(control))
  h.stop()
})

it('restores switch focus after the gate hands back to the working header', async () => {
  const h = install(makeState())
  await Promise.resolve()

  const state = makeState({
    scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'default', epoch: 1, error: null }
  })

  $degram.set({ ...$degram.get(), state, environment: ready })
  let finish!: (value: any) => void
  vi.mocked(h.bridge.selectTarget).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<DgTargetSelector key="working-a" working />)
  const control = screen.getByRole('combobox', { name: 'DG environment' })
  fireEvent.keyDown(control, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Demo Mode' }))

  const demo = {
    ...target,
    mode: 'demo' as const,
    environmentId: 'b',
    origin: 'https://demo.example',
    partition: 'persist:b'
  }

  const next = { ...ready, selected: demo, effectiveRuntime: demo, generation: 2 }
  act(() => {
    $degram.set({ ...$degram.get(), environment: { ...next, status: 'switching', effectiveRuntime: null } })
  })
  view.rerender(<DgTargetSelector key="gate" />)
  act(() => {
    $degram.set({ ...$degram.get(), environment: next })
    finish({ ok: true, state: next })
  })
  view.rerender(<DgTargetSelector key="working-b" working />)
  await waitFor(() =>
    expect(window.document.activeElement).toBe(screen.getByRole('combobox', { name: 'DG environment' }))
  )
  h.stop()
})

it('does not present a mismatched selected/effective descriptor as a working runtime', async () => {
  const h = install(makeState())
  await Promise.resolve()

  const state = makeState({
    scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'default', epoch: 1, error: null }
  })

  $degram.set({
    ...$degram.get(),
    state,
    environment: { ...ready, effectiveRuntime: { ...target, environmentId: 'other', origin: 'https://other.example' } }
  })
  const { rerender } = render(<DgTargetSelector working />)
  expect(screen.queryByRole('combobox')).toBeNull()
  rerender(<DgTargetSelector />)
  expect(screen.getByText('Effective origin: https://other.example')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Target switch failed')
  h.stop()
})

it('renders no target selector in the stock variant', () => {
  render(<DgTargetSelector />)
  expect(screen.queryByRole('combobox')).toBeNull()
})
