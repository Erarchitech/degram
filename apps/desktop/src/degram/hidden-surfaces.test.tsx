import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'

import { FallbackModelsField } from '../app/settings/fallback-models-field'
import { ModelCatalogMenu } from '../app/shell/model-catalog-menu'

import { DegramGate } from './degram-gate'
import { DgPage } from './dg-page'
import { HIDDEN_SETTINGS_VIEWS, HIDDEN_SURFACES, isSettingsViewHidden, isSurfaceHidden } from './hidden-surfaces'
import { ScopeStrip } from './scope-strip'
import { install, makeState, withActions } from './test-harness'
import { resetDegramStore } from './use-degram-state'

afterEach(() => {
  cleanup()
  resetDegramStore()
  $degramEnabled.set(false)
})

const REQUIRED = [
  'model-picker',
  'model-picker-overlay',
  'model-visibility',
  'model-pill',
  'model-catalog-menu',
  'providers-settings',
  'keys-settings',
  'custom-endpoints-settings',
  'fallback-models',
  'onboarding-provider-steps',
  'billing-banner',
  'free-tier',
  'updates-overlay',
  'update-status',
  'remote-setup'
] as const

describe('HIDDEN_SURFACES gate (DGCL-02)', () => {
  it('lists every surface the plan names', () => {
    for (const id of REQUIRED) {
      expect(HIDDEN_SURFACES).toContain(id)
    }
  })

  it('lists the failed-turn card actions (1301-19, G-4)', () => {
    for (const id of [
      'stock-error-update-key',
      'stock-error-switch-provider',
      'stock-error-sign-in',
      'stock-error-open-logs',
      'stock-error-send-diagnostics',
      'stock-error-copy-details'
    ] as const) {
      expect(HIDDEN_SURFACES).toContain(id)
    }
  })

  it('hides every listed surface in variant degram and none elsewhere', () => {
    $degramEnabled.set(false)
    expect(HIDDEN_SURFACES.filter(id => isSurfaceHidden(id))).toEqual([])

    $degramEnabled.set(true)
    expect(HIDDEN_SURFACES.filter(id => !isSurfaceHidden(id))).toEqual([])
  })

  it('hides the settings pages that carry model, provider, key, billing and gateway entries only in degram', () => {
    const views = Object.keys(HIDDEN_SETTINGS_VIEWS)

    $degramEnabled.set(false)
    expect(views.filter(view => isSettingsViewHidden(view))).toEqual([])
    $degramEnabled.set(true)
    expect(views.filter(view => !isSettingsViewHidden(view))).toEqual([])

    // The pages that stay: general chat/appearance/safety settings.
    expect(isSettingsViewHidden('config:chat')).toBe(false)
    expect(isSettingsViewHidden('config:appearance')).toBe(false)
    expect(isSettingsViewHidden('about')).toBe(false)
    expect(Object.values(HIDDEN_SETTINGS_VIEWS)).toEqual(
      expect.arrayContaining(['model-settings', 'providers-settings', 'keys-settings', 'billing-settings'])
    )
  })
})

describe('entry points render nothing in variant degram (T-1301-13-02)', () => {
  it('ModelCatalogMenu renders nothing', () => {
    $degramEnabled.set(true)
    const { container } = render(<ModelCatalogMenu {...({} as ComponentProps<typeof ModelCatalogMenu>)} />)

    expect(container.innerHTML).toBe('')
  })

  it('FallbackModelsField renders nothing', () => {
    $degramEnabled.set(true)
    const { container } = render(<FallbackModelsField onChange={() => undefined} value={[]} />)

    expect(container.innerHTML).toBe('')
  })
})

// Mount sites inside the upstream shell cannot be rendered offline, so each is pinned at the source: every surface id
// must be consulted where its entry point is rendered. A removed gate fails here.
describe('upstream entry points consult the gate', () => {
  const root = resolve(__dirname, '..')
  const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

  const SITES: Array<[string, string[]]> = [
    // `model-picker` has no mount of its own: it is only rendered by the overlay, the pill and the catalog menu.
    ['model-picker', ['app/contrib/wiring.tsx']],
    ['model-picker-overlay', ['app/contrib/wiring.tsx']],
    ['model-visibility', ['app/contrib/wiring.tsx']],
    ['updates-overlay', ['app/contrib/wiring.tsx']],
    ['onboarding-provider-steps', ['app/contrib/wiring.tsx']],
    [
      'free-tier',
      ['app/contrib/wiring.tsx', 'app/chat/composer/status-stack/index.tsx', 'app/shell/hooks/use-statusbar-items.tsx']
    ],
    ['billing-banner', ['app/chat/composer/status-stack/index.tsx']],
    ['model-pill', ['app/chat/composer/controls.tsx']],
    ['model-catalog-menu', ['app/shell/model-catalog-menu.tsx']],
    ['fallback-models', ['app/settings/fallback-models-field.tsx']],
    ['update-status', ['app/shell/hooks/use-statusbar-items.tsx']],
    ['remote-setup', ['app/shell/hooks/use-statusbar-items.tsx', 'app/chat/sidebar/local-device-switch.tsx']],
    ['stock-error-retry', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-update-key', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-switch-provider', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-sign-in', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-open-logs', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-send-diagnostics', ['components/assistant-ui/thread/assistant-message.tsx']],
    ['stock-error-copy-details', ['components/assistant-ui/thread/assistant-message.tsx']]
  ]

  it.each(SITES)('%s', (id, files) => {
    const gateId = id === 'model-picker' ? 'model-picker-overlay' : id

    for (const file of files) {
      expect(read(file), `${file} must consult isSurfaceHidden('${gateId}')`).toContain(`isSurfaceHidden('${gateId}')`)
    }
  })

  it('the settings page drops hidden views from its route enum and nav', () => {
    const settings = read('app/settings/index.tsx')

    expect(settings).toContain('isSettingsViewHidden')
    expect(settings).toContain('VISIBLE_SETTINGS_VIEWS')
    expect(settings).toContain("isSurfaceHidden('billing-settings')")
  })
})

describe('rendered DeGram surfaces never name the served model (T-1301-13-01)', () => {
  const ready = makeState({
    scope: { status: 'ready', project: 'Alpha', company: 'Acme', profile: 'p', epoch: 1, error: null }
  })

  const signedOut = {
    ...makeState(),
    auth: { kind: 'signed-out' as const, username: null, isAdmin: false, memberships: [] }
  }

  it.each([
    ['gate (project choice)', () => <DegramGate />, makeState()],
    ['gate (signed out)', () => <DegramGate />, signedOut],
    ['scope strip', () => <ScopeStrip />, ready],
    ['DG page', () => <DgPage />, ready]
  ])('%s', (_name, ui, state) => {
    const h = install(state)

    h.emitState(state)
    const { baseElement } = render(withActions(ui()))

    const text = (baseElement.textContent ?? '').toLowerCase()

    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('genpro')
    expect(text).not.toContain('mimo')
    expect(screen.queryByText(/genpro|mimo/i)).toBeNull()
  })
})
