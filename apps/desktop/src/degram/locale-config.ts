// locale-config.ts — the DeGram interface language without the backend config (Phase 1301).
//
// Upstream persists `display.language` by reading the whole profile config (GET /api/config) and writing it back
// (PUT /api/config). Variant degram closes both routes (REST lock, F-06 / D-22): the config also carries provider,
// keys and tool settings the lockdown must keep out of reach. The language is a display preference only, so DeGram
// keeps it in the renderer's own storage and the I18nProvider reads and writes it through this client; nothing else
// of the config is read or stored.

import type { I18nConfigClient } from '@/i18n'

export const DEGRAM_LOCALE_KEY = 'degram.display.language'

function readStored(): string | null {
  try {
    const value = window.localStorage.getItem(DEGRAM_LOCALE_KEY)?.trim()

    return value ? value : null
  } catch {
    return null
  }
}

export const degramLocaleConfigClient: I18nConfigClient = {
  getConfig: async () => {
    const language = readStored()

    return language ? { display: { language } } : {}
  },
  saveConfig: async config => {
    const display = config.display

    const language =
      display && typeof display === 'object' && typeof (display as { language?: unknown }).language === 'string'
        ? ((display as { language: string }).language as string)
        : null

    try {
      if (language) {
        window.localStorage.setItem(DEGRAM_LOCALE_KEY, language)
      } else {
        window.localStorage.removeItem(DEGRAM_LOCALE_KEY)
      }

      return { ok: true }
    } catch {
      return { ok: false }
    }
  }
}
