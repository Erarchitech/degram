// channels.ts — the `degram:*` IPC channel names (Phase 1301-12).
//
// Kept free of imports on purpose: the sandboxed preload bundles this file, and a sandboxed preload may
// only require electron, events, timers and url (see the note at the top of preload.ts), so it must not
// pull in anything that imports node:path or node:fs. ipc.ts re-exports these for main.

/** IPC channel names. Request channels are `ipcMain.handle`; `stateChanged` and `event` are main to renderer. */
export const DEGRAM_CHANNELS = {
  getState: 'degram:get-state',
  selectProject: 'degram:select-project',
  signOut: 'degram:sign-out',
  setDgMode: 'degram:set-dg-mode',
  reloadDg: 'degram:reload-dg',
  setDgBounds: 'degram:set-dg-bounds',
  reportOutcome: 'degram:report-outcome',
  openExternalConfirmed: 'degram:open-external-confirmed',
  stateChanged: 'degram:state-changed',
  event: 'degram:event'
} as const

export type DegramChannel = (typeof DEGRAM_CHANNELS)[keyof typeof DEGRAM_CHANNELS]
