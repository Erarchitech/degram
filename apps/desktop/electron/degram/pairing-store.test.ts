// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPairingStore, DEGRAM_PAIRING_FILE, isPairingToken, type SafeStorageLike } from './pairing-store'

const TOKEN = 'dgp_' + 'A'.repeat(43)

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    // Reversible, but never the clear text: the test proves the file holds ciphertext only.
    encryptString: (text: string) =>
      Buffer.from(Buffer.from(text.split('').reverse().join(''), 'utf8').map(b => b ^ 0x5a)),
    decryptString: (data: Buffer) =>
      Buffer.from(data.map(b => b ^ 0x5a))
        .toString('utf8')
        .split('')
        .reverse()
        .join('')
  }
}

describe('pairing-store', () => {
  let dir: string
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-pairing-'))
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const build = (available = true) => createPairingStore({ dir, safeStorage: fakeSafeStorage(available), logger })

  it('stores a dgp_ token as ciphertext only and reads it back in main', () => {
    const store = build()

    expect(store.has()).toBe(false)
    expect(store.set(TOKEN)).toEqual({ ok: true })
    expect(store.has()).toBe(true)
    expect(store.get()).toBe(TOKEN)

    const raw = fs.readFileSync(path.join(dir, DEGRAM_PAIRING_FILE))

    expect(raw.toString('utf8')).not.toContain(TOKEN)
    expect(raw.toString('latin1')).not.toContain('dgp_')
  })

  it('refuses anything that is not a pairing token', () => {
    const store = build()

    for (const bad of [
      '',
      'dgd_' + 'A'.repeat(43),
      'dgc_' + 'A'.repeat(43),
      'dgp_short',
      `dgp_${'A'.repeat(40)} x`,
      42
    ]) {
      expect(store.set(bad as never)).toEqual({ ok: false, code: 'PAIRING_INVALID' })
    }

    expect(store.has()).toBe(false)
    expect(fs.existsSync(path.join(dir, DEGRAM_PAIRING_FILE))).toBe(false)
  })

  it('refuses to store when OS encryption is unavailable (never clear text on disk)', () => {
    const store = build(false)

    expect(store.set(TOKEN)).toEqual({ ok: false, code: 'ENCRYPTION_UNAVAILABLE' })
    expect(store.has()).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('clear() removes the file', () => {
    const store = build()

    store.set(TOKEN)
    store.clear()

    expect(store.has()).toBe(false)
    expect(store.get()).toBeNull()
    expect(fs.existsSync(path.join(dir, DEGRAM_PAIRING_FILE))).toBe(false)
  })

  it('writes atomically: no temp file is left behind and a second set replaces the first', () => {
    const store = build()
    const second = 'dgp_' + 'B'.repeat(43)

    store.set(TOKEN)
    store.set(second)

    expect(store.get()).toBe(second)
    expect(fs.readdirSync(dir)).toEqual([DEGRAM_PAIRING_FILE])
  })

  it('a corrupt or foreign file reads as no pairing', () => {
    fs.writeFileSync(path.join(dir, DEGRAM_PAIRING_FILE), Buffer.from('garbage'))

    const store = build()

    expect(store.get()).toBeNull()
    expect(store.has()).toBe(false)
  })

  it('never logs the token', () => {
    const store = build()

    store.set(TOKEN)
    store.get()
    store.clear()
    build(false).set(TOKEN)

    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])

    expect(logged).not.toContain('dgp_')
  })

  it('isPairingToken accepts only the dgp_ url-safe shape', () => {
    expect(isPairingToken(TOKEN)).toBe(true)
    expect(isPairingToken(`dgp_${'a-_'.repeat(15)}`)).toBe(true)
    expect(isPairingToken('dgd_' + 'A'.repeat(43))).toBe(false)
    expect(isPairingToken(`dgp_${'A'.repeat(300)}`)).toBe(false)
  })
})
