// Per-scope history list for the DeGram sidebar (D-31).  The gateway selected
// by scope-route owns exactly one project profile, so session.list cannot scan
// another project or use a locked REST endpoint.

import type { SessionInfo } from '@/types/hermes'

import type { DegramState } from '../../electron/degram/ipc'

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

/** Map gateway compact rows to the sidebar shape without disclosing backend identity fields. */
function mapRow(value: unknown): SessionInfo | null {
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
  if (state && state.scope.status === 'ready' && routeDisagreesWithScope(state, route)) {
    return { failed: true, sessions: [] }
  }

  try {
    const response = await requester.request<SessionListResponse>('session.list', {
      include_hidden: false,
      limit: Math.max(1, limit)
    })

    if (failedOutcome(response)) {
      return { failed: true, sessions: [] }
    }

    const rows = Array.isArray(response.sessions) ? response.sessions : []

    return { sessions: rows.map(mapRow).filter((row): row is SessionInfo => row !== null) }
  } catch {
    return { failed: true, sessions: [] }
  }
}
