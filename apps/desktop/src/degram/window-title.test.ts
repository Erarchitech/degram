import { describe, expect, it } from 'vitest'

import { applyProductWindowTitle, productWindowTitle } from './window-title'

describe('productWindowTitle', () => {
  it('names DeGram windows DeGram, never Hermes', () => {
    expect(productWindowTitle(true, null)).toBe('DeGram')
    expect(productWindowTitle(true, 'secondary')).toBe('DeGram')
    expect(productWindowTitle(true, 'hud')).toBe('DeGram HUD')
  })

  it('keeps the upstream titles for Hermes builds', () => {
    expect(productWindowTitle(false, null)).toBeNull()
    expect(productWindowTitle(false, 'hud')).toBe('Hermes HUD')
  })
})

describe('applyProductWindowTitle', () => {
  it('overrides the index.html <title> so Electron retitles the native window', () => {
    const doc = { title: 'Hermes' }
    applyProductWindowTitle(doc, true, null)
    expect(doc.title).toBe('DeGram')
  })

  it('leaves a Hermes main window on its index.html title', () => {
    const doc = { title: 'Hermes' }
    applyProductWindowTitle(doc, false, null)
    expect(doc.title).toBe('Hermes')
  })
})
