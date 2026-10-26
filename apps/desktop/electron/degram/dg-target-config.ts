// dg-target-config.ts — explicit Developer/Demo DG target policy (Phase 1301-42, DGMODE-01).
//
// This layer resolves the target selected for a DeGram run. It deliberately does not touch an
// Electron session: later plans own the runtime switch. Keeping target validation and origin
// identity here means configuration, storage and runtime all agree before credentials are used.

import { createHash } from 'node:crypto'

import { DgConfigError, normalizeDgOrigin, readDegramJson, type DgConfigDeps, type DegramJson } from './dg-config'

export const DEFAULT_DEVELOPER_DG_ORIGIN = 'http://localhost:8080'
export const DEFAULT_DEMO_DG_ORIGIN = 'https://dg.173-249-46-99.nip.io'
export const DG_ENVIRONMENT_ID_VERSION = 'dg-env-v1'

export type DgTargetMode = 'developer' | 'demo'
export type DgTargetSource = 'default' | 'legacy' | 'file' | 'env'

export interface DgTargetDescriptor {
  mode: DgTargetMode
  origin: string
  environmentId: string
  partition: string
}

export interface ResolvedDgTarget extends DgTargetDescriptor {
  /** The persisted intent, which may differ from an explicit process override. */
  selectedMode: DgTargetMode
  /** Why the effective target was selected. An env source locks target selection until restart. */
  source: DgTargetSource
  overrideActive: boolean
}

interface TargetOriginConfig {
  origin: string
}

type TargetOriginRecord = Partial<Record<DgTargetMode, TargetOriginConfig>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function targetMode(value: unknown): DgTargetMode | null {
  return value === 'developer' || value === 'demo' ? value : null
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Apply the target-mode trust boundary to an already-normalized origin. */
export function validateDgTargetOrigin(mode: DgTargetMode, raw: unknown): string {
  const origin: string | null = normalizeDgOrigin(raw)

  if (!origin) {
    throw new DgConfigError('DG_ORIGIN_INVALID', `${mode} target must be a bare http(s) origin without credentials, path, query or hash.`)
  }

  const url = new URL(origin)

  if (mode === 'developer' && !isLoopbackHost(url.hostname)) {
    throw new DgConfigError(
      'DG_ORIGIN_INVALID',
      'Developer target must use localhost, 127.0.0.1 or [::1]; remove the target or choose Demo for an HTTPS stand.'
    )
  }

  if (mode === 'demo' && url.protocol !== 'https:') {
    throw new DgConfigError('DG_ORIGIN_INVALID', 'Demo target must use HTTPS; remote HTTP is never a permitted DeGram target.')
  }

  return origin
}

/**
 * A stable identity shared by all target-scoped stores. The canonical origin, not the mutable
 * target label, is hashed so renaming a target can never create a second environment.
 */
export function environmentIdForOrigin(origin: string): string {
  const canonical: string | null = normalizeDgOrigin(origin)

  if (!canonical) {
    throw new DgConfigError('DG_ORIGIN_INVALID', 'Environment identity requires a bare http(s) origin.')
  }

  const digest: string = createHash('sha256').update(`${DG_ENVIRONMENT_ID_VERSION}:${canonical}`, 'utf8').digest('hex')

  return `${DG_ENVIRONMENT_ID_VERSION}-${digest}`
}

/** A colon-safe Electron cookie partition for an origin-specific environment. */
export function partitionForEnvironment(environmentId: string): string {
  const prefix = `${DG_ENVIRONMENT_ID_VERSION}-`
  const digest = environmentId.startsWith(prefix) ? environmentId.slice(prefix.length) : ''

  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new DgConfigError('DG_CONFIG_INVALID', `Invalid ${DG_ENVIRONMENT_ID_VERSION} environment identity.`)
  }

  return `persist:degram-dg-${digest}`
}

export function descriptorForDgTarget(mode: DgTargetMode, origin: unknown): DgTargetDescriptor {
  const canonicalOrigin = validateDgTargetOrigin(mode, origin)
  const environmentId = environmentIdForOrigin(canonicalOrigin)

  return { mode, origin: canonicalOrigin, environmentId, partition: partitionForEnvironment(environmentId) }
}

function configuredOrigin(mode: DgTargetMode, configured: unknown): string {
  const fallback = mode === 'developer' ? DEFAULT_DEVELOPER_DG_ORIGIN : DEFAULT_DEMO_DG_ORIGIN

  if (configured === undefined) {
    return fallback
  }

  if (!isRecord(configured) || typeof configured.origin !== 'string') {
    throw new DgConfigError('DG_CONFIG_INVALID', `degram.json dgTargets.${mode} must be an object with an origin string.`)
  }

  return configured.origin
}

