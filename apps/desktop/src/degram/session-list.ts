// Per-scope history list for the DeGram sidebar (D-31).  The gateway selected
// by scope-route owns exactly one project profile, so session.list cannot scan
// another project or use a locked REST endpoint.

import type { SessionInfo } from '@/types/hermes'

import type { DegramState } from '../../electron/degram/ipc'

import { isCurrentEnvironment } from './use-degram-state'

/** DeGram session-list module stays independent from the app profile store. */
export interface ScopeRoute {
  get: () => string | null
}

function routeDisagreesWithScope(state: DegramState | null | undefined, route: ScopeRoute): boolean {
  const scope = state?.scope

  return Boolean(scope?.status === 'ready' && (!scope.profile || route.get() !== scope.profile))
}

export interface ScopeSessionRequester {
  request: <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>
}

export interface ScopeSessionsResult {
  failed?: boolean
  sessions: SessionInfo[]
}

type SessionListResponse = { sessions?: unknown; status?: string }

function failedOutcome(response: SessionListResponse): boolean {
  return response.status !== undefined && response.status !== 'ok'
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableString(value: unknown): null | string {
  return typeof value === 'string' ? value : null
}

/**
 * Map gateway compact rows to the sidebar shape without disclosing backend identity fields.
 *
 * `profile` is the READY SCOPE's own profile (the renderer already holds it; never a field the backend sent): the
 * sidebar keeps only rows whose profile equals the active route (`filterSessionsByProfileScope`), and an untagged row
 * normalizes to `default`, so after any list wipe (leaving and re-opening a project) every stored session was
 * filtered out and the sidebar said «Сеансов пока нет» (F-04, 0.1.10).
 */
function mapRow(value: unknown, scopeProfile: null | string): SessionInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''

  if (!id) {
    return null
  }

  return {
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: number(row.last_active),
    message_count: number(row.message_count),
    model: null,
    output_tokens: 0,
    ...(scopeProfile ? { profile: scopeProfile } : {}),
    preview: nullableString(row.preview),
    source: null,
    started_at: number(row.started_at),
    title: nullableString(row.title),
    tool_call_count: 0
  }
}

/**
 * Read the active scope backend only. A ready scope whose selected chat route
 * still points elsewhere is a privacy boundary: do not issue a request.
 */
export async function listScopeSessions(
  limit: number,
  state: DegramState | null | undefined,
  route: ScopeRoute,
  requester: ScopeSessionRequester
): Promise<ScopeSessionsResult> {
  if (
    (state?.environment && !isCurrentEnvironment(state.environment)) ||
    (state && state.scope.status === 'ready' && routeDisagreesWithScope(state, route))
  ) {
    return { failed: true, sessions: [] }
  }

  try {
    const response = await requester.request<SessionListResponse>('session.list', {
      include_hidden: false,
      limit: Math.max(1, limit)
    })

    if (
      (state?.environment && !isCurrentEnvironment(state.environment)) ||
      routeDisagreesWithScope(state, route) ||
      failedOutcome(response)
    ) {
      return { failed: true, sessions: [] }
    }

    const rows = Array.isArray(response.sessions) ? response.sessions : []

    // The route agreed with the scope above (or there is no ready scope), so the rows are the scope profile's own.
    const scopeProfile = state?.scope.status === 'ready' ? (state.scope.profile ?? null) : null

    return { sessions: rows.map(row => mapRow(row, scopeProfile)).filter((row): row is SessionInfo => row !== null) }
  } catch {
    return { failed: true, sessions: [] }
  }
}
