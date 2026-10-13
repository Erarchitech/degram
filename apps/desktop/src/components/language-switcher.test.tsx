import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'
import { type I18nConfigClient, I18nProvider, registerAppLocale } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { LanguageSwitcher } from './language-switcher'

stubResizeObserver()
stubMenuDomApis()
describe('LanguageSwitcher', () => {
  afterEach(() => {
    cleanup()
    $degramEnabled.set(false)
    vi.restoreAllMocks()
  })

  it('persists language changes through display.language config', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })
    const latestConfig: HermesConfigRecord = { display: { language: 'en', skin: 'slate' } }

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue(latestConfig),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch language' }).hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    fireEvent.click(screen.getByRole('option', { name: /日本語/i }))

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'ja', skin: 'slate' } })
  })

  it('lists a registered language by endonym, renders its pack, and writes its id to display.language', async () => {
    const dispose = registerAppLocale(
      'pl',
      { endonym: 'Polski', translations: { language: { switchTo: 'Zmień język' } } },
      'plugin:hermes-lang-pl'
    )

    const saveConfig = vi.fn().mockResolvedValue({ ok: true })
    const latestConfig: HermesConfigRecord = { display: { language: 'en' } }

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue(latestConfig),
      saveConfig
    }

    try {
      render(
        <I18nProvider configClient={configClient}>
          <LanguageSwitcher />
        </I18nProvider>
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Switch language' }).hasAttribute('disabled')).toBe(false)
      })

      fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))

      // Endonym only — no flag, and the option list is bundled ∪ registered.
      const options = screen.getAllByRole('option').map(option => option.textContent)
      expect(options.some(text => text?.includes('Polski'))).toBe(true)
      expect(options.some(text => text?.includes('English'))).toBe(true)

      fireEvent.click(screen.getByRole('option', { name: /Polski/ }))

      await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
      expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'pl' } })
      // The pack's strings paint: the trigger now carries the Polish label.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Zmień język' })).toBeTruthy())
      expect(screen.getByRole('button', { name: 'Zmień język' }).textContent).toContain('Polski')
    } finally {
      dispose()
    }
  })

  it('shows only Русский then English without search in the DeGram variant', async () => {
    $degramEnabled.set(true)
    const dispose = registerAppLocale('pl', { endonym: 'Polski' }, 'plugin:hermes-lang-pl')
    const disposeRu = registerAppLocale('ru', { endonym: 'Override RU' }, 'plugin:ru-label')
    const disposeEn = registerAppLocale('en', { endonym: 'Override EN' }, 'plugin:en-label')
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'ru' } }),
      saveConfig: vi.fn().mockResolvedValue({ ok: true })
    }

    try {
      render(
        <I18nProvider configClient={configClient}>
          <LanguageSwitcher />
        </I18nProvider>
      )

      await waitFor(() => expect(screen.getByRole('button', { name: /язык/i }).textContent).toContain('Русский'))
      fireEvent.click(screen.getByRole('button', { name: /язык/i }))
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
        expect.stringContaining('Русский'),
        expect.stringContaining('English')
      ])
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByText(/совпадений нет/i)).toBeNull()
      expect(screen.getByRole('option', { name: /Русский/i }).querySelector('.codicon-check')).toBeTruthy()
      expect(screen.getByRole('option', { name: /English/i }).querySelector('.codicon-check')).toBeNull()
      fireEvent.click(screen.getByRole('option', { name: /English/i }))
      await waitFor(() => expect(configClient.saveConfig).toHaveBeenCalledWith({ display: { language: 'en' } }))
    } finally {
      disposeEn()
      disposeRu()
      dispose()
    }
  })

  it('keeps the searchable full catalog in the stock variant', () => {
    render(
      <I18nProvider configClient={null}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    expect(screen.getAllByRole('option').length).toBeGreaterThan(2)
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('re-lists when a language pack lands after first paint', async () => {
    render(
      <I18nProvider configClient={null}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    expect(screen.queryByRole('option', { name: /Українська/ })).toBeNull()

    const dispose = registerAppLocale('uk', { endonym: 'Українська' }, 'backend')

    try {
      await waitFor(() => expect(screen.getByRole('option', { name: /Українська/ })).toBeTruthy())
    } finally {
      dispose()
    }
  })
})
