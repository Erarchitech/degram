// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEGRAM_PAIRING_FILE, removeRetiredPairing } from './pairing-store'

describe('retired DeGram pairing migration', () => {
  let dir: string
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-pairing-'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the old file without reading or decrypting it and never recreates it', () => {
    const file = path.join(dir, DEGRAM_PAIRING_FILE)
    fs.writeFileSync(file, Buffer.from('opaque old credential'))
    const reads = vi.spyOn(fs, 'readFileSync')

    removeRetiredPairing(dir, logger)
    removeRetiredPairing(dir, logger)

    expect(fs.existsSync(file)).toBe(false)
    expect(reads).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('[degram] removed the retired pairing token')
    expect(fs.readdirSync(dir)).toEqual([])
    reads.mockRestore()
  })

  it('leaves other userData files untouched', () => {
    const other = path.join(dir, 'profile.json')
    fs.writeFileSync(other, '{}')

    removeRetiredPairing(dir, logger)

    expect(fs.readFileSync(other, 'utf8')).toBe('{}')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('reports a failed removal and allows the next startup to retry', () => {
    const file = path.join(dir, DEGRAM_PAIRING_FILE)
    fs.writeFileSync(file, 'opaque')
    const failFs = { ...fs, rmSync: vi.fn(() => { throw new Error('locked') }) } as typeof fs

    removeRetiredPairing(dir, logger, failFs)

    expect(fs.existsSync(file)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith('[degram] could not remove the retired pairing token')
    removeRetiredPairing(dir, logger)
    expect(fs.existsSync(file)).toBe(false)
  })
})
