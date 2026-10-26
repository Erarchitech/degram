import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import { ruOverrides } from '@/i18n/ru'

import { degramEn, degramRu } from './i18n'

// DeGram mounts shared wiring (chat, statusbar, palette, errors and dialogs),
// keeps Settings except the hidden model/provider/key/billing/gateway views, and
// retains direct workspace routes such as Capabilities, Messaging and Artifacts.
// Profiles, Skills and the upstream Assistant screen are not DeGram pages and
// are deliberately outside this coverage gate. The owner's in-app review covers
// visual translation quality; this gate checks explicit overrides in shared UI.
// intro lives in a JSONL file. Shared namespaces may still contain hidden copy.
// Settings routes config:model, providers, keys, billing and gateway are blocked
// by hidden-surfaces.ts; the model picker and billing banner are blocked there
// too. These paths are their copy, not English text visible in DeGram.
const HIDDEN_SETTINGS_PREFIXES = [
  'settings.customEndpoints.',
  'settings.managedUpdates.',
  'settings.model.',
  'settings.localModels.',
  'settings.billing.'
] as const
const HIDDEN_SETTINGS_LEAVES = new Set([
  'settings.nav.providerLocalModels', // child of the hidden providers nav group
  'settings.gateway.keychainEncryptionTitle',
  'settings.gateway.keychainEncryptionDesc',
  'settings.gateway.keychainEncryptionFailed' // gateway-settings.tsx only; other gateway copy is shared
])

function isDegramCopy(path: string): boolean {
  return !HIDDEN_SETTINGS_LEAVES.has(path) && !HIDDEN_SETTINGS_PREFIXES.some(prefix => path.startsWith(prefix))
}

export const DEGRAM_SURFACE_NAMESPACES = [
  'externalOpenFailed',
  'sharedMetrics',
  'connectors',
  'connectorsPage',
  'sessionImport',
  'common',
  'fileMenu',
  'boot',
  'notifications',
  'remoteDisplayBanner',
  'sendDiagnostics',
  'titlebar',
  'keybinds',
  'findInPage',
  'language',
  'settings',
  'skillDeepLink',
  'starmap',
  'agents',
  'commandCenter',
  'messaging',
  'webhooks',
  'modelAssignment',
  'cron',
  'artifacts',
  'artifactCard',
  'artifactPreview',
  'sidebar',
  'composer',
  'statusStack',
  'handoffTour',
  'guidedGreeting',
  'install',
  'onboarding',
  'shell',
  'rightSidebar',
  'preview',
  'interfaceMode',
  'zones',
  'contextMenu',
  'prompts',
  'desktop',
  'tips',
  'errors',
  'ui'
] as const satisfies readonly (keyof typeof TRANSLATIONS.en)[]

type Leaf = { path: string; value: unknown }

function leaves(value: unknown, path = ''): Leaf[] {
  if (Array.isArray(value)) {
    return [{ path, value }, ...value.flatMap((child, index) => leaves(child, `${path}.${index}`))]
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key))
  }

  return [{ path, value }]
}

const kindOf = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value)

// D-13: DeGram/DG/Revit/Grasshopper are product names; STDIO, OAuth, URL,
// KEY/value, opaque identifiers and literal input tokens are intentionally
// identical. The reviewed DeGram-visible Settings leaves below include protocol
// labels, product names and examples that cannot be translated without changing
// their accepted input or displayed identity.
const IDENTICAL_COPY = new Set([
  'degram.brand',
  'degram.nav.dg',
  'degram.bridge.revit',
  'degram.bridge.grasshopper',
  'connectorsPage.add.typeStdio',
  'connectorsPage.add.authOauth',
  'connectorsPage.add.url',
  'connectorsPage.add.pastePlaceholder',
  'connectorsPage.add.keyPlaceholder',
  'connectorsPage.add.valuePlaceholder',
  'sendDiagnostics.links.github',
  'sendDiagnostics.links.discord',
  'settings.nav.mcp',
  'webhooks.deliverOptions.telegram',
  'webhooks.deliverOptions.discord',
  'webhooks.deliverOptions.slack',
  'messaging.fieldCopy.MATTERMOST_URL.placeholder',
  'messaging.fieldCopy.MATRIX_HOMESERVER.placeholder',
  'messaging.fieldCopy.MATRIX_USER_ID.placeholder',
  'messaging.fieldCopy.SIGNAL_HTTP_URL.placeholder',
  'composer.themeTryPost',
  'composer.url',
  'composer.urlPlaceholder',
  'install.remoteUrlPlaceholder',
  'settings.plugins.installModal.repoPlaceholder',
  'settings.vault.originPlaceholder',
  'settings.vault.originPlaceholderCheckout',
  'settings.vault.identifierShown',
  'settings.vault.cvcField',
  'settings.notifications.testTitle',
  'settings.appearance.installPlaceholder',
  'settings.connections.kindCloud',
  'settings.connections.kindSsh',
  'settings.gateway.cloudTitle',
  'settings.gateway.cloudSignInTitle',
  'statusStack.exit',
  'cron.deliveryLabels.telegram',
  'cron.deliveryLabels.discord',
  'cron.deliveryLabels.slack',
  'cron.deliveryLabels.email',
  'sidebar.filter.pr',
  'artifacts.zero',
  'artifacts.colLocationLink',
  'commandCenter.maintenance.bytes',
  'rightSidebar.folderTip',
  'preview.diff',
  'desktop.yoloTitle',
  'onboarding.pro',
  'shell.statusbar.desktopVersion',
  'shell.statusbar.connectionSsh',
  'shell.statusbar.connectionSshTooltip',
  'shell.statusbar.connectionCloudTooltip',
  'shell.statusbar.contextUsagePanel.categories.mcp',
  'shell.statusbar.providerModelTitle'
])

