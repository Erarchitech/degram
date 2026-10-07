import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, useI18n } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'

import { DEGRAM_LOCALE_KEY, degramLocaleConfigClient } from './locale-config'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  $degramEnabled.set(false)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('degramLocaleConfigClient (Phase 1301: language without /api/config)', () => {
  it('reads nothing before a choice and round-trips display.language only', async () => {
    expect(await degramLocaleConfigClient.getConfig()).toEqual({})
    expect(
      await degramLocaleConfigClient.saveConfig({ display: { language: 'en' }, model: { provider: 'x' } })
    ).toEqual({
      ok: true
    })
    expect(window.localStorage.getItem(DEGRAM_LOCALE_KEY)).toBe('en')
    expect(await degramLocaleConfigClient.getConfig()).toEqual({ display: { language: 'en' } })
  })

  it('ignores a malformed stored value', async () => {
    window.localStorage.setItem(DEGRAM_LOCALE_KEY, '   ')
    expect(await degramLocaleConfigClient.getConfig()).toEqual({})
  })
})

function Picker() {
  const { locale, saveError, setLocale } = useI18n()

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="error">{saveError ? saveError.message : ''}</span>
      <button onClick={() => void setLocale('en')}>en</button>
    </div>
  )
}

describe('I18nProvider in variant degram', () => {
  it('changes the language without calling the locked config API and keeps it across a remount', async () => {
    const api = vi.fn(async () => {
      throw new Error('403: {"detail":{"code":"DEGRAM_LOCKED"}}')
    })

    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api, degramEnabled: true }
    $degramEnabled.set(true)

    const first = render(
      <I18nProvider>
        <Picker />
      </I18nProvider>
    )

    await act(async () => {
      screen.getByText('en').click()
    })

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('error').textContent).toBe('')
    expect(api).not.toHaveBeenCalled()
    first.unmount()

    render(
      <I18nProvider>
        <Picker />
      </I18nProvider>
    )
    await act(async () => {})
    expect(screen.getByTestId('locale').textContent).toBe('en')
  })
})
