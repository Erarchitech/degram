// first-run-locale.ts — kept apart from the copy catalog so the catalog (imported by en.ts and ru.ts) never
// pulls the product-identity store into every module that loads a translation.

import { $degramEnabled } from '@/store/degram-flag'

/**
 * The locale a first run of variant `degram` starts in (UI-SPEC: "Russian is the first-run locale"). `null` for
 * every other variant, so the standard Hermes resolution (saved choice, then OS locale, then English) is
 * untouched. A saved `display.language` always wins: callers consult this only when nothing was saved.
 */
export function degramFirstRunLocale(): 'ru' | null {
  return $degramEnabled.get() ? 'ru' : null
}
