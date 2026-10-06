// dg-session.ts — the DG HTTP session as Electron main sees it (Phase 1301-12, D-05/D-06/D-08).
//
// DG authentication lives in the `dg_session` cookie of the isolated partition `persist:degram-dg`; the
// user signs in through the real DG login page (dg-view.ts), never through a form of DeGram's own.
// This module only talks to the DG data-service through that same partition:
//
//   GET  /data-service/auth/me              signed-in detection, memberships, heartbeat
//   POST /data-service/auth/delegated-token mint the 15-minute agent token (cookie + X-DG-CSRF: 1)
//   POST /data-service/auth/logout          end the DG session
//   POST /data-service/auth/degram/exchange trade the stored pairing token for the same agent token
//
// Phase 1301-17 (D-25, D-27): when a DeGram pairing token is stored (pairing-store.ts), `mint` exchanges
// it with `Authorization: Bearer dgp_...` instead of the cookie mint; the DG sign-in itself stays (D-27).
// A revoked pairing clears the store and reports `pairing-revoked`, never a silent cookie fallback, and a
// pairing of another user than the signed-in one is refused.
//
// The delegated token returned by a mint is handed to the caller and never stored here, logged, or put
// in the state object. Nor is the pairing token. Everything outside this file is injected so the suite
// runs without Electron.

import { DEGRAM_DG_PARTITION } from './dg-config'

/** Seconds between delegated-token renewals while a scope is open (token TTL is 900 s). */
export const DEGRAM_TOKEN_RENEW_S = 600
/** Seconds between `/auth/me` heartbeats while signed in. */
export const DEGRAM_HEARTBEAT_S = 60

const CSRF_HEADER = 'X-DG-CSRF'

export interface PartitionRequest {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: string
}

export interface PartitionResponse {
  status: number
  body: string
}

/** A request through the DG partition. Rejects only on a network-level failure (never on an HTTP status). */
export type PartitionFetch = (request: PartitionRequest) => Promise<PartitionResponse>

export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface Clock {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: any) => void
}

export interface Membership {
  project: string
  role: string
  company: string | null
}

export type AuthKind = 'unknown' | 'signed-out' | 'signed-in' | 'unreachable'

export interface AuthState {
  kind: AuthKind
  username: string | null
  isAdmin: boolean
  memberships: Membership[]
}

export type MeResult =
  | { kind: 'signed-in'; username: string; isAdmin: boolean; memberships: Membership[] }
  | { kind: 'signed-out'; status: number }
  | { kind: 'unreachable' }

export type MintSource = 'session' | 'pairing'

export type MintResult =
  | { kind: 'ok'; token: string; expiresAt: string; project: string; company: string | null; source: MintSource }
  | { kind: 'signed-out'; status: number }
  | { kind: 'pairing-revoked' }
  | { kind: 'forbidden'; status: number; code: string | null }
  | { kind: 'unreachable' }
  | { kind: 'error'; status: number; code: string | null }

/**
 * `none`: no pairing stored. `stored`: stored, not exchanged yet. `connected`: the last exchange succeeded.
 * `revoked`: DG refused the pairing (the store was cleared). `mismatch`: it belongs to another DG user.
 */
export type PairingStatus = 'none' | 'stored' | 'connected' | 'revoked' | 'mismatch'

export interface PairingView {
  status: PairingStatus
  /** The company of the last successful exchange. */
  company: string | null
}

/** The part of pairing-store.ts the session reads. */
export interface PairingSource {
  get: () => string | null
  clear: () => void
}

export interface DgSession {
  state: () => AuthState
  refresh: () => Promise<MeResult>
  mint: (project: string) => Promise<MintResult>
  pairing: () => PairingView
  /** Re-read whether a pairing is stored (after the runtime set or cleared it). */
  notePairingChanged: () => void
  onPairing: (listener: (view: PairingView) => void) => () => void
  logout: () => Promise<void>
  /** Forget the sign-in locally (a 401 was observed, or logout ran). */
  markSignedOut: () => void
  onAuth: (listener: (state: AuthState) => void) => () => void
}

