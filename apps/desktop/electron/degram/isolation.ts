// isolation.ts — DeGram runtime isolation (Phase 1301, D-01/D-02).
//
// DeGram is a separate product from an installed Hermes. Its home and userData
// are FIXED under %LOCALAPPDATA%\DeGram: HERMES_HOME (process env or Windows
// registry), HERMES_DESKTOP_USER_DATA_DIR, HERMES_DATA_DIR_SUFFIX and the
// legacy ~/.hermes migration are never consulted to choose them. Those same
// sources are only read as *overlap candidates*: if the fixed DeGram home
// equals, contains, or lies inside any Hermes home candidate the boot fails
// closed with a named diagnostic and never falls back to another home.
//
// Everything here is pure and dependency-injected (no Electron, no fs, no
// registry reads unless the caller supplies a reader), so the whole contract is
// proven offline by isolation.test.ts.

import path from 'node:path'

export type DegramIsolationCode = 'HOME_OVERLAP'

export class DegramIsolationError extends Error {
  readonly code: DegramIsolationCode
  /** The Hermes home candidate (normalized) that the DeGram path collides with. */
  readonly path: string
  /** The DeGram path (home, userData or root) that collides. */
  readonly degramPath: string

  constructor(code: DegramIsolationCode, hermesPath: string, degramPath: string, relation: string) {
    super(
      `DeGram refuses to start: ${code}: DeGram path "${degramPath}" ${relation} the Hermes home "${hermesPath}". ` +
        'DeGram never shares a home with Hermes; it did not fall back to another location.'
    )
    this.name = 'DegramIsolationError'
    this.code = code
    this.path = hermesPath
    this.degramPath = degramPath
  }
}

export interface DegramPathInputs {
  /** Process environment. Read only for LOCALAPPDATA and the overlap candidates. */
  env: NodeJS.ProcessEnv
  /** %LOCALAPPDATA% (or the platform equivalent). Defaults from env/homedir. */
  localAppData?: string
  /** User-scoped registry HERMES_HOME. Consulted for overlap candidates only. */
  readRegistry?: () => string | null
  homedir: string
  platform?: NodeJS.Platform
}

export interface DegramPaths {
  /** %LOCALAPPDATA%\DeGram */
  root: string
  /** The fixed runtime home (what HERMES_HOME is pinned to for the backend). */
  home: string
  /** The fixed Electron userData directory (also owns the single-instance lock). */
  userData: string
}

