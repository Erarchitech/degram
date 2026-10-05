// host-actions.ts — the default bindings of DegramActions to the stock Desktop session machinery.
// Loaded lazily (dynamic import from use-degram-state) so the DeGram components stay light under test.

import { activeGateway } from '@/store/gateway'
import { requestFreshSession } from '@/store/profile'
import { $activeSessionId } from '@/store/session'

/** Interrupt the live turn of the active session (the same RPC the composer's Stop uses). */
export async function stopActiveResponse(): Promise<void> {
  const sessionId = $activeSessionId.get()

  if (!sessionId) {
    return
  }

  await activeGateway()?.request('session.interrupt', { session_id: sessionId })
}

/** Drop the open session for a fresh draft: a new scope never reuses the previous project's transcript. */
export function startFreshChat(): void {
  requestFreshSession()
}
