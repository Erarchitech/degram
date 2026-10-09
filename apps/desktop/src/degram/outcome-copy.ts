// outcome-copy.ts — operational outcome code -> DeGram copy (Phase 1301-14, D-18).
//
// An operational outcome says how a call went (spec/degram/OPERATIONAL-OUTCOMES.md); it is never an evaluator
// verdict. Every code of that closed set has an entry here, so a failure always names its cause in the user's
// language. A turn failure reaches the renderer as text that carries the code (`CODE: message (reason: ...)`, or the
// stock failure wrapper around it — e.g. "Authentication failed: CREDENTIALS_EXPIRED: ..."), so the code is looked
// up anywhere in the text, earliest first.

import type { DegramCopy } from './i18n'
import type { BridgeApp } from './use-degram-gateway'

/** The closed set of spec/degram/OPERATIONAL-OUTCOMES.md (machine-checked against the spec by outcome-copy.test). */
export const OUTCOME_CODES = [
  'ACCESS_DENIED',
  'BRIDGE_OFF',
  'BUSY',
  'CANCELLED',
  'COMPLETED',
  'CONSENT_REQUIRED',
  'CREDENTIALS_EXPIRED',
  'CREDENTIALS_MISSING',
  'DEGRAM_LOCKED',
  'DG_UNAVAILABLE',
  'DOCUMENT_NOT_OPEN',
  'EXTENSION_NOT_LOADED',
  'IDENTITY_MISMATCH',
  'POLICY_DENY',
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'RELAY_NOT_CONFIGURED',
  'ROUTES_DISABLED',
  'ROUTES_NOT_LOOPBACK',
  'SCOPE_NOT_SUPPORTED',
  'SETUP_INCOMPLETE'
] as const

export type OutcomeCode = (typeof OUTCOME_CODES)[number]

/** Codes the agent and relay emit that are not in the vocabulary above but reach the user the same way. */
const EXTRA_CODES = [
  'CREDENTIALS_INVALID',
  'DELEGATED_AUTH_FAILED',
  'DELEGATED_EXPIRED',
  'DELEGATED_SCOPE_CHANGED',
  'DELEGATED_SESSION_ENDED',
  'CONTEXT_SCOPE_INVALID',
  'RELAY_BODY_TOO_LARGE',
  // Renderer-side refusal (plan 1301-18): the chat's route is not on the ready scope's profile. The composer is
  // blocked before it can show, so no closer copy exists.
  'ROUTE_MISMATCH',
  // Renderer-side (plan 1301-19): the preview RPC itself got no answer in time (the gateway, not the bridge, went
  // quiet). A busy bridge answers BUSY first; this names the case where nothing answered at all.
  'PREVIEW_TIMEOUT'
] as const

/** Codes main verifies against DG and acts on (re-mint, end the session, revoke): forwarded by `reportOutcome`. */
export const FORWARDED_TO_MAIN: readonly string[] = [
  'CREDENTIALS_EXPIRED',
  'DELEGATED_EXPIRED',
  'DELEGATED_AUTH_FAILED',
  'DELEGATED_SESSION_ENDED',
  'DELEGATED_SCOPE_CHANGED',
  'ACCESS_DENIED',
  // The scope's backend holds no credential: main re-hands it once per scope open (plan 1301-18, G-5).
  'CREDENTIALS_MISSING'
]

export type CopyKey =
  | 'empty.noDocuments'
  | 'errors.accessRevoked'
  | 'errors.consentRequired'
  | 'errors.credentialsMissing'
  | 'errors.credentialsRefresh'
  | 'errors.dgUnreachable'
  | 'errors.extensionNotLoaded'
  | 'errors.grasshopperBusy'
  | 'errors.grasshopperOff'
  | 'errors.limit'
  | 'errors.lockedAction'
  | 'errors.modelUnavailable'
  | 'errors.pinnedGone'
  | 'errors.policyDeny'
  | 'errors.revitBusy'
  | 'errors.revitOff'
  | 'errors.routesDisabled'
  | 'errors.routesNotLoopback'
  | 'errors.scopeNotSupported'
  | 'errors.sessionEnded'
  | 'errors.setupIncomplete'
  | 'errors.timeout'
  | 'errors.unknown'
  | 'none'

