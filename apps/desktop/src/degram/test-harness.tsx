// test-harness.tsx — a mocked DeGram bridge shared by the degram jsdom suites (Phase 1301-13).
// Not a test file: the vitest `ui` project only collects `*.test.{ts,tsx}`.

import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'

import type { DegramBridge, DegramState } from '../../electron/degram/ipc'
import type { DegramEvent } from '../../electron/degram/scope'

import { type DegramActions, DegramActionsContext, startDegramSync } from './use-degram-state'

export const noScope = {
  status: 'no-project',
  project: null,
  company: null,
  profile: null,
  epoch: 0,
  error: null
} as const

export function makeState(
  over: Partial<DegramState> & { memberships?: DegramState['auth']['memberships'] } = {}
): DegramState {
  return {
    auth: {
      kind: 'signed-in',
      username: 'ann',
      isAdmin: false,
      memberships: over.memberships ?? [
        { project: 'Alpha', role: 'member', company: 'Acme' },
        { project: 'Beta', role: 'member', company: null }
      ]
    },
    scope: over.scope ?? { ...noScope },
    dg: over.dg ?? { mode: 'graph', page: 'dg', reachable: true }
  }
}

export interface Harness {
  bridge: DegramBridge
  emitState: (state: DegramState) => void
  emitEvent: (event: DegramEvent) => void
  /** The tray's sign-out entry was clicked (main to renderer). */
  emitRequestSignOut: () => void
  stop: () => void
}

export function install(initial: DegramState): Harness {
  let stateListener: ((state: DegramState) => void) | null = null
  let eventListener: ((event: DegramEvent) => void) | null = null
  let signOutListener: (() => void) | null = null

  const bridge: DegramBridge = {
    getEnvironment: vi.fn(async () => { throw new Error('environment fixture not configured') }),
    onEnvironment: vi.fn(() => () => undefined),
    selectTarget: vi.fn(async () => { throw new Error('environment fixture not configured') }),
    retryTarget: vi.fn(async () => { throw new Error('environment fixture not configured') }),
    acquireOperation: vi.fn(async () => { throw new Error('environment fixture not configured') }),
    releaseOperation: vi.fn(async () => undefined),
    getState: vi.fn(async () => initial),
    onState: vi.fn(cb => {
      stateListener = cb

      return () => {
        stateListener = null
      }
    }),
    onEvent: vi.fn(cb => {
      eventListener = cb

      return () => {
        eventListener = null
      }
    }),
    selectProject: vi.fn(async () => ({ ok: true, state: initial.scope }) as never),
    signOut: vi.fn(async () => undefined),
    setDgMode: vi.fn(async () => undefined),
    reloadDg: vi.fn(async () => undefined),
    retryDg: vi.fn(async () => undefined),
    setDgBounds: vi.fn(async () => undefined),
    setTrayLabels: vi.fn(async () => undefined),
    dgGo: vi.fn(async () => undefined),
    setLocale: vi.fn(async () => undefined),
    onRequestSignOut: vi.fn(cb => {
      signOutListener = cb

      return () => {
        signOutListener = null
      }
    }),
    reportOutcome: vi.fn(async () => true),
    openExternalConfirmed: vi.fn(async () => true)
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { degram: bridge, degramEnabled: true }
  $degramEnabled.set(true)
  const stop = startDegramSync(bridge)

  return {
    bridge,
    emitState: s => act(() => stateListener?.(s)),
    emitEvent: e => act(() => eventListener?.(e)),
    emitRequestSignOut: () => act(() => signOutListener?.()),
    stop
  }
}

export const withActions = (
  ui: ReactNode,
  actions: Omit<DegramActions, 'showRing'> &
    Partial<Pick<DegramActions, 'showRing'>> = { stopResponse: vi.fn(async () => undefined), startNewChat: vi.fn() }
) => <DegramActionsContext.Provider value={{ showRing: vi.fn(), ...actions }}>{ui}</DegramActionsContext.Provider>
