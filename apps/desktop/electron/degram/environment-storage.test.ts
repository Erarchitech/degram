import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { descriptorForDgTarget } from './dg-target-config'
import {
  claimLegacyPartitionOwnership,
  legacyOriginForAdoption,
  markLegacyPartitionAdopted,
  partitionForTarget,
  persistDgTargetSettings,
  readLegacyPartitionOwnership,
  selectedTargetState,
  type EnvironmentStorageDeps
} from './environment-storage'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function temporaryStorage(initial?: Record<string, unknown>): { deps: EnvironmentStorageDeps; config: string; journal: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-environment-storage-'))
  roots.push(root)
  const config = path.join(root, 'degram.json')
  const journal = path.join(root, 'environment-ownership.json')

  if (initial) {
    fs.writeFileSync(config, JSON.stringify(initial, null, 2), 'utf8')
  }

  return {
    config,
    journal,
    deps: {
      configFile: config,
      journalFile: journal,
      readFile: file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
      writeFile: (file, text) => fs.writeFileSync(file, text, 'utf8'),
      replaceFile: (temporary, destination) => fs.renameSync(temporary, destination),
      temporaryFileFor: destination => path.join(path.dirname(destination), `.${path.basename(destination)}.tmp`)
    }
  }
}

describe('environment target storage', () => {
  it('merges schema v2 settings without losing adapter or unknown keys', () => {
    const { deps, config } = temporaryStorage({
      sentinel: { preserve: true },
      revitPython: 'C:\\adapter\\python.exe',
      revitMcpDir: 'C:\\adapter',
      dgOrigin: 'http://localhost:8080'
    })
    const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
    const demo = descriptorForDgTarget('demo', 'https://dg.173-249-46-99.nip.io')

    persistDgTargetSettings(deps, 'demo', { developer, demo })

    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toMatchObject({
      sentinel: { preserve: true },
      revitPython: 'C:\\adapter\\python.exe',
      revitMcpDir: 'C:\\adapter',
      schemaVersion: 2,
      activeDgTarget: 'demo',
      dgTargets: {
        developer: { origin: 'http://localhost:8080' },
        demo: { origin: 'https://dg.173-249-46-99.nip.io' }
      }
    })
  })

  it('does not overwrite malformed settings', () => {
    const { deps, config } = temporaryStorage()
    fs.writeFileSync(config, '{not JSON', 'utf8')
    const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
    const demo = descriptorForDgTarget('demo', 'https://dg.173-249-46-99.nip.io')

    expect(() => persistDgTargetSettings(deps, 'developer', { developer, demo })).toThrow(/not valid JSON/)
    expect(fs.readFileSync(config, 'utf8')).toBe('{not JSON')
  })

  it('does not replace the source file when an atomic write fails', () => {
    const { deps, config } = temporaryStorage({ sentinel: 'original' })
    const failed: EnvironmentStorageDeps = {
      ...deps,
      writeFile: (): void => {
        throw new Error('disk full')
      }
    }
    const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
    const demo = descriptorForDgTarget('demo', 'https://dg.173-249-46-99.nip.io')

    expect(() => persistDgTargetSettings(failed, 'developer', { developer, demo })).toThrow('disk full')
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ sentinel: 'original' })
  })

  it('writes a durable legacy ownership claim before marking adoption and survives restart/repeat calls', () => {
    const { deps, journal } = temporaryStorage()

    expect(claimLegacyPartitionOwnership(deps, 'http://localhost:8080')).toMatchObject({
      origin: 'http://localhost:8080',
      partition: 'persist:degram-dg',
      stage: 'claimed'
    })
    expect(JSON.parse(fs.readFileSync(journal, 'utf8'))).toMatchObject({ stage: 'claimed' })
    expect(markLegacyPartitionAdopted(deps, 'http://localhost:8080')).toMatchObject({ stage: 'adopted' })
    expect(readLegacyPartitionOwnership(deps)).toMatchObject({ stage: 'adopted' })
    expect(markLegacyPartitionAdopted(deps, 'http://localhost:8080')).toMatchObject({ stage: 'adopted' })

    expect(() => claimLegacyPartitionOwnership(deps, 'http://127.0.0.1:8080')).toThrow(/cannot be reassigned/i)
  })

  it('rejects a malformed ownership journal without modifying it', () => {
    const { deps, journal } = temporaryStorage()
    fs.writeFileSync(journal, '{broken', 'utf8')

    expect(() => readLegacyPartitionOwnership(deps)).toThrow(/not valid JSON/)
    expect(fs.readFileSync(journal, 'utf8')).toBe('{broken')
  })

  it('only assigns the old partition to its proven Developer origin; Demo never receives it', () => {
    const { deps } = temporaryStorage()
    claimLegacyPartitionOwnership(deps, 'http://localhost:8080')
    const developer = descriptorForDgTarget('developer', 'http://localhost:8080')
    const demo = descriptorForDgTarget('demo', 'https://dg.173-249-46-99.nip.io')

    expect(partitionForTarget(deps, developer)).toBe('persist:degram-dg')
    expect(partitionForTarget(deps, demo)).toBe(demo.partition)
    expect(partitionForTarget(deps, demo)).not.toBe('persist:degram-dg')
  })

  it('adopts a missing legacy setting only for localhost and blocks conflicting explicit input', () => {
    expect(legacyOriginForAdoption(undefined)).toBe('http://localhost:8080')
    expect(() => legacyOriginForAdoption('http://localhost:8080', 'http://127.0.0.1:8080')).toThrow(/conflicts/i)
    expect(() => legacyOriginForAdoption('https://dg.173-249-46-99.nip.io')).toThrow(/Developer target/i)
  })

  it('keeps selected intent separate from a runtime that has not been created', () => {
    const selected = descriptorForDgTarget('demo', 'https://dg.173-249-46-99.nip.io')

    assert.deepEqual(selectedTargetState(selected), { selected, effectiveRuntime: null })
  })
})
