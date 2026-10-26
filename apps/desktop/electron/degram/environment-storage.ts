// environment-storage.ts — lossless DGMODE settings and legacy partition ownership (Phase 1301-42).
//
// Electron state remains in its existing partitions. This module only records which canonical
// origin is allowed to retain the old shared partition; it never copies cookies or deletes state.

import path from 'node:path'

import {
  DEFAULT_DEMO_DG_ORIGIN,
  DEFAULT_DEVELOPER_DG_ORIGIN,
  descriptorForDgTarget,
  partitionForEnvironment,
  type DgTargetDescriptor,
  type DgTargetMode,
  validateDgTargetOrigin
} from './dg-target-config'
import { DgConfigError, normalizeDgOrigin } from './dg-config'

export const ENVIRONMENT_SETTINGS_SCHEMA_VERSION = 2
export const LEGACY_PARTITION_JOURNAL_VERSION = 1
export const LEGACY_DG_PARTITION = 'persist:degram-dg'

export interface EnvironmentStorageDeps {
  configFile: string
  journalFile: string
  readFile: (file: string) => string | null
  writeFile: (file: string, text: string) => void
  replaceFile: (temporaryFile: string, destinationFile: string) => void
  temporaryFileFor: (destinationFile: string) => string
  platform?: NodeJS.Platform
}

export interface DgTargetSettings {
  schemaVersion: 2
  activeDgTarget: DgTargetMode
  dgTargets: Record<DgTargetMode, { origin: string }>
}

export interface LegacyPartitionOwnership {
  version: 1
  origin: string
  partition: typeof LEGACY_DG_PARTITION
  stage: 'claimed' | 'adopted'
}

export interface EnvironmentTargetState {
  selected: DgTargetDescriptor
  /** Plan 44 fills this once a target runtime has been constructed. */
  effectiveRuntime: DgTargetDescriptor | null
}

function pathFor(platform: NodeJS.Platform | undefined): typeof path.win32 {
  return (platform ?? process.platform) === 'win32' ? path.win32 : path.posix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(text: string, file: string): Record<string, unknown> {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DgConfigError('DG_CONFIG_INVALID', `${file} is not valid JSON; it was not overwritten.`)
  }

  if (!isRecord(parsed)) {
    throw new DgConfigError('DG_CONFIG_INVALID', `${file} must hold a JSON object; it was not overwritten.`)
  }

  return parsed
}

function readJsonObject(deps: Pick<EnvironmentStorageDeps, 'readFile'>, file: string): Record<string, unknown> {
  const text = deps.readFile(file)

  return text === null ? {} : parseJsonObject(text, file)
}

function sameDirectory(deps: EnvironmentStorageDeps, left: string, right: string): boolean {
  const paths = pathFor(deps.platform)

  return paths.dirname(left).toLowerCase() === paths.dirname(right).toLowerCase()
}

/**
 * Replace a JSON object only after it has been fully serialized to a sibling temporary file.
 * A malformed source is rejected before any write, and source contents remain untouched if a
 * temporary write or replace fails.
 */