// English words such as Save and Tools are not identifiers even if they contain
// no spaces: every identical leaf is reviewed explicitly above.
const IDENTIFIER_ARGS: Record<string, number[]> = {
  'settings.toolsets.webCapabilitySelectedMessage': [1],
  'settings.plugins.installModal.missingEnv': [0]
}

function assertCopy(english: unknown, translated: unknown, prefix: string): void {
  const source = new Map(
    leaves(english, prefix)
      .filter(({ path }) => prefix !== 'settings' || isDegramCopy(path))
      .map(({ path, value }) => [path, value])
  )
  const target = new Map(
    leaves(translated, prefix)
      .filter(({ path }) => prefix !== 'settings' || isDegramCopy(path))
      .map(({ path, value }) => [path, value])
  )

  const missing = [...source.keys()].filter(path => !target.has(path))
  const extra = [...target.keys()].filter(path => !source.has(path))
  expect({ missing, extra }, prefix).toEqual({ missing: [], extra: [] })

  for (const [path, value] of source) {
    const actual = target.get(path)
    expect(kindOf(actual), path).toBe(kindOf(value))

    if (typeof value === 'string') {
      if (value.trim()) {
        expect((actual as string).trim(), path).not.toBe('')
      }
      if (value.trim() && !IDENTICAL_COPY.has(path)) {
        expect(actual, `${path} falls back to English`).not.toBe(value)
      }
    } else if (Array.isArray(value)) {
      expect((actual as unknown[]).length, path).toBe(value.length)
    } else if (typeof value === 'function') {
      const translatedFn = actual as (...args: unknown[]) => unknown
      expect(translatedFn.length, path).toBe(value.length)
      const probes = Array.from({ length: value.length }, (_, index) => `⟦${index}⟧`)
      let sourceText: string | undefined
      try {
        sourceText = JSON.stringify(value(...probes))
      } catch {
        continue // A structured source argument needs a domain-specific probe; TS checks its signature.
      }
      const targetText = JSON.stringify(translatedFn(...probes))
      expect(targetText, `${path} returns no translated copy`).toBeDefined()
      expect(sourceText, `${path} returns no English copy`).toBeDefined()
      if (!sourceText || !targetText) {
        continue
      }

      const identifiers = new Set(IDENTIFIER_ARGS[path]?.map(index => probes[index]))
      for (const probe of probes.filter(probe => sourceText.includes(probe) && !identifiers.has(probe))) {
        expect(targetText, `${path} drops ${probe}`).toContain(probe)
      }
      if (sourceText && !IDENTICAL_COPY.has(path)) {
        expect(targetText, `${path} falls back to English`).not.toBe(sourceText)
      }
    }
  }
}

describe('DeGram RU catalog (D-54)', () => {
  it('covers every DeGram-specific key and interpolation', () => {
    assertCopy(degramEn, degramRu, 'degram')
  })

  it.each(DEGRAM_SURFACE_NAMESPACES)('explicitly translates %s without EN fallback', namespace => {
    const override = (ruOverrides as Partial<Record<keyof typeof TRANSLATIONS.en, unknown>>)[namespace]
    assertCopy(TRANSLATIONS.en[namespace], override, namespace)
  })
})
