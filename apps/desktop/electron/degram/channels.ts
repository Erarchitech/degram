// channels.ts — the `degram:*` IPC channel names (Phase 1301-12).
//
// Kept free of imports on purpose: the sandboxed preload bundles this file, and a sandboxed preload may
// only require electron, events, timers and url (see the note at the top of preload.ts), so it must not
// pull in anything that imports node:path or node:fs. ipc.ts re-exports these for main.

/** IPC channel names. Request channels are `ipcMain.handle`; `stateChanged`, `event` and `requestSignOut` are main to renderer. */
export const DEGRAM_CHANNELS = {
  getState: 'degram:get-state',
  selectProject: 'degram:select-project',
  signOut: 'degram:sign-out',
  setDgMode: 'degram:set-dg-mode',
  reloadDg: 'degram:reload-dg',
  // Phase 1301-20 (G-16): re-check DG (/auth/me) and reload the DG view after an unreachable start.
  retryDg: 'degram:retry-dg',
  setDgBounds: 'degram:set-dg-bounds',
  reportOutcome: 'degram:report-outcome',
  openExternalConfirmed: 'degram:open-external-confirmed',
  // Phase 1301-17 (D-25): the pairing token crosses IPC once, renderer to main; nothing returns it.
  setPairing: 'degram:pairing:set',
  clearPairing: 'degram:pairing:clear',
  // Phase 1301-20 (G-17): the tray's sign-out entry. The renderer owns the label (locale) and the confirmation.
  setTrayLabels: 'degram:set-tray-labels',
  requestSignOut: 'degram:request-sign-out',
  stateChanged: 'degram:state-changed',
  event: 'degram:event'
} as const

export type DegramChannel = (typeof DEGRAM_CHANNELS)[keyof typeof DEGRAM_CHANNELS]
