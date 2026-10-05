// dg-config.ts — where DeGram finds the DG server and its agent-side helpers (Phase 1301-12, D-05/D-06).
//
// The DG origin comes from the environment (DEGRAM_DG_ORIGIN, an explicit run-time override) or from
// `<degram home>/degram.json` {dgOrigin}, defaulting to the local compose stack. Only a bare http(s)
// origin is accepted (no path, query, fragment or credentials) and an invalid value FAILS CLOSED: it is
// never replaced by the default, because a typo must not send a sign-in to a different server.
//
// Everything is pure and dependency-injected; the caller supplies file reads and existence checks.

import path from 'node:path'

/** The isolated Electron session partition of the DG sign-in and the embedded DG view (D-05, D-07).
 * Colon-free after `persist:` on purpose (see oauth-partition.ts: Electron escapes ':' in a partition name). */
export const DEGRAM_DG_PARTITION = 'persist:degram-dg'

export const DEFAULT_DG_ORIGIN = 'http://localhost:8080'

export type DgConfigErrorCode = 'DG_ORIGIN_INVALID' | 'DG_CONFIG_INVALID'

export class DgConfigError extends Error {
  readonly code: DgConfigErrorCode

  constructor(code: DgConfigErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'DgConfigError'
    this.code = code
  }
}

export interface DgConfigDeps {
  env: NodeJS.ProcessEnv
  /** The fixed DeGram home (isolation.ts `DegramPaths.home`). */
  home: string
  /** Returns the file text, or null when the file does not exist. */
  readFile: (file: string) => string | null
  platform?: NodeJS.Platform
  /** Filesystem existence probe (adapter interpreter / directory discovery). */
  exists?: (file: string) => boolean
  /** Electron `process.resourcesPath` (bundled `revit-mcp` lives beside the agent payload). */
  resourcesPath?: string
}

export interface DegramJson {
  dgOrigin?: string
  /** Interpreter that carries the Revit adapter's `mcp` 1.x (NOT the gateway interpreter). */
  revitPython?: string
  revitMcpDir?: string
}

function pathFor(platform: NodeJS.Platform | undefined): typeof path.win32 {
  return (platform ?? process.platform) === 'win32' ? path.win32 : path.posix
}

/** A bare http(s) origin (`scheme://host[:port]`), or null. */
export function normalizeDgOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    return null
  }

  return url.origin
}

/** `<home>/degram.json`, tolerant of a missing file, strict about a broken one. */
export function readDegramJson(deps: Pick<DgConfigDeps, 'home' | 'readFile' | 'platform'>): DegramJson {
  const file: string = pathFor(deps.platform).join(deps.home, 'degram.json')
  const text: string | null = deps.readFile(file)

  if (text === null) {
    return {}
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DgConfigError('DG_CONFIG_INVALID', `${file} is not valid JSON.`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DgConfigError('DG_CONFIG_INVALID', `${file} must hold a JSON object.`)
  }

  const record = parsed as Record<string, unknown>

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined

  return { dgOrigin: str(record.dgOrigin), revitPython: str(record.revitPython), revitMcpDir: str(record.revitMcpDir) }
}

export function resolveDgOrigin(deps: DgConfigDeps): { origin: string; source: 'env' | 'file' | 'default' } {
  const fromEnv: string | undefined = deps.env.DEGRAM_DG_ORIGIN?.trim()

  if (fromEnv) {
    const origin: string | null = normalizeDgOrigin(fromEnv)

    if (!origin) {
      throw new DgConfigError(
        'DG_ORIGIN_INVALID',
        'DEGRAM_DG_ORIGIN must be a bare http(s) origin without path or query.'
      )
    }

    return { origin, source: 'env' }
  }

  const fromFile: string | undefined = readDegramJson(deps).dgOrigin

  if (fromFile) {
    const origin: string | null = normalizeDgOrigin(fromFile)

    if (!origin) {
      throw new DgConfigError(
        'DG_ORIGIN_INVALID',
        'degram.json dgOrigin must be a bare http(s) origin without path or query.'
      )
    }

    return { origin, source: 'file' }
  }

  return { origin: DEFAULT_DG_ORIGIN, source: 'default' }
}

/** What the agent's `relayBaseUrl` is for an origin: origin + `/data-service`, WITHOUT `/degram/v1` (plan 10). */
export function relayBaseUrlFor(origin: string): string {
  return `${origin}/data-service`
}

/**
 * The Revit adapter launch inputs. `apps/revit-mcp/main.py` imports `mcp.server.fastmcp`, which the
 * gateway venv's `mcp` 2.x lacks (plan 11 finding), so the interpreter is NEVER derived from the gateway:
 * env DEGRAM_PYTHON, then `degram.json` revitPython, then the adapter's own uv environment under the
 * adapter directory when it exists. When none resolves the variable stays unset and the Revit group
 * reports setup-incomplete instead of launching the wrong interpreter.
 */
export function resolveRevitAdapter(deps: DgConfigDeps): { python?: string; mcpDir?: string } {
  const paths = pathFor(deps.platform)
  const exists: (file: string) => boolean = deps.exists ?? ((): boolean => false)
  const file: DegramJson = readDegramJson(deps)

  let mcpDir: string | undefined = deps.env.DEGRAM_REVIT_MCP_DIR?.trim() || file.revitMcpDir

  if (!mcpDir && deps.resourcesPath) {
    const bundled: string = paths.join(deps.resourcesPath, 'revit-mcp')

    mcpDir = exists(bundled) ? bundled : undefined
  }

  let python: string | undefined = deps.env.DEGRAM_PYTHON?.trim() || file.revitPython

  if (!python && mcpDir) {
    const venvPython: string =
      (deps.platform ?? process.platform) === 'win32'
        ? paths.join(mcpDir, '.venv', 'Scripts', 'python.exe')
        : paths.join(mcpDir, '.venv', 'bin', 'python')

    python = exists(venvPython) ? venvPython : undefined
  }

  return { ...(python ? { python } : {}), ...(mcpDir ? { mcpDir } : {}) }
}

/**
 * The environment every DeGram agent backend is spawned with (D-01/D-02): the variant switch, the fixed
 * degram home, and the adapter launch inputs when they resolve. Spread into the backend spawn env.
 */
export function degramBackendEnv(deps: DgConfigDeps): Record<string, string> {
  const adapter = resolveRevitAdapter(deps)

  return {
    HERMES_DEGRAM: '1',
    HERMES_HOME: deps.home,
    ...(adapter.python ? { DEGRAM_PYTHON: adapter.python } : {}),
    ...(adapter.mcpDir ? { DEGRAM_REVIT_MCP_DIR: adapter.mcpDir } : {})
  }
}