export interface DgSessionDeps {
  origin: string
  fetch: PartitionFetch
  clock: Clock
  logger: Logger
  /** The stored DeGram pairing (Phase 1301-17). Absent: the cookie mint only. */
  pairing?: PairingSource
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** The server error code from `{detail:{code}}` (FastAPI wrapping) or a flat `{code}`. */
function errorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null
  }

  const record = body as { detail?: unknown; code?: unknown }
  const detail = record.detail && typeof record.detail === 'object' ? (record.detail as { code?: unknown }) : null
  const code: unknown = detail?.code ?? record.code

  return typeof code === 'string' ? code : null
}

function parseMemberships(value: unknown): Membership[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const out: Membership[] = []

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return null
    }

    const row = item as { project?: unknown; role?: unknown; company?: unknown }

    if (typeof row.project !== 'string' || !row.project || typeof row.role !== 'string') {
      return null
    }

    out.push({ project: row.project, role: row.role, company: typeof row.company === 'string' ? row.company : null })
  }

  return out
}

const EMPTY: AuthState = { kind: 'signed-out', username: null, isAdmin: false, memberships: [] }

export function createDgSession(deps: DgSessionDeps): DgSession {
  const { origin, logger } = deps
  let state: AuthState = { kind: 'unknown', username: null, isAdmin: false, memberships: [] }
  const listeners = new Set<(next: AuthState) => void>()
  let inFlight: Promise<MeResult> | null = null
  const pairingListeners = new Set<(view: PairingView) => void>()
  let pairingView: PairingView = { status: deps.pairing?.get() ? 'stored' : 'none', company: null }

  const setPairing = (next: PairingView): void => {
    if (next.status === pairingView.status && next.company === pairingView.company) {
      return
    }

    pairingView = next

    for (const listener of [...pairingListeners]) {
      listener(pairingView)
    }
  }

  const setState = (next: AuthState): void => {
    state = next

    for (const listener of [...listeners]) {
      listener(state)
    }
  }

  const url = (suffix: string): string => `${origin}/data-service${suffix}`

  const doRefresh = async (): Promise<MeResult> => {
    let response: PartitionResponse

    try {
      response = await deps.fetch({ method: 'GET', url: url('/auth/me') })
    } catch {
      logger.warn('[degram] DG unreachable during /auth/me')
      setState({ ...state, kind: 'unreachable' })

      return { kind: 'unreachable' }
    }

    if (response.status === 401 || response.status === 403) {
      setState({ ...EMPTY })

      return { kind: 'signed-out', status: response.status }
    }

    if (response.status >= 500 || response.status === 404 || response.status === 429) {
      logger.warn(`[degram] /auth/me answered ${response.status}`)
      setState({ ...state, kind: 'unreachable' })

      return { kind: 'unreachable' }
    }

    const body = parseJson(response.body) as { username?: unknown; isAdmin?: unknown; memberships?: unknown } | null
    const memberships: Membership[] | null = response.status === 200 && body ? parseMemberships(body.memberships) : null

    if (response.status !== 200 || !body || typeof body.username !== 'string' || !body.username || !memberships) {
      setState({ ...EMPTY })

      return { kind: 'signed-out', status: response.status }
    }

    const result = {
      kind: 'signed-in' as const,
      username: body.username,
      isAdmin: body.isAdmin === true,
      memberships
    }

    setState({ kind: 'signed-in', username: result.username, isAdmin: result.isAdmin, memberships })

    return result
  }

  const refresh = (): Promise<MeResult> => {
    if (inFlight) {
      return inFlight
    }

    inFlight = doRefresh().finally(() => {
      inFlight = null
    })

    return inFlight
  }

  /** Parse a 201 delegated-token answer; null when it is unusable. */
  const parseMinted = (
    body: unknown,
    project: string,
    source: MintSource
  ): Extract<MintResult, { kind: 'ok' }> | null => {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null

    if (
      !record ||
      typeof record.token !== 'string' ||
      !record.token.startsWith('dgd_') ||
      typeof record.expiresAt !== 'string' ||
      !record.expiresAt
    ) {
      return null
    }

    return {
      kind: 'ok',
      token: record.token,
      expiresAt: record.expiresAt,
      project: typeof record.project === 'string' ? record.project : project,
      company: typeof record.company === 'string' ? record.company : null,
      source
    }
  }

  const exchange = async (project: string, pairing: string): Promise<MintResult> => {
    let response: PartitionResponse

    try {
      response = await deps.fetch({
        method: 'POST',
        url: url('/auth/degram/exchange'),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing}` },
        body: JSON.stringify({ project })
      })
    } catch {
      logger.warn('[degram] DG unreachable during the pairing exchange')

      return { kind: 'unreachable' }
    }

    const body = parseJson(response.body)

    if (response.status === 401) {
      // Revoked on the Connectors tab, a password change, or the user is gone (D-25).
      deps.pairing?.clear()
      setPairing({ status: 'revoked', company: null })
      logger.warn('[degram] DG refused the stored pairing; it was removed')

      return { kind: 'pairing-revoked' }
    }

    if (response.status === 403) {
      return { kind: 'forbidden', status: 403, code: errorCode(body) }
    }

    if (response.status >= 500 || response.status === 429) {
      logger.warn(`[degram] the pairing exchange answered ${response.status}`)

      return { kind: 'unreachable' }
    }

    const minted = response.status === 201 || response.status === 200 ? parseMinted(body, project, 'pairing') : null

    if (!minted) {
      logger.warn(`[degram] the pairing exchange returned an unusable reply (${response.status})`)

      return { kind: 'error', status: response.status, code: errorCode(body) }
    }

    const owner = (body as { username?: unknown }).username

    if (typeof owner !== 'string' || !state.username || owner !== state.username) {
      // D-27 keeps the DG sign-in: the agent acts as the user DeGram shows, never as another one.
      setPairing({ status: 'mismatch', company: null })
      logger.warn('[degram] the stored pairing belongs to another DG user; it was not used')

      return { kind: 'error', status: response.status, code: 'PAIRING_USER_MISMATCH' }
    }

    setPairing({ status: 'connected', company: minted.company })

    return minted
  }

  const mint = async (project: string): Promise<MintResult> => {
    const pairing = deps.pairing?.get() ?? null

    if (pairing) {
      return exchange(project, pairing)
    }

    let response: PartitionResponse

    try {
      response = await deps.fetch({
        method: 'POST',
        url: url('/auth/delegated-token'),
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
        body: JSON.stringify({ project })
      })
    } catch {
      logger.warn('[degram] DG unreachable during delegated-token mint')

      return { kind: 'unreachable' }
    }

    const body = parseJson(response.body)

    if (response.status === 401) {
      return { kind: 'signed-out', status: 401 }
    }

    if (response.status === 403) {
      return { kind: 'forbidden', status: 403, code: errorCode(body) }
    }

    if (response.status >= 500) {
      logger.warn(`[degram] delegated-token mint answered ${response.status}`)

      return { kind: 'unreachable' }
    }

    const minted = response.status === 201 || response.status === 200 ? parseMinted(body, project, 'session') : null

    if (!minted) {
      logger.warn(`[degram] delegated-token mint returned an unusable reply (${response.status})`)

      return { kind: 'error', status: response.status, code: errorCode(body) }
    }

    return minted
  }

  const markSignedOut = (): void => {
    setState({ ...EMPTY })
  }

  const logout = async (): Promise<void> => {
    try {
      await deps.fetch({ method: 'POST', url: url('/auth/logout'), headers: { [CSRF_HEADER]: '1' } })
    } catch {
      logger.warn('[degram] DG unreachable during logout; the local session is cleared regardless')
    }

    markSignedOut()
  }

  return {
    state: (): AuthState => state,
    refresh,
    mint,
    logout,
    markSignedOut,
    pairing: (): PairingView => pairingView,
    notePairingChanged: (): void => {
      setPairing({ status: deps.pairing?.get() ? 'stored' : 'none', company: null })
    },
    onPairing: (listener): (() => void) => {
      pairingListeners.add(listener)

      return (): void => {
        pairingListeners.delete(listener)
      }
    },
    onAuth: (listener): (() => void) => {
      listeners.add(listener)

      return (): void => {
        listeners.delete(listener)
      }
    }
  }
}

// ─── Electron adapter: PartitionFetch on net.request ────────────────────────────────────────────────

export interface NetResponseLike {
  statusCode: number
  on: (event: string, listener: (...args: any[]) => void) => unknown
}

export interface NetRequestLike {
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => void
  end: () => void
  abort: () => void
  on: (event: string, listener: (...args: any[]) => void) => unknown
}

export interface NetLike {
  request: (options: Record<string, unknown>) => NetRequestLike
}

export interface CookieJarLike {
  cookies: { get: (filter: { url: string; name: string }) => Promise<{ name: string; value: string }[]> }
}

export type CookieMode = 'session' | 'explicit'

export interface NetPartitionFetchDeps {
  net: NetLike
  /** `session.fromPartition(DEGRAM_DG_PARTITION)`. */
  session: CookieJarLike
  /**
   * `session`: the partition cookie jar attaches the cookie (`useSessionCookies`).
   * `explicit`: the documented fallback when a SameSite=Strict `dg_session` is not attached to main-process
   * requests: read it with `session.cookies.get` and set the Cookie header ourselves. Both sit behind the
   * same `PartitionFetch`; plan 16's live check records which one DG needs.
   */
  cookieMode?: CookieMode
  timeoutMs?: number
  maxBytes?: number
}

const COOKIE_NAME = 'dg_session'

/** A PartitionFetch over Electron `net.request` bound to the DG partition. Never follows a redirect. */
export function createNetPartitionFetch(deps: NetPartitionFetchDeps): PartitionFetch {
  const mode: CookieMode = deps.cookieMode ?? 'session'
  const timeoutMs: number = deps.timeoutMs ?? 15_000
  const maxBytes: number = deps.maxBytes ?? 1_048_576

  return async (request: PartitionRequest): Promise<PartitionResponse> => {
    let cookieHeader: string | null = null

    if (mode === 'explicit') {
      const cookies = await deps.session.cookies.get({ url: request.url, name: COOKIE_NAME })

      cookieHeader = cookies.length > 0 ? `${COOKIE_NAME}=${cookies[0].value}` : null
    }

    return new Promise<PartitionResponse>((resolve, reject) => {
      const options: Record<string, unknown> = {
        method: request.method,
        url: request.url,
        partition: DEGRAM_DG_PARTITION,
        session: deps.session,
        redirect: 'error',
        ...(mode === 'session'
          ? { useSessionCookies: true, credentials: 'include' }
          : { useSessionCookies: false, credentials: 'omit' })
      }

      const req: NetRequestLike = deps.net.request(options)
      let settled = false

      const finish = (action: () => void): void => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          action()
        }
      }

      const timer = setTimeout(() => {
        finish(() => {
          req.abort()
          reject(new Error('DG request timed out'))
        })
      }, timeoutMs)

      timer.unref?.()

      for (const [name, value] of Object.entries(request.headers ?? {})) {
        req.setHeader(name, value)
      }

      if (cookieHeader) {
        req.setHeader('Cookie', cookieHeader)
      }

      req.on('response', (response: NetResponseLike) => {
        const chunks: Buffer[] = []
        let size = 0

        response.on('data', (chunk: Buffer) => {
          size += chunk.length

          if (size > maxBytes) {
            finish(() => {
              req.abort()
              reject(new Error('DG response too large'))
            })

            return
          }

          chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          finish(() => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        response.on('error', (error: Error) => finish(() => reject(error)))
      })
      req.on('error', (error: Error) => finish(() => reject(error)))
      req.on('abort', () => finish(() => reject(new Error('DG request aborted'))))

      if (request.body !== undefined) {
        req.write(request.body)
      }

      req.end()
    })
  }
}