function pathModule(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function localBase(inputs: DegramPathInputs, paths: typeof path.win32): string {
  const platform: NodeJS.Platform = inputs.platform ?? process.platform

  if (inputs.localAppData) {
    return inputs.localAppData
  }

  if (platform === 'win32') {
    return (inputs.env.LOCALAPPDATA || '').trim() || paths.join(inputs.homedir, 'AppData', 'Local')
  }

  return paths.join(inputs.homedir, '.local', 'share')
}

/** The fixed DeGram paths. Never reads the registry, the filesystem, or any Hermes home selector. */
export function resolveDegramPaths(inputs: DegramPathInputs): DegramPaths {
  const paths: typeof path.win32 = pathModule(inputs.platform ?? process.platform)
  const root: string = paths.join(localBase(inputs, paths), 'DeGram')

  return { root, home: paths.join(root, 'home'), userData: paths.join(root, 'userData') }
}

/** A HERMES_HOME rooted inside `profiles/` names the profile's parent (the home). Mirrors data-paths.mjs. */
function normalizeHomeRoot(value: string, paths: typeof path.win32): string {
  const resolved: string = paths.resolve(value)
  const parent: string = paths.dirname(resolved)

  return paths.basename(parent).toLowerCase() === 'profiles' ? paths.dirname(parent) : resolved
}

/** Every location a Hermes install could use as its home, as normalized paths. */
export function hermesHomeCandidates(inputs: DegramPathInputs): string[] {
  const platform: NodeJS.Platform = inputs.platform ?? process.platform
  const paths: typeof path.win32 = pathModule(platform)
  const suffix: string = inputs.env.HERMES_DATA_DIR_SUFFIX || ''
  const candidates: string[] = []

  const add = (value: string | null | undefined): void => {
    if (value && value.trim()) {
      candidates.push(normalizeHomeRoot(value.trim(), paths))
    }
  }

  add(inputs.env.HERMES_HOME)

  if (platform === 'win32') {
    try {
      add(inputs.readRegistry?.())
    } catch {
      // An unreadable registry cannot name a candidate; the fixed home never depended on it.
    }

    const base: string = (inputs.env.LOCALAPPDATA || '').trim() || paths.join(inputs.homedir, 'AppData', 'Local')
    add(paths.join(base, 'hermes'))

    if (suffix) {
      add(paths.join(base, 'hermes') + suffix)
    }
  } else if (suffix) {
    add(paths.join(inputs.homedir, '.hermes') + suffix)
  }

  add(paths.join(inputs.homedir, '.hermes'))

  return candidates
}

function comparable(value: string, paths: typeof path.win32, platform: NodeJS.Platform): string {
  const resolved: string = paths.resolve(value)

  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function relation(a: string, b: string, paths: typeof path.win32): 'equals' | 'is inside' | 'contains' | null {
  if (a === b) {
    return 'equals'
  }

  const within = (child: string, parent: string): boolean => {
    const rel: string = paths.relative(parent, child)

    return rel !== '' && !rel.startsWith('..') && !paths.isAbsolute(rel)
  }

  if (within(a, b)) {
    return 'is inside'
  }

  return within(b, a) ? 'contains' : null
}

/**
 * Fail closed when any DeGram path (root, home, userData) equals, lies inside,
 * or contains a Hermes home candidate. Comparison is case-insensitive on
 * Windows and independent of separators and trailing slashes.
 */
export function assertNoHermesOverlap(paths: DegramPaths, inputs: DegramPathInputs): void {
  const platform: NodeJS.Platform = inputs.platform ?? process.platform
  const mod: typeof path.win32 = pathModule(platform)

  for (const degramPath of [paths.home, paths.userData, paths.root]) {
    const left: string = comparable(degramPath, mod, platform)

    for (const candidate of hermesHomeCandidates(inputs)) {
      const how: ReturnType<typeof relation> = relation(left, comparable(candidate, mod, platform), mod)

      if (how) {
        throw new DegramIsolationError('HOME_OVERLAP', candidate, degramPath, how)
      }
    }
  }
}

/**
 * OS protocol handler names. DeGram owns `degram://` (and `degram-dev://` for a
 * dev server) so it can never claim or answer a Hermes `hermes://` link.
 */
export function deepLinkProtocols(
  identity: { degram?: boolean },
  devServer: boolean
): { primary: string; accepted: string[] } {
  if (identity.degram) {
    return devServer
      ? { primary: 'degram-dev', accepted: ['degram-dev', 'degram'] }
      : { primary: 'degram', accepted: ['degram'] }
  }

  return devServer
    ? { primary: 'hermes-dev', accepted: ['hermes-dev', 'hermes'] }
    : { primary: 'hermes', accepted: ['hermes'] }
}

/** The "Check for Updates…" menu entries: DeGram has no update channel (D-03), so none. */
export function updateMenuEntries<T>(identity: { degram?: boolean }, entry: T): T[] {
  return identity.degram ? [] : [entry]
}

/** DeGram never attaches to a host Hermes backend; other variants keep the env opt-in. */
export function isolatedBackendRequired(identity: { degram?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return identity.degram === true || env.HERMES_DESKTOP_ISOLATED_BACKEND === '1'
}

/**
 * The process env DeGram runs with: HERMES_HOME pinned to the fixed home (so
 * every child and every `process.env.HERMES_HOME` reader inherits it), the
 * backend isolated, and the inherited home selectors removed. Pure: returns a copy.
 */
export function degramProcessEnv(env: NodeJS.ProcessEnv, paths: DegramPaths): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.HERMES_DESKTOP_USER_DATA_DIR
  delete next.HERMES_DATA_DIR_SUFFIX
  next.HERMES_HOME = paths.home
  next.HERMES_DESKTOP_ISOLATED_BACKEND = '1'

  return next
}
