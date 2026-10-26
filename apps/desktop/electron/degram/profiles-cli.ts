// profiles-cli.ts — Electron side of `python -m degram_variant.profiles` (Phase 1301-12, D-19).
//
// Scope profile creation and purge are owned by the agent package (plan 10); Electron only runs the CLI
// with the bundled interpreter. Arguments are an argv array (never a shell string), the CLI prints one
// JSON object on stdout, and a non-zero exit is an error whose text comes from the CLI's JSON on stderr.

import { createHash } from 'node:crypto'

import type { ScopeKey } from './scope'
import { environmentIdForOrigin } from './dg-target-config'
import { normalizeDgOrigin } from './dg-config'

export interface ProfileEnvironment {
  origin: string
  environmentId: string
}

export function validateProfileEnvironment(environment: ProfileEnvironment): void {
  if (normalizeDgOrigin(environment.origin) !== environment.origin ||
      environmentIdForOrigin(environment.origin) !== environment.environmentId) {
    throw new ProfilesCliError('environment', 'origin and environmentId do not match')
  }
}

/** Cross-language vector: UTF-8 dg-profile-v2/origin/user/company/project, separated by U+001F. */
export function profileNameForScope(scope: ScopeKey): string {
  validateProfileEnvironment(scope)
  const fields = [scope.user, scope.company ?? '', scope.project].map(value => value.trim())

  if (!fields[0] || !fields[2] || fields.some(value => value.includes('\x1f'))) {
    throw new ProfilesCliError('scope', 'invalid profile scope')
  }

  return `scope-${createHash('sha256').update(['dg-profile-v2', scope.origin, ...fields].join('\x1f'), 'utf8').digest('hex').slice(0, 32)}`
}

export interface ProfilesCliRun {
  code: number | null
  stdout: string
  stderr: string
}

export interface ProfilesCliDeps {
  /** Runs `<interpreter> <args...>` with the profile CLI's environment (bundled python, PYTHONPATH). */
  run: (args: string[]) => Promise<ProfilesCliRun>
  /** The fixed DeGram home (`--home`). */
  home: string
  environment: ProfileEnvironment
}

export class ProfilesCliError extends Error {
  constructor(command: string, detail: string) {
    super(`degram_variant.profiles ${command} failed: ${detail}`)
    this.name = 'ProfilesCliError'
  }
}

/**
 * Every value is bound to its flag as `--flag=value`: a scope value that comes from the DG server and happens
 * to look like an option (`--home=...`) stays a value, never a flag of its own.
 */
