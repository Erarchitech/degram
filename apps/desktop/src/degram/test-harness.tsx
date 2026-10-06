// test-harness.tsx — a mocked DeGram bridge shared by the degram jsdom suites (Phase 1301-13).
// Not a test file: the vitest `ui` project only collects `*.test.{ts,tsx}`.

import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'

import type { DegramBridge, DegramState } from '../../electron/degram/ipc'
import type { DegramEvent } from '../../electron/degram/scope'

import { DegramActionsContext, startDegramSync } from './use-degram-state'

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
    dg: over.dg ?? { mode: 'graph', page: 'dg', reachable: true },
    pairing: over.pairing ?? { status: 'none', company: null, available: true }
  }
}

export interface Harness {
  bridge: DegramBridge
  emitState: (state: DegramState) => void
  emitEvent: (event: DegramEvent) => void
  stop: () => void
}

export function install(initial: DegramState): Harness {
  let stateListener: ((state: DegramState) => void) | null = null
  let eventListener: ((event: DegramEvent) => void) | null = null

  const bridge: DegramBridge = {
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
    setDgBounds: vi.fn(async () => undefined),
    reportOutcome: vi.fn(async () => true),
    openExternalConfirmed: vi.fn(async () => true),
    setPairing: vi.fn(async () => ({ ok: true }) as never),
    clearPairing: vi.fn(async () => undefined)
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { degram: bridge, degramEnabled: true }
  $degramEnabled.set(true)
  const stop = startDegramSync(bridge)

  return {
    bridge,
    emitState: s => act(() => stateListener?.(s)),
    emitEvent: e => act(() => eventListener?.(e)),
    stop
  }
}

export const withActions = (
  ui: ReactNode,
  actions = { stopResponse: vi.fn(async () => undefined), startNewChat: vi.fn() }
) => <DegramActionsContext.Provider value={actions}>{ui}</DegramActionsContext.Provider>