const CODE_COPY: Record<OutcomeCode | (typeof EXTRA_CODES)[number], CopyKey> = {
  ACCESS_DENIED: 'errors.accessRevoked',
  BRIDGE_OFF: 'errors.revitOff',
  BUSY: 'errors.revitBusy',
  CANCELLED: 'none',
  COMPLETED: 'none',
  CONSENT_REQUIRED: 'errors.consentRequired',
  CREDENTIALS_EXPIRED: 'errors.credentialsRefresh',
  CREDENTIALS_MISSING: 'errors.credentialsMissing',
  DEGRAM_LOCKED: 'errors.lockedAction',
  DG_UNAVAILABLE: 'errors.dgUnreachable',
  DOCUMENT_NOT_OPEN: 'errors.pinnedGone',
  EXTENSION_NOT_LOADED: 'errors.extensionNotLoaded',
  IDENTITY_MISMATCH: 'errors.pinnedGone',
  POLICY_DENY: 'errors.policyDeny',
  PROVIDER_ERROR: 'errors.modelUnavailable',
  PROVIDER_RATE_LIMITED: 'errors.limit',
  PROVIDER_TIMEOUT: 'errors.timeout',
  PROVIDER_UNAVAILABLE: 'errors.modelUnavailable',
  RELAY_NOT_CONFIGURED: 'errors.modelUnavailable',
  ROUTES_DISABLED: 'errors.routesDisabled',
  ROUTES_NOT_LOOPBACK: 'errors.routesNotLoopback',
  SCOPE_NOT_SUPPORTED: 'errors.scopeNotSupported',
  SETUP_INCOMPLETE: 'errors.setupIncomplete',
  // Not in the vocabulary: the agent's own credential/handoff codes and two relay refusals.
  CREDENTIALS_INVALID: 'errors.credentialsRefresh',
  DELEGATED_AUTH_FAILED: 'errors.credentialsRefresh',
  DELEGATED_EXPIRED: 'errors.credentialsRefresh',
  DELEGATED_SCOPE_CHANGED: 'errors.accessRevoked',
  DELEGATED_SESSION_ENDED: 'errors.sessionEnded',
  CONTEXT_SCOPE_INVALID: 'errors.unknown',
  RELAY_BODY_TOO_LARGE: 'errors.unknown',
  ROUTE_MISMATCH: 'errors.unknown',
  PREVIEW_TIMEOUT: 'errors.timeout'
}

const ALL_CODES = [...OUTCOME_CODES, ...EXTRA_CODES] as readonly string[]

export interface CopyContext {
  /** The bridge the failure belongs to; Grasshopper-specific sentences apply only for `grasshopper`. */
  app?: BridgeApp | null
  /** The `reason` field that came with the outcome (SETUP_INCOMPLETE: ROUTES_NOT_LOOPBACK, NO_DOCUMENT_OPEN, ...). */
  reason?: string
}

/**
 * The copy entry for an operational outcome code. Total over the closed vocabulary (and the extra agent codes):
 * `none` means the outcome is not a failure (COMPLETED, CANCELLED). An unknown code gets the generic sentence, so
 * a failure is never rendered blank.
 */
export function copyKeyForOutcome(code: string, ctx: CopyContext = {}): CopyKey {
  const grasshopper = ctx.app === 'grasshopper'

  switch (code) {
    case 'BRIDGE_OFF':
      return grasshopper ? 'errors.grasshopperOff' : 'errors.revitOff'

    case 'BUSY':
      return grasshopper ? 'errors.grasshopperBusy' : 'errors.revitBusy'

    case 'EXTENSION_NOT_LOADED':
      return grasshopper ? 'errors.grasshopperOff' : 'errors.extensionNotLoaded'

    case 'SETUP_INCOMPLETE':
      return ctx.reason === 'ROUTES_NOT_LOOPBACK'
        ? 'errors.routesNotLoopback'
        : ctx.reason === 'ROUTES_DISABLED'
          ? 'errors.routesDisabled'
          : ctx.reason === 'NO_DOCUMENT_OPEN'
            ? 'empty.noDocuments'
            : 'errors.setupIncomplete'

    default:
      return CODE_COPY[code as keyof typeof CODE_COPY] ?? 'errors.unknown'
  }
}