function argsFor(command: 'ensure' | 'purge', home: string, scope: ScopeKey): string[] {
  return [
    '-m',
    'degram_variant.profiles',
    command,
    `--home=${home}`,
    `--user=${scope.user}`,
    ...(scope.company ? [`--company=${scope.company}`] : []),
    `--project=${scope.project}`,
    `--origin=${scope.origin}`,
    `--environment-id=${scope.environmentId}`
  ]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '')
  } catch {
    return null
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  const parsed = parseJson(text)

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

/** What the one-time legacy cleanup did (D-30). */
export interface LegacyCleanupResult {
  ran: boolean
  backfilled: string[]
  removed: string[]
  failed: string[]
}

export interface ProfilesCli {
  ensure: (scope: ScopeKey) => Promise<{ profile: string }>
  purge: (scope: ScopeKey) => Promise<void>
  /** Remove every profile of `user` + `project` under any company key (the manifest names the owner, G-15). */
  purgeProject: (user: string, project: string) => Promise<string[]>
  migrateLegacy: (keep: ScopeKey[], stopBackend: (profile: string) => Promise<void>) => Promise<void>
  /** Inspect ambiguous legacy records after migration; never delete unowned state. */
  cleanupLegacy: (keep: ScopeKey[]) => Promise<LegacyCleanupResult>
}

export function createProfilesCli(deps: ProfilesCliDeps): ProfilesCli {
  validateProfileEnvironment(deps.environment)
  const environmentArgs = [`--origin=${deps.environment.origin}`, `--environment-id=${deps.environment.environmentId}`]
  const checkScope = (scope: ScopeKey): void => {
    validateProfileEnvironment(scope)
    if (scope.origin !== deps.environment.origin || scope.environmentId !== deps.environment.environmentId) {
      throw new ProfilesCliError('scope', 'scope belongs to another environment')
    }
  }
  const executeRaw = async (command: string, args: string[]): Promise<unknown> => {
    const result: ProfilesCliRun = await deps.run(args)

    if (result.code !== 0) {
      const detail = parseObject(result.stderr)?.error

      throw new ProfilesCliError(command, typeof detail === 'string' ? detail : `exit code ${result.code ?? 'unknown'}`)
    }

    const parsed = parseJson(result.stdout)

    if (parsed === null || typeof parsed !== 'object') {
      throw new ProfilesCliError(command, 'the CLI printed no JSON result')
    }

    return parsed
  }

  const execute = async (command: 'ensure' | 'purge', scope: ScopeKey): Promise<Record<string, unknown>> => {
    checkScope(scope)
    const parsed = await executeRaw(command, argsFor(command, deps.home, scope))

    if (Array.isArray(parsed)) {
      throw new ProfilesCliError(command, 'the CLI printed no JSON result')
    }

    return parsed as Record<string, unknown>
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

  return {
    ensure: async (scope: ScopeKey): Promise<{ profile: string }> => {
      const parsed = await execute('ensure', scope)

      if (typeof parsed.profile !== 'string' || !parsed.profile) {
        throw new ProfilesCliError('ensure', 'the CLI result has no profile name')
      }

      if (parsed.profile !== profileNameForScope(scope)) {
        throw new ProfilesCliError('ensure', 'the CLI profile does not match the requested environment scope')
      }

      return { profile: parsed.profile }
    },
    purge: async (scope: ScopeKey): Promise<void> => {
      await execute('purge', scope)
    },
    purgeProject: async (user: string, project: string): Promise<string[]> => {
      const parsed = await executeRaw('purge-project', [
        '-m',
        'degram_variant.profiles',
        'purge-project',
        `--home=${deps.home}`,
        `--user=${user}`,
        `--project=${project}`,
        ...environmentArgs
      ])

      return strings(parsed)
    },
    migrateLegacy: async (keep, stopBackend): Promise<void> => {
      keep.forEach(checkScope)
      const candidates = await executeRaw('migration-status', [
        '-m', 'degram_variant.profiles', 'migration-status', `--home=${deps.home}`, ...environmentArgs
      ])
      if (!Array.isArray(candidates) || candidates.some(name => typeof name !== 'string' || !/^scope-[a-f0-9]{16,32}$/.test(name))) {
        throw new ProfilesCliError('migration-status', 'invalid migration candidates')
      }
      for (const profile of candidates as string[]) {
        await stopBackend(profile)
      }
      // The CLI reads the durable legacy owner, not the currently selected target.
      await executeRaw('migrate', [
        '-m', 'degram_variant.profiles', 'migrate', `--home=${deps.home}`, ...environmentArgs,
        `--keep-json=${JSON.stringify(keep)}`, '--backend-stopped'
      ])
    },
    cleanupLegacy: async (keep: ScopeKey[]): Promise<LegacyCleanupResult> => {
      keep.forEach(checkScope)
      const parsed = (await executeRaw('cleanup-legacy', [
        '-m',
        'degram_variant.profiles',
        'cleanup-legacy',
        `--home=${deps.home}`,
        `--keep-json=${JSON.stringify(keep)}`,
        ...environmentArgs
      ])) as Record<string, unknown>

      return {
        ran: parsed.ran === true,
        backfilled: strings(parsed.backfilled),
        removed: strings(parsed.removed),
        failed: strings(parsed.failed)
      }
    }
  }
}

export interface ProfilesInterpreterInputs {
  /** The bundled agent payload (packaged build), or null. */
  payload: { storePython: string; repoDir: string; sitePackages: string } | null
  /** The resolved Hermes backend launch (`resolveHermesBackend([])`), or null. */
  backend: { command: string | null; args: string[]; env: NodeJS.ProcessEnv } | null
  /** `path.delimiter` of the host. */
  delimiter: string
  /** The scrubbed desktop backend environment the payload python runs with. */
  baseEnv: NodeJS.ProcessEnv
}

/**
 * Which interpreter runs `python -m degram_variant.profiles`: the bundled payload's python with the payload
 * code first on PYTHONPATH, or the python of a source checkout (a backend launched as `python -m ...`).
 * A launcher shim (a console script, not an interpreter) cannot run `-m`, so it yields null rather than a
 * command that would fail in a confusing way.
 */
export function resolveProfilesInvocation(
  inputs: ProfilesInterpreterInputs
): { command: string; env: NodeJS.ProcessEnv } | null {
  if (inputs.payload) {
    return {
      command: inputs.payload.storePython,
      env: {
        ...inputs.baseEnv,
        PYTHONPATH: [inputs.payload.repoDir, inputs.payload.sitePackages].join(inputs.delimiter)
      }
    }
  }

  const backend = inputs.backend

  if (backend?.command && backend.args[0] === '-m') {
    return { command: backend.command, env: backend.env }
  }

  return null
}
