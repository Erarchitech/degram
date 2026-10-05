import { atom } from 'nanostores'

/**
 * Product-identity gate for the DeGram variant (Phase 1301). DeGram has no
 * update channel (D-03): the update poller and the update menu entry stay off.
 * The fact is answered synchronously by main through the feature-flags IPC and
 * published by the preload as `hermesDesktop.degramEnabled`.
 */
export const $degramEnabled = atom<boolean>(
  typeof window !== 'undefined' && window.hermesDesktop?.degramEnabled === true
)
