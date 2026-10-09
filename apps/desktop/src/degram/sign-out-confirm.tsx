// sign-out-confirm.tsx — «Остановить и выйти / Продолжить работу» (Phase 1301-14, 1301-UI-SPEC "Destructive
// confirmation — sign out while running").
//
// UI-SPEC specifies this confirmation but no visible sign-out control, and none was invented: any entry point calls
// `requestDegramSignOut()`. Plan 1301-20 (G-17) wired the two entry points: the project picker menu and the tray
// menu (main asks the renderer through `onRequestSignOut`, because the confirmation and the label are renderer-owned).
// With no response running it signs out at once; with one running it asks first, because signing out stops the
// response and hides the project's chat.

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { $busy } from '@/store/session'

import { degramBridge, useDegramActions } from './use-degram-state'

export const $signOutPending = atom(false)

/** Sign out of DG. While a response runs this opens the confirmation instead of signing out. */
export function requestDegramSignOut(): void {
  if ($busy.get()) {
    $signOutPending.set(true)

    return
  }

  void degramBridge()?.signOut()
}

export function DegramSignOutConfirm() {
  const { t } = useI18n()
  const copy = t.degram
  const actions = useDegramActions()
  const open = useStore($signOutPending)
  const trayLabel = copy.actions.signOut

  // The tray menu is native: its sign-out text follows the renderer's locale once that has loaded.
  useEffect(() => {
    void degramBridge()?.setTrayLabels?.({ signOut: trayLabel })
  }, [trayLabel])

  // The tray's sign-out entry: main brings the window forward, the confirmation (if a response runs) is ours.
  useEffect(() => degramBridge()?.onRequestSignOut?.(() => requestDegramSignOut()), [])

  return (
    <ConfirmDialog
      cancelLabel={copy.confirm.keepWorking}
      confirmLabel={copy.confirm.signOutConfirm}
      description={<span className="block max-h-40 overflow-y-auto">{copy.confirm.signOutBody}</span>}
      destructive
      onClose={() => $signOutPending.set(false)}
      onConfirm={async () => {
        await actions.stopResponse()
        await degramBridge()?.signOut()
      }}
      open={open}
      title={copy.confirm.signOutTitle}
    />
  )
}
