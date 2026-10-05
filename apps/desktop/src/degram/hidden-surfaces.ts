// hidden-surfaces.ts — the single gate for every upstream Hermes surface that must not exist in variant degram
// (DGCL-02, 1301-UI-SPEC "Upstream surfaces that must not render", T-1301-13-01/02).
//
// DeGram talks to one server-chosen model through the DG relay with a delegated, in-memory credential. A user must
// never be offered a model, a provider, an API key, a custom endpoint, a fallback chain, billing, an update or a
// remote-gateway setup: none of them can work, and the served system pair must never be disclosed. "Hide the entry,
// not just disable the action": each upstream entry point asks `isSurfaceHidden(id)` and renders nothing.
//
// The flag is the product-identity fact `$degramEnabled` (src/store/degram-flag.ts), fixed for the life of the
// window, so a plain read at render time is correct. Other variants answer `false` for every id and render exactly
// what they did before.

import { $degramEnabled } from '@/store/degram-flag'

/** Every surface hidden in variant degram. The first 15 are the plan's list; the rest are their settings doors. */
export const HIDDEN_SURFACES = [
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
  'remote-setup',
  // The settings pages that carry the entries above: the model section (context length, fallback providers),
  // billing, and the gateway/connection pages (remote setup).
  'model-settings',
  'billing-settings',
  'gateway-settings'
] as const

export type HiddenSurface = (typeof HIDDEN_SURFACES)[number]

const HIDDEN: ReadonlySet<string> = new Set(HIDDEN_SURFACES)

/** True when `id` must render nothing: only in variant degram, only for a listed surface. */
export function isSurfaceHidden(id: HiddenSurface): boolean {
  return $degramEnabled.get() && HIDDEN.has(id)
}

/**
 * The Settings views (`?tab=`) hidden in variant degram. The route enum is built without them, so a stale deep
 * link coerces to the default view instead of reaching a hidden page.
 */
export const HIDDEN_SETTINGS_VIEWS: Readonly<Record<string, HiddenSurface>> = {
  'config:model': 'model-settings',
  providers: 'providers-settings',
  keys: 'keys-settings',
  billing: 'billing-settings',
  gateway: 'gateway-settings',
  connections: 'gateway-settings'
}

export function isSettingsViewHidden(view: string): boolean {
  const surface = HIDDEN_SETTINGS_VIEWS[view]

  return surface !== undefined && isSurfaceHidden(surface)
}
