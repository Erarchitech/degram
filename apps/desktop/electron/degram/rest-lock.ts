// The DeGram REST lock, renderer side (Phase 1301, F-06). The backend answers every /api/* and
// /dashboard-plugins/* path outside ALLOWED_REST_PATHS with 403 DEGRAM_LOCKED
// (degram_variant/lockdown.py prune_rest_routes). Upstream renderer pollers keep asking for those
// paths, and Electron logs a full stack for every rejected `hermes:api` invoke, so the preload
// answers a locked path itself with the same "403: <body>" rejection and sends nothing.
// Keep DEGRAM_ALLOWED_REST_PATHS in step with ALLOWED_REST_PATHS in lockdown.py.

export const DEGRAM_ALLOWED_REST_PATHS: ReadonlySet<string> = new Set(['/api/ws', '/api/health', '/api/status'])

function pathnameOf(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return null
  }

  try {
    return new URL(path, 'http://degram.invalid').pathname
  } catch {
    return null
  }
}

export function degramRestLocked(path: unknown): boolean {
  const pathname = pathnameOf(path)

  if (pathname === null || DEGRAM_ALLOWED_REST_PATHS.has(pathname)) {
    return false
  }

  return pathname.startsWith('/api/') || pathname.startsWith('/dashboard-plugins/')
}

export function degramLockedApiError(path: string): Error {
  const pathname = pathnameOf(path) ?? path

  return new Error(
    `403: ${JSON.stringify({ detail: { code: 'DEGRAM_LOCKED', message: `${pathname} is not available in DeGram` } })}`
  )
}