export interface ParsedFailure {
  /** The outcome code found in the text, or null when the text names none. */
  code: null | string
  reason?: string
  /** Seconds from `retryAfter` (PROVIDER_RATE_LIMITED). */
  retryAfter?: number
  /** A seconds figure the text itself carries (PROVIDER_TIMEOUT). */
  seconds?: number
  message: string
}

const CODE_PATTERN = new RegExp(`\\b(${ALL_CODES.join('|')})\\b`, 'g')

/** Find the earliest operational outcome code in a failure text and its structured extras. */
export function parseFailureText(text: string): ParsedFailure {
  const message = text.trim()
  CODE_PATTERN.lastIndex = 0
  const match = CODE_PATTERN.exec(message)

  if (!match) {
    return { code: null, message }
  }

  const reason = /\breason:\s*([^,)\s][^,)]*)/i.exec(message)?.[1]?.trim()
  const retryAfter = /\bretryAfter:\s*(\d+(?:\.\d+)?)/i.exec(message)?.[1]
  const seconds = /\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/i.exec(message)?.[1]

  return {
    code: match[1],
    message,
    ...(reason && { reason }),
    ...(retryAfter !== undefined && { retryAfter: Number(retryAfter) }),
    ...(seconds !== undefined && { seconds: Number(seconds) })
  }
}

export interface TextContext extends CopyContext {
  /** The pinned document's name, for the identity/closed-document sentence. */
  document?: string
  project?: string
  /** Seconds the request ran before it failed: the timeout sentence's figure when the text carries none. */
  elapsedSeconds?: number
}

/**
 * The user-facing sentence for a failure. `null` for COMPLETED/CANCELLED (not failures). A failure that names no
 * known code reads as the generic sentence: the raw error text is never shown as the headline.
 */
export function failureSentence(copy: DegramCopy, failure: ParsedFailure, ctx: TextContext = {}): null | string {
  const code = failure.code ?? ''

  const key = failure.code
    ? copyKeyForOutcome(code, { app: ctx.app, reason: failure.reason ?? ctx.reason })
    : 'errors.unknown'

  switch (key) {
    case 'none':
      return null

    case 'empty.noDocuments':
      return copy.empty.noDocuments.body

    case 'errors.accessRevoked':
      return copy.errors.accessRevoked(ctx.project ?? '')

    case 'errors.credentialsMissing':
      return copy.errors.credentialsMissing(ctx.project ?? '')

    case 'errors.limit':
      return failure.retryAfter === undefined
        ? copy.errors.limitUnknown
        : copy.errors.limit(copy.format.duration(failure.retryAfter))

    case 'errors.pinnedGone':
      return copy.errors.pinnedGone(ctx.document ?? '')

    case 'errors.policyDeny':
      return copy.errors.policyDeny(failure.reason ?? failure.message)

    case 'errors.timeout':
      return copy.errors.timeout(Math.round(failure.seconds ?? ctx.elapsedSeconds ?? 0))

    default:
      return copy.errors[key.slice('errors.'.length) as keyof typeof copy.errors] as string
  }
}

/**
 * The headline of a failed turn in variant degram (1301-19, G-4): DeGram's own sentence for the code the failure text
 * carries. A text that names no code (a transport drop, an unclassified model error) reads as `modelUnavailable`:
 * the raw text, which can carry a provider name or a key hint, is never the headline.
 */
export function degramFailureHeadline(copy: DegramCopy, errorText: string, ctx: TextContext = {}): string {
  const failure = parseFailureText(errorText)

  return (failure.code ? failureSentence(copy, failure, ctx) : null) ?? copy.errors.modelUnavailable
}

/** The retry affordance applies unless the failure is a policy deny (the server decided; consent cannot override). */
export function isRetryable(failure: ParsedFailure): boolean {
  return failure.code !== 'POLICY_DENY'
}
