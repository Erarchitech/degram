// composer-seam.ts — the DeGram variant's few touch points with the stock composer (Phase 1301-14).
//
// Everything here is a no-op outside variant `degram` (`$degramEnabled`), so the other variants behave exactly as
// before. Four seams, each one line in the stock code:
//   - `registerComposerGate`     the composer middleware (consent for the whole definition, no stale or unread send)
//   - `degramPromptSubmit`       replaces the one `prompt.submit` call so a pinned document's previewed payload
//                                is what `degram.context.send` embeds (preview == sent payload)
//   - `degramOnStop`             Stop paints in the current frame and aborts the in-flight bridge read
//   - `useDegramSendBlocked`     Send is disabled while a snapshot read is in flight or failed

import { useStore } from '@nanostores/react'

import { COMPOSER_AREAS, type ComposerMiddleware } from '@/app/chat/composer/contrib'
import { registry } from '@/contrib/registry'
import { $degramEnabled } from '@/store/degram-flag'
import { $activeGatewayProfile } from '@/store/profile'

import { $documents } from './documents-store'
import {
  $lifecycle,
  clearArmed,
  composerGate,
  markSendFailed,
  markSent,
  routeMismatch,
  sendBlockedReason,
  stopRequest,
  takeSendPlan
} from './request-lifecycle'
import { sendContext } from './use-degram-gateway'
import { $degram } from './use-degram-state'

/** Outcome code of a submit refused because the chat's route is not on the ready scope's profile. */
export const ROUTE_MISMATCH = 'ROUTE_MISMATCH'

export const DEGRAM_COMPOSER_GATE_ID = 'degram.composer-gate'

/** After every other middleware (a plugin may rewrite the text): the gate arms the FINAL text. */
const GATE_ORDER = 10_000

export function registerComposerGate(): () => void {
  return registry.register({
    id: DEGRAM_COMPOSER_GATE_ID,
    area: COMPOSER_AREAS.middleware,
    order: GATE_ORDER,
    data: { handler: draft => composerGate(draft) } satisfies ComposerMiddleware
  })
}

type Rpc = <R>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<R>

interface SubmitParams extends Record<string, unknown> {
  session_id: string
  text: string
}

/**
 * Stand-in for `requestGateway('prompt.submit', params, timeout)` in the stock submit. Outside DeGram it is that
 * call. In DeGram the machine enters `streaming` here (the one place a request starts), and a send armed by the
 * gate goes through `degram.context.send` so the model receives exactly the payload the card showed.
 */
export async function degramPromptSubmit<R>(rpc: Rpc, params: SubmitParams, timeoutMs?: number): Promise<R> {
  if (!$degramEnabled.get()) {
    return rpc<R>('prompt.submit', params, timeoutMs)
  }

  // The one hard check behind the disabled Send button: a turn never goes out on the route of another scope
  // (G-7, T-1301-18-02). Refused before the machine enters `streaming` and before any RPC.
  if (routeMismatch()) {
    throw new Error(`${ROUTE_MISMATCH}: the chat is not on the profile of the selected project`)
  }

  const plan = takeSendPlan(params.text)

  markSent(params.session_id, params.text)

  try {
    const result = plan
      ? await sendContext<R>(
          { session_id: params.session_id, previewId: plan.previewId, text: params.text, consent: plan.consent },
          timeoutMs,
          rpc
        )
      : await rpc<R>('prompt.submit', params, timeoutMs)

    clearArmed()

    return result
  } catch (error) {
    markSendFailed(error instanceof Error ? error.message : String(error))

    throw error
  }
}

/** The composer's Stop (the stock cancel already sends `session.interrupt`): clear the request state and the read. */
export function degramOnStop(): void {
  if ($degramEnabled.get()) {
    stopRequest()
  }
}

/** True while a pinned document's read is in flight, failed or stale: the composer's Send button is disabled. */
export function useDegramSendBlocked(): boolean {
  // The result reads module state (`sendBlockedReason`), not hook values: React Compiler would memoize the call on
  // `enabled` alone and the button would stop following the route and the machine.
  'use no memo'

  const enabled = useStore($degramEnabled)

  // Subscribed so the button follows the machine, the pin, the scope and the gateway route in the same render.
  useStore($lifecycle)
  useStore($documents)
  useStore($degram)
  useStore($activeGatewayProfile)

  return enabled && sendBlockedReason() !== null
}