/** Validate the v2 descriptor map while allowing either target to retain its safe default. */
export function configuredDgTargets(config: Pick<DegramJson, 'dgTargets'>): Record<DgTargetMode, DgTargetDescriptor> {
  const rawTargets: unknown = config.dgTargets

  if (rawTargets !== undefined && !isRecord(rawTargets)) {
    throw new DgConfigError('DG_CONFIG_INVALID', 'degram.json dgTargets must be an object.')
  }

  const targets: TargetOriginRecord = (rawTargets ?? {}) as TargetOriginRecord

  return {
    developer: descriptorForDgTarget('developer', configuredOrigin('developer', targets.developer)),
    demo: descriptorForDgTarget('demo', configuredOrigin('demo', targets.demo))
  }
}

function selectedMode(config: DegramJson): DgTargetMode {
  if (config.activeDgTarget === undefined) {
    return 'developer'
  }

  const mode = targetMode(config.activeDgTarget)

  if (!mode) {
    throw new DgConfigError('DG_CONFIG_INVALID', 'degram.json activeDgTarget must be "developer" or "demo".')
  }

  return mode
}

function hasV2TargetSelection(config: DegramJson): boolean {
  if (config.schemaVersion !== undefined && config.schemaVersion !== 2) {
    throw new DgConfigError('DG_CONFIG_INVALID', 'degram.json schemaVersion must be 2 for DGMODE target settings.')
  }

  return config.schemaVersion === 2 || config.activeDgTarget !== undefined || config.dgTargets !== undefined
}

function descriptorMatchingOrigin(targets: Record<DgTargetMode, DgTargetDescriptor>, origin: string): DgTargetDescriptor | null {
  for (const target of Object.values(targets)) {
    if (target.origin === origin) {
      return target
    }
  }

  return null
}

function legacyDescriptor(origin: string): DgTargetDescriptor {
  const canonical: string | null = normalizeDgOrigin(origin)

  if (!canonical) {
    throw new DgConfigError('DG_ORIGIN_INVALID', 'Legacy degram.json dgOrigin must be a bare http(s) origin without path or query.')
  }

  const url = new URL(canonical)

  if (isLoopbackHost(url.hostname)) {
    return descriptorForDgTarget('developer', canonical)
  }

  if (url.protocol === 'https:') {
    return descriptorForDgTarget('demo', canonical)
  }

  throw new DgConfigError(
    'DG_ORIGIN_INVALID',
    'Legacy remote HTTP dgOrigin cannot be migrated. Repair degram.json with an HTTPS Demo target or a loopback Developer target.'
  )
}

/**
 * Resolve selected target intent plus an optional explicit launch override. A process override is
 * intentionally not a free-form routing escape hatch: it must name one configured target exactly.
 */
export function resolveDgTarget(deps: DgConfigDeps): ResolvedDgTarget {
  const config = readDegramJson(deps)
  const targets = configuredDgTargets(config)
  const selected = selectedMode(config)
  const envValue = deps.env.DEGRAM_DG_ORIGIN?.trim()

  if (envValue) {
    const origin: string | null = normalizeDgOrigin(envValue)

    if (!origin) {
      throw new DgConfigError('DG_ORIGIN_INVALID', 'DEGRAM_DG_ORIGIN must be a bare http(s) origin without path or query.')
    }

    if (!hasV2TargetSelection(config) && config.dgOrigin) {
      const legacy = legacyDescriptor(config.dgOrigin)

      if (legacy.origin !== origin) {
        throw new DgConfigError(
          'DG_ORIGIN_INVALID',
          'DEGRAM_DG_ORIGIN conflicts with the legacy dgOrigin ownership claim. Repair or migrate degram.json before overriding the target.'
        )
      }
    }

    const matched = descriptorMatchingOrigin(targets, origin)

    if (!matched) {
      throw new DgConfigError(
        'DG_ORIGIN_INVALID',
        'DEGRAM_DG_ORIGIN must exactly match a configured Developer or Demo target. Remove the override and restart, or add the target to degram.json.'
      )
    }

    return { ...matched, selectedMode: selected, source: 'env', overrideActive: true }
  }

  if (hasV2TargetSelection(config)) {
    const effective = targets[selected]

    return { ...effective, selectedMode: selected, source: 'file', overrideActive: false }
  }

  if (config.dgOrigin) {
    const legacy = legacyDescriptor(config.dgOrigin)

    return { ...legacy, selectedMode: legacy.mode, source: 'legacy', overrideActive: false }
  }

  const fallback = targets.developer

  return { ...fallback, selectedMode: 'developer', source: 'default', overrideActive: false }
}
