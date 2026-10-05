// host-actions.ts — the default bindings of DegramActions to the stock Desktop session machinery.
// Loaded lazily (dynamic import from use-degram-state) so the DeGram components stay light under test.

import { requestFreshSession } from '@/store/profile'
import { $activeSessionId } from '@/store/session'

import { interruptSession, stopRequest } from './request-lifecycle'

/**
 * Stop the live turn of the active session: the request state clears in this frame, `degram.context.cancel` aborts a
 * bridge read in flight and `session.interrupt` (the RPC the composer's Stop uses) interrupts the turn, once each.
 * Resolves when the interrupt settled, so a caller can switch scope or sign out right after.
 */
export async function stopActiveResponse(): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve()

  stopRequest({
    interrupt: () => {
      pending = interruptSession($activeSessionId.get())()

      return pending
    }
  })

  await pending.catch(() => undefined)
}

/** Drop the open session for a fresh draft: a new scope never reuses the previous project's transcript. */
export function startFreshChat(): void {
  requestFreshSession()
}
