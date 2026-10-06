// pairing-store.ts — the DeGram pairing token at rest (Phase 1301-17, D-25, D-27).
//
// The user creates a `dgp_` pairing token on the DG Connectors tab and pastes it into DeGram once. It is
// long-lived (revoke only), so it is kept only as Electron `safeStorage` ciphertext in DeGram's own userData
// (`degram-pairing.bin`), written atomically. When OS encryption is unavailable the store refuses to keep it:
// a clear-text copy is never written. `get()` is called from main only (dg-session.ts, to exchange it for a
// short-lived `dgd_`); no IPC channel returns it and nothing here logs it.

import nodeFs from 'node:fs'
import nodePath from 'node:path'

import type { Logger } from './dg-session'

export const DEGRAM_PAIRING_FILE = 'degram-pairing.bin'

const PAIRING_PATTERN = /^dgp_[A-Za-z0-9_-]{32,200}$/

/** True for a value shaped like a DG pairing token (`dgp_` + url-safe base64). */
export function isPairingToken(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_PATTERN.test(value)
}

/** The part of Electron `safeStorage` the store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (text: string) => Buffer
  decryptString: (data: Buffer) => string
}

export type PairingSetResult =
  { ok: true } | { ok: false; code: 'PAIRING_INVALID' | 'ENCRYPTION_UNAVAILABLE' | 'WRITE_FAILED' }

export interface PairingStore {
  set: (token: string) => PairingSetResult
  /** The stored token, or null. Main process only. */
  get: () => string | null
  has: () => boolean
  clear: () => void
}

export interface PairingStoreDeps {
  /** DeGram's userData directory. */
  dir: string
  safeStorage: SafeStorageLike
  logger: Logger
  fs?: typeof nodeFs
}

export function createPairingStore(deps: PairingStoreDeps): PairingStore {
  const fs = deps.fs ?? nodeFs
  const file = nodePath.join(deps.dir, DEGRAM_PAIRING_FILE)

  const read = (): string | null => {
    let data: Buffer

    try {
      data = fs.readFileSync(file)
    } catch {
      return null
    }

    try {
      const token = deps.safeStorage.decryptString(data)

      return isPairingToken(token) ? token : null
    } catch {
      deps.logger.warn('[degram] the stored pairing could not be decrypted; treating it as absent')

      return null
    }
  }

  const clear = (): void => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      deps.logger.warn('[degram] could not remove the stored pairing')
    }
  }

  const set = (token: string): PairingSetResult => {
    if (!isPairingToken(token)) {
      return { ok: false, code: 'PAIRING_INVALID' }
    }

    if (!deps.safeStorage.isEncryptionAvailable()) {
      deps.logger.warn('[degram] OS encryption unavailable; the pairing is not stored')

      return { ok: false, code: 'ENCRYPTION_UNAVAILABLE' }
    }

    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`

    try {
      fs.mkdirSync(deps.dir, { recursive: true })
      fs.writeFileSync(tmp, deps.safeStorage.encryptString(token), { mode: 0o600 })
      fs.renameSync(tmp, file)

      return { ok: true }
    } catch {
      deps.logger.error('[degram] could not write the pairing store')

      return { ok: false, code: 'WRITE_FAILED' }
    } finally {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // already renamed or never written
      }
    }
  }

  return { set, get: read, has: (): boolean => read() !== null, clear }
}
