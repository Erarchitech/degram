import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { THEME_PRESET_PALETTES } from '@hermes/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BUILTIN_THEMES, degramTheme } from '@/themes/presets'

afterEach(() => {
  vi.resetModules()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

// The exact table of 1301-UI-SPEC "Theme preset degram" (light / dark). The preset is the only place these literals
// may appear in the app; this file pins them against the spec.
const LIGHT = {
  background: '#f5f5f5',
  foreground: '#0a0a0a',
  card: '#ffffff',
  cardForeground: '#0a0a0a',
  popover: '#ffffff',
  popoverForeground: '#0a0a0a',
  sidebarBackground: '#fafafa',
  muted: '#fafafa',
  mutedForeground: '#737373',
  primary: '#171717',
  primaryForeground: '#fafafa',
  secondary: '#ebebeb',
  secondaryForeground: '#171717',
  accent: '#f0f0f0',
  accentForeground: '#0a0a0a',
  border: '#e5e5e5',
  input: '#e5e5e5',
  sidebarBorder: '#e5e5e5',
  userBubbleBorder: '#e5e5e5',
  userBubble: '#ffffff',
  ring: '#e7000b',
  midground: '#e7000b',
  composerRing: '#e7000b',
  destructive: '#b8000e',
  destructiveForeground: '#ffffff'
}

const DARK = {
  background: '#111111',
  foreground: '#f0f0f0',
  card: '#1b1b1b',
  cardForeground: '#f0f0f0',
  popover: '#1b1b1b',
  popoverForeground: '#f0f0f0',
  sidebarBackground: '#171717',
  muted: '#171717',
  mutedForeground: '#909090',
  primary: '#e2e2e2',
  primaryForeground: '#111111',
  secondary: '#262626',
  secondaryForeground: '#e2e2e2',
  accent: '#222222',
  accentForeground: '#f0f0f0',
  border: '#2a2a2a',
  input: '#2a2a2a',
  sidebarBorder: '#2a2a2a',
  userBubbleBorder: '#2a2a2a',
  userBubble: '#1b1b1b',
  ring: '#ff3b44',
  midground: '#ff3b44',
  composerRing: '#ff3b44',
  destructive: '#ff7079',
  destructiveForeground: '#111111'
}

describe('theme preset degram (UI-SPEC)', () => {
  it('carries exactly the UI-SPEC light and dark token values', () => {
    expect(THEME_PRESET_PALETTES.degram.colors).toEqual(LIGHT)
    expect(THEME_PRESET_PALETTES.degram.darkColors).toEqual(DARK)
    expect(degramTheme.colors).toEqual(LIGHT)
    expect(degramTheme.darkColors).toEqual(DARK)
  })

  it('names the bundled families first, ships no fontUrl and keeps the shared system tail', () => {
    expect(degramTheme.typography?.fontUrl).toBeUndefined()
    expect(degramTheme.typography?.fontSans?.startsWith("'Geist', ")).toBe(true)
    expect(degramTheme.typography?.fontMono?.startsWith("'Geist Mono', ")).toBe(true)
    expect(degramTheme.typography?.fontSans).toContain('Segoe UI')
    expect(degramTheme.typography?.fontSans).toMatch(/Segoe UI Emoji/)
    expect(degramTheme.typography?.fontMono).toContain('JetBrains Mono')
  })

  it('stays one selectable skin among the others', () => {
    expect(BUILTIN_THEMES.degram).toBe(degramTheme)
    expect(BUILTIN_THEMES.nous).toBeDefined()
    expect(Object.keys(BUILTIN_THEMES).length).toBeGreaterThan(5)
  })

  it('is the default skin of variant degram only', async () => {
    vi.resetModules()
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { degramEnabled: true }
    const degram = await import('@/themes/presets')

    expect(degram.DEFAULT_SKIN_NAME).toBe('degram')

    vi.resetModules()
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { degramEnabled: false }
    const other = await import('@/themes/presets')

    expect(other.DEFAULT_SKIN_NAME).toBe('nous')
  })
})

describe('bundled fonts (T-1301-13-03)', () => {
  const css = readFileSync(resolve(__dirname, 'fonts.css'), 'utf8')
  const dir = resolve(__dirname, '../assets/fonts/degram')
  const files = readdirSync(dir)

  it('has no network URL in fonts.css', () => {
    expect(css).not.toMatch(/https?:\/\//)
  })

  it('declares Geist 400/500, Geist Mono 400/500 and Oswald 500 from bundled woff2 files that exist', () => {
    const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(match => match[1])

    const has = (family: string, weight: number, subset: 'cyrillic' | 'latin') =>
      faces.some(
        face =>
          face.includes(`font-family: '${family}'`) &&
          face.includes(`font-weight: ${weight}`) &&
          face.includes(`-${subset}-${weight}-normal.woff2`)
      )

    for (const weight of [400, 500]) {
      expect(has('Geist', weight, 'latin')).toBe(true)
      expect(has('Geist Mono', weight, 'latin')).toBe(true)
      expect(has('Geist Mono', weight, 'cyrillic')).toBe(true)
    }

    expect(has('Oswald', 500, 'latin')).toBe(true)
    expect(has('Oswald', 500, 'cyrillic')).toBe(true)

    const urls = [...css.matchAll(/url\('\.\.\/assets\/fonts\/degram\/([^']+)'\)/g)].map(match => match[1])

    expect(urls.length).toBeGreaterThan(0)

    for (const file of urls) {
      expect(files, file).toContain(file)
    }
  })

  it('declares no Cyrillic face for Geist Sans, which has none (Segoe UI fallback)', () => {
    expect(css).not.toContain('geist-sans-cyrillic')
    expect(files.filter(file => file.startsWith('geist-sans-cyrillic'))).toEqual([])
  })

  it('ships a license text for every family', () => {
    expect(files).toEqual(
      expect.arrayContaining(['LICENSE-geist-sans.txt', 'LICENSE-geist-mono.txt', 'LICENSE-oswald.txt'])
    )
  })
})
