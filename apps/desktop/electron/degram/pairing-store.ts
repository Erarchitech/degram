// pairing-store.ts — remove the retired DeGram pairing credential without reading or decrypting it.

import nodeFs from 'node:fs'
import nodePath from 'node:path'

import type { Logger } from './dg-session'

export const DEGRAM_PAIRING_FILE = 'degram-pairing.bin'

/** Idempotent startup migration. A failed deletion is retried on the next launch. */
export function removeRetiredPairing(dir: string, logger: Logger, fs: typeof nodeFs = nodeFs): void {
  const file = nodePath.join(dir, DEGRAM_PAIRING_FILE)

  try {
    if (!fs.existsSync(file)) return
    fs.rmSync(file)
    logger.info('[degram] removed the retired pairing token')
  } catch {
    logger.warn('[degram] could not remove the retired pairing token')
  }
}
