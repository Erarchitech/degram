// first-run-locale.ts — kept apart from the copy catalog so the catalog (imported by en.ts and ru.ts) never
// pulls the product-identity store into every module that loads a translation.

import { $degramEnabled } from '@/store/degram-flag'

/**
 * The locale a first run of variant `degram` starts in: the Windows display language, Russian for a Russian Windows
 * and English for any other (owner decision 2026-11-01, quick 261101-dzj; it was always Russian before). `osLocale`
 * is the machine profile's `app.getLocale()`; before it arrives the renderer's own `navigator.language` (the same
 * system language in Electron) stands in. `null` for every other variant, so the standard Hermes resolution (saved
 * choice, then OS locale, then English) is untouched. A saved `display.language` always wins: callers consult this
 * only when nothing was saved.
 */
export function degramFirstRunLocale(osLocale?: null | string): 'en' | 'ru' | null {
  if (!$degramEnabled.get()) {
    return null
  }

  const tag = osLocale || (typeof navigator === 'undefined' ? '' : navigator.language) || ''

  return /^ru(?:[-_]|$)/i.test(tag) ? 'ru' : 'en'
}