export function updateJsonAtomically(
  deps: EnvironmentStorageDeps,
  destinationFile: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const current = readJsonObject(deps, destinationFile)
  const next = update({ ...current })

  if (!isRecord(next)) {
    throw new DgConfigError('DG_CONFIG_INVALID', 'Settings update must produce a JSON object.')
  }

  const temporaryFile = deps.temporaryFileFor(destinationFile)

  if (!sameDirectory(deps, temporaryFile, destinationFile)) {
    throw new DgConfigError('DG_CONFIG_INVALID', 'Atomic settings temporary file must be in the destination directory.')
  }

  deps.writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`)
  deps.replaceFile(temporaryFile, destinationFile)

  return next
}

/** Losslessly store target intent; reachability is intentionally not part of this write. */
export function persistDgTargetSettings(
  deps: EnvironmentStorageDeps,
  activeDgTarget: DgTargetMode,
  targets: Record<DgTargetMode, DgTargetDescriptor>
): DgTargetSettings {
  const next = updateJsonAtomically(deps, deps.configFile, current => ({
    ...current,
    schemaVersion: ENVIRONMENT_SETTINGS_SCHEMA_VERSION,
    activeDgTarget,
    dgTargets: {
      developer: { origin: targets.developer.origin },
      demo: { origin: targets.demo.origin }
    }
  }))

  return next as unknown as DgTargetSettings
}

function parseOwnership(raw: Record<string, unknown>, file: string): LegacyPartitionOwnership {
  if (
    raw.version !== LEGACY_PARTITION_JOURNAL_VERSION ||
    typeof raw.origin !== 'string' ||
    raw.partition !== LEGACY_DG_PARTITION ||
    (raw.stage !== 'claimed' && raw.stage !== 'adopted')
  ) {
    throw new DgConfigError('DG_CONFIG_INVALID', `${file} has an invalid legacy partition ownership record.`)
  }

  const origin = validateDgTargetOrigin('developer', raw.origin)

  return { version: LEGACY_PARTITION_JOURNAL_VERSION, origin, partition: LEGACY_DG_PARTITION, stage: raw.stage }
}

export function readLegacyPartitionOwnership(
  deps: Pick<EnvironmentStorageDeps, 'readFile' | 'journalFile'>
): LegacyPartitionOwnership | null {
  const text = deps.readFile(deps.journalFile)

  if (text === null) {
    return null
  }

  return parseOwnership(parseJsonObject(text, deps.journalFile), deps.journalFile)
}

function writeOwnership(deps: EnvironmentStorageDeps, ownership: LegacyPartitionOwnership): LegacyPartitionOwnership {
  updateJsonAtomically(deps, deps.journalFile, () => ({ ...ownership }))

  return ownership
}

/**
 * Write the ownership claim before allowing the legacy alias to be used. Repeated calls and a
 * restart after the claim are safe: the same origin resumes, a different origin is refused.
 */
export function claimLegacyPartitionOwnership(
  deps: EnvironmentStorageDeps,
  origin: string
): LegacyPartitionOwnership {
  const canonical = validateDgTargetOrigin('developer', origin)
  const existing = readLegacyPartitionOwnership(deps)

  if (existing) {
    if (existing.origin !== canonical) {
      throw new DgConfigError(
        'DG_CONFIG_INVALID',
        `The legacy ${LEGACY_DG_PARTITION} partition belongs to ${existing.origin}; it cannot be reassigned to ${canonical}.`
      )
    }

    return existing
  }

  return writeOwnership(deps, {
    version: LEGACY_PARTITION_JOURNAL_VERSION,
    origin: canonical,
    partition: LEGACY_DG_PARTITION,
    stage: 'claimed'
  })
}

/** Mark a prior durable claim as adopted after the caller has bound the legacy alias. */
export function markLegacyPartitionAdopted(
  deps: EnvironmentStorageDeps,
  origin: string
): LegacyPartitionOwnership {
  const existing = claimLegacyPartitionOwnership(deps, origin)

  if (existing.stage === 'adopted') {
    return existing
  }

  return writeOwnership(deps, { ...existing, stage: 'adopted' })
}

/**
 * The old partition is usable only by its durably recorded loopback owner. Every other target,
 * including Demo, receives an origin-derived partition. Cookie copying is intentionally absent.
 */
export function partitionForTarget(deps: Pick<EnvironmentStorageDeps, 'readFile' | 'journalFile'>, target: DgTargetDescriptor): string {
  const ownership = readLegacyPartitionOwnership(deps)

  if (target.mode === 'developer' && ownership?.origin === target.origin) {
    return LEGACY_DG_PARTITION
  }

  return partitionForEnvironment(target.environmentId)
}

/**
 * Determine whether a legacy config can safely claim the legacy localhost partition. This is a
 * pure policy check: callers persist the claim before using the alias.
 */
export function legacyOriginForAdoption(
  legacyDgOrigin: unknown,
  explicitOrigin: unknown = undefined
): string | null {
  const configured = legacyDgOrigin === undefined ? DEFAULT_DEVELOPER_DG_ORIGIN : normalizeDgOrigin(legacyDgOrigin)

  if (!configured) {
    throw new DgConfigError('DG_ORIGIN_INVALID', 'Legacy dgOrigin must be a bare http(s) origin before partition adoption.')
  }

  const developer = descriptorForDgTarget('developer', configured)
  const override = explicitOrigin === undefined ? null : normalizeDgOrigin(explicitOrigin)

  if (explicitOrigin !== undefined && !override) {
    throw new DgConfigError('DG_ORIGIN_INVALID', 'DEGRAM_DG_ORIGIN must be a bare http(s) origin before partition adoption.')
  }

  if (override && override !== developer.origin) {
    throw new DgConfigError(
      'DG_CONFIG_INVALID',
      'DEGRAM_DG_ORIGIN conflicts with legacy partition ownership. Repair the configuration before migration.'
    )
  }

  return developer.origin
}

/** A selected target may be persisted while no runtime is effective after a failed switch. */
export function selectedTargetState(selected: DgTargetDescriptor, effectiveRuntime: DgTargetDescriptor | null = null): EnvironmentTargetState {
  return { selected, effectiveRuntime }
}

export const DEFAULT_DG_TARGET_ORIGINS = {
  developer: DEFAULT_DEVELOPER_DG_ORIGIN,
  demo: DEFAULT_DEMO_DG_ORIGIN
} as const
