import { describe, expect, it } from 'vitest'

import { DgConfigError, type DgConfigDeps } from './dg-config'
import {
  DEFAULT_DEMO_DG_ORIGIN,
  DEFAULT_DEVELOPER_DG_ORIGIN,
  descriptorForDgTarget,
  environmentIdForOrigin,
  partitionForEnvironment,
  resolveDgTarget,
  validateDgTargetOrigin
} from './dg-target-config'

const HOME = 'C:\\Users\\u\\AppData\\Local\\DeGram\\home'

const files =
  (map: Record<string, string>) =>
  (file: string): string | null =>
    file in map ? map[file] : null

function deps(config: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = {}): DgConfigDeps {
  return {
    env,
    home: HOME,
    platform: 'win32',
    readFile: files(config === undefined ? {} : { [`${HOME}\\degram.json`]: JSON.stringify(config) })
  }
}

describe('DGMODE target validation', () => {
  it.each([
    ['developer', 'http://localhost:8080/', 'http://localhost:8080'],
    ['developer', 'https://127.0.0.1:9443', 'https://127.0.0.1:9443'],
    ['developer', 'http://[::1]:8080', 'http://[::1]:8080'],
    ['demo', 'HTTPS://DG.173-249-46-99.NIP.IO:443/', DEFAULT_DEMO_DG_ORIGIN]
  ] as const)('accepts %s target %s', (mode, origin, expected) => {
    expect(validateDgTargetOrigin(mode, origin)).toBe(expected)
  })

  it.each([
    ['developer', 'http://localhost.example.test:8080'],
    ['developer', 'http://127.0.0.10:8080'],
    ['developer', 'http://[::1evil]:8080'],
    ['developer', 'https://dg.example.test'],
    ['demo', 'http://dg.173-249-46-99.nip.io'],
    ['demo', 'https://dg.example.test/app'],
    ['demo', 'https://user:secret@dg.example.test']
  ] as const)('rejects %s target %s', (mode, origin) => {
    expect(() => validateDgTargetOrigin(mode, origin)).toThrow(DgConfigError)
  })
})

describe('DGMODE environment identity', () => {
  it('derives identity only from the canonical origin and emits a colon-safe partition', () => {
    const a = environmentIdForOrigin('HTTPS://DG.EXAMPLE.TEST:443/')
    const b = environmentIdForOrigin('https://dg.example.test')
    const c = environmentIdForOrigin('https://other.example.test')

    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^dg-env-v1-[a-f0-9]{64}$/)
    expect(partitionForEnvironment(a)).toMatch(/^persist:degram-dg-[a-f0-9]{64}$/)
    expect(partitionForEnvironment(a).slice('persist:'.length)).not.toContain(':')
  })

  it('does not derive environment identity from the target label', () => {
    expect(descriptorForDgTarget('developer', 'http://localhost:8080').environmentId).toBe(
      descriptorForDgTarget('developer', 'http://localhost:8080').environmentId
    )
    expect(descriptorForDgTarget('developer', 'http://localhost:8080').environmentId).not.toBe(
      descriptorForDgTarget('developer', 'http://localhost:8081').environmentId
    )
  })
})

describe('resolveDgTarget', () => {
  const configured = {
    schemaVersion: 2,
    activeDgTarget: 'demo',
    dgTargets: {
      developer: { origin: DEFAULT_DEVELOPER_DG_ORIGIN },
      demo: { origin: DEFAULT_DEMO_DG_ORIGIN }
    }
  }

  it('defaults a missing legacy configuration to the Developer target', () => {
    expect(resolveDgTarget(deps(undefined))).toMatchObject({
      mode: 'developer',
      origin: DEFAULT_DEVELOPER_DG_ORIGIN,
      selectedMode: 'developer',
      source: 'default',
      overrideActive: false
    })
  })

  it('uses a selected v2 target and exposes its selected/effective source', () => {
    expect(resolveDgTarget(deps(configured))).toMatchObject({
      mode: 'demo',
      origin: DEFAULT_DEMO_DG_ORIGIN,
      selectedMode: 'demo',
      source: 'file',
      overrideActive: false
    })
  })

  it('maps a legacy loopback setting to Developer and HTTPS remote setting to Demo', () => {
    expect(resolveDgTarget(deps({ dgOrigin: 'http://127.0.0.1:9000' }))).toMatchObject({
      mode: 'developer',
      origin: 'http://127.0.0.1:9000',
      source: 'legacy'
    })
    expect(resolveDgTarget(deps({ dgOrigin: 'https://dg.example.test' }))).toMatchObject({
      mode: 'demo',
      origin: 'https://dg.example.test',
      source: 'legacy'
    })
  })

  it('fails closed for legacy remote HTTP', () => {
    expect(() => resolveDgTarget(deps({ dgOrigin: 'http://dg.example.test' }))).toThrow(/remote HTTP/i)
  })

  it('accepts an env override only when it exactly matches a configured target, and locks the effective target', () => {
    expect(resolveDgTarget(deps(configured, { DEGRAM_DG_ORIGIN: DEFAULT_DEVELOPER_DG_ORIGIN }))).toMatchObject({
      mode: 'developer',
      selectedMode: 'demo',
      source: 'env',
      overrideActive: true
    })
  })

  it('fails closed for unmatched or conflicting environment overrides with repair guidance', () => {
    expect(() => resolveDgTarget(deps(configured, { DEGRAM_DG_ORIGIN: 'https://other.example.test' }))).toThrow(
      /exactly match.*Remove the override/i
    )
    expect(() =>
      resolveDgTarget(deps({ dgOrigin: 'http://localhost:8080' }, { DEGRAM_DG_ORIGIN: 'http://127.0.0.1:8080' }))
    ).toThrow(/conflicts with the legacy/i)
  })
})
