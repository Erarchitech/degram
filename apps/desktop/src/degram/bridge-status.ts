// bridge-status.ts — a bridge group's state -> the scope strip segment and the picker's diagnostic line
// (Phase 1301-14, D-13/D-23, 1301-UI-SPEC "Bridge status").
//
// States: ready, pinned, busy, off, setup-incomplete (routes disabled / routes not loopback / extension not loaded /
// no document open: each its own sentence) and identity-mismatch, plus «checking» before the first answer.
// Colour: ink for ready, neutral for everything else; the single accent dot belongs to the pinned document, not to
// a bridge state, so red never marks a bridge fault (DESIGN.md: red is for explicit failures).

import type { DegramCopy } from './i18n'
import { copyKeyForOutcome } from './outcome-copy'
import type { BridgeSegment } from './scope-strip'
import type { BridgeApp, BridgeGroup, BridgeStateName } from './use-degram-gateway'

export type BridgeStatusName =
  'busy' | 'checking' | 'identity-mismatch' | 'off' | 'pinned' | 'ready' | 'setup-incomplete'

export interface BridgeView {
  status: BridgeStatusName
  /** Short label next to the bridge name in the strip. */
  label: string
  /** The full diagnostic (picker group notice and the segment's tip); undefined when nothing is wrong. */
  detail?: string
}

const SHORT: Record<BridgeStateName, keyof DegramCopy['bridge']['states']> = {
  busy: 'busy',
  'identity-mismatch': 'identityMismatch',
  off: 'off',
  pinned: 'pinned',
  ready: 'ready',
  'setup-incomplete': 'setupIncomplete'
}

function diagnostic(copy: DegramCopy, group: BridgeGroup, document?: string): string | undefined {
  if (group.state === 'ready' || group.state === 'pinned') {
    return undefined
  }

  const code =
    group.state === 'off'
      ? 'BRIDGE_OFF'
      : group.state === 'busy'
        ? 'BUSY'
        : group.state === 'identity-mismatch'
          ? 'IDENTITY_MISMATCH'
          : (group.code ?? 'SETUP_INCOMPLETE')

  const key = copyKeyForOutcome(code, { app: group.app, reason: group.reason })

  switch (key) {
    case 'empty.noDocuments':
      return copy.empty.noDocuments.body

    case 'errors.pinnedGone':
      return copy.errors.pinnedGone(document ?? '')

    case 'errors.revitOff':

    case 'errors.grasshopperOff':

    case 'errors.revitBusy':

    case 'errors.grasshopperBusy':

    case 'errors.routesDisabled':

    case 'errors.routesNotLoopback':

    case 'errors.extensionNotLoaded':

    case 'errors.setupIncomplete':
      return copy.errors[key.slice('errors.'.length) as 'revitOff']

    default:
      return copy.errors.setupIncomplete
  }
}

/** The view of one bridge. `group` undefined means no answer yet: «Проверка». */
export function bridgeView(copy: DegramCopy, group: BridgeGroup | undefined, document?: string): BridgeView {
  if (!group) {
    return { status: 'checking', label: copy.bridge.checking }
  }

  return {
    status: group.state,
    label: copy.bridge.states[SHORT[group.state]],
    detail: diagnostic(copy, group, document)
  }
}

/** The strip's bridge segment for a view (the strip owns the dot colour rules). */
export function toSegment(view: BridgeView): BridgeSegment {
  return { status: view.status, label: view.label, detail: view.detail }
}

/** The group of an application among the loaded ones. */
export function groupFor(groups: readonly BridgeGroup[], app: BridgeApp): BridgeGroup | undefined {
  return groups.find(group => group.app === app)
}
