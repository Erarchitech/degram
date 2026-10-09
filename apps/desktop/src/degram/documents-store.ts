// documents-store.ts — the renderer's cache of the CAD bridges (Phase 1301-14, DGCL-04, D-13, D-29).
//
// Authority (apps/desktop/AGENTS.md): the agent backend owns the documents and the pins; this store is a cache of
// `degram.documents.list` / `pin` / `unpin`, painted optimistically and reconciled with the answer. Every entry is
// tagged with the scope it was read for, and a reader whose scope differs sees nothing, so a project change empties
// the strip and the card in the same render, before any effect runs (DGCL-02). Nothing is pinned implicitly: a
// single open document stays unpinned until the user picks it. D-29: one pinned document per bridge, so a Revit model
// and a Grasshopper definition are pinned at once; pinning on one bridge never touches the other's pin, and a
// mismatch is tracked per bridge.

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import {
  BRIDGE_APPS,
  type BridgeApp,
  type BridgeGroup,
  type BridgeStateName,
  type DocumentRow,
  listDocuments,
  type OutcomeInfo,
  pinDocument,
  type PinnedMap,
  unpinDocument
} from './use-degram-gateway'
import { $degram, type DegramStore } from './use-degram-state'

export interface AppEntry {
  /** A list read is in flight for this bridge (the group shows «Проверка» while the others stay usable). */
  loading: boolean
  /** The last answer; null before the first one. */
  group: BridgeGroup | null
  /** The RPC itself failed (not a bridge outcome): the group shows the off diagnostic. */
  failed: boolean
}

export interface DocumentsStore {
  scopeKey: string
  apps: Record<BridgeApp, AppEntry>
  /** The pinned document of each bridge (at most one per bridge). */
  pinned: PinnedMap
  /** Per bridge: its pinned document is gone or another file answers in its place; that document is left out of reads. */
  mismatch: Partial<Record<BridgeApp, boolean>>
  /** Per bridge: the last pin attempt failed with this outcome. */
  pinError: Partial<Record<BridgeApp, OutcomeInfo>>
  /** Bumped by every pin and unpin: a list read that started before one must not overwrite the pin it did not see. */
  pinVersion: number
}

const emptyApps = (): Record<BridgeApp, AppEntry> => ({
  revit: { loading: false, group: null, failed: false },
  grasshopper: { loading: false, group: null, failed: false }
})

const INITIAL: DocumentsStore = {
  scopeKey: '',
  apps: emptyApps(),
  pinned: {},
  mismatch: {},
  pinError: {},
  pinVersion: 0
}

export const $documents = atom<DocumentsStore>(INITIAL)

/** The scope a read belongs to: company, project and the epoch of the selection; empty until a scope is ready. */
export function scopeKeyOf(store: Pick<DegramStore, 'state'>): string {
  const scope = store.state?.scope

  return scope && scope.status === 'ready' ? `${scope.company ?? ''}|${scope.project ?? ''}|${scope.epoch}` : ''
}

const currentScopeKey = (): string => scopeKeyOf($degram.get())

/** The pinned apps in the order the strip and the picker show them. */
export const pinnedApps = (store: Pick<DocumentsStore, 'pinned'>): BridgeApp[] =>
  BRIDGE_APPS.filter(app => store.pinned[app] !== undefined)

/** True when every pinned document is excluded by an identity mismatch (nothing left to read, nothing to switch to). */
export const allPinnedMismatched = (store: Pick<DocumentsStore, 'mismatch' | 'pinned'>): boolean => {
  const apps = pinnedApps(store)

  return apps.length > 0 && apps.every(app => store.mismatch[app] === true)
}

/** The name of the pinned document a failure belongs to: that bridge's, else the first pinned one. */
export const pinnedName = (store: Pick<DocumentsStore, 'pinned'>, app?: BridgeApp | null): string | undefined => {
  const first = pinnedApps(store)[0]

  return ((app ? store.pinned[app] : undefined) ?? (first ? store.pinned[first] : undefined))?.name
}

const without = <T>(map: Partial<Record<BridgeApp, T>>, app: BridgeApp): Partial<Record<BridgeApp, T>> => {
  const next = { ...map }

  delete next[app]

  return next
}

const generations: Record<BridgeApp, number> = { revit: 0, grasshopper: 0 }

/** Tests (and a scope switch) start from a clean cache. */
export function resetDocuments(scopeKey = ''): void {
  generations.revit++
  generations.grasshopper++
  $documents.set({ ...INITIAL, scopeKey, apps: emptyApps() })
}

/** The cache, or an empty one when it belongs to another scope than the current one. */
export function useDocuments(): DocumentsStore {
  const store = useStore($documents)
  const key = scopeKeyOf(useStore($degram))

  return store.scopeKey === key ? store : { ...INITIAL, scopeKey: key }
}

function patch(next: (store: DocumentsStore) => DocumentsStore, key: string): void {
  const current = $documents.get()

  if (current.scopeKey !== key) {
    return
  }

  $documents.set(next(current))
}

/** Make the store belong to the current scope (the scope-change effect); a different scope empties it. */
export function syncDocumentsScope(): void {
  const key = currentScopeKey()

  if ($documents.get().scopeKey !== key) {
    resetDocuments(key)
  }
}

/** Re-read the open documents of one bridge, or of every bridge in parallel; each group settles on its own. */
export async function refreshDocuments(app?: BridgeApp): Promise<void> {
  syncDocumentsScope()
  const key = currentScopeKey()

  if (!key) {
    return
  }

  const targets = app ? [app] : BRIDGE_APPS
  const pinVersionAtStart = $documents.get().pinVersion

  // Loading is set synchronously, so a stale group is never painted as current for even one frame.
  patch(
    store => ({
      ...store,
      apps: Object.fromEntries(
        BRIDGE_APPS.map(a => [a, targets.includes(a) ? { ...store.apps[a], loading: true } : store.apps[a]])
      ) as Record<BridgeApp, AppEntry>
    }),
    key
  )

  await Promise.all(
    targets.map(async target => {
      const generation = ++generations[target]

      try {
        const result = await listDocuments(target)

        if (generations[target] !== generation || currentScopeKey() !== key) {
          return
        }

        const group = result.groups.find(g => g.app === target) ?? null

        patch(store => {
          // A pin or unpin happened while this read was in flight: its answer predates it, so keep the newer pin.
          if (store.pinVersion !== pinVersionAtStart) {
            return { ...store, apps: { ...store.apps, [target]: { loading: false, group, failed: false } } }
          }

          const pinned = result.pinned

          // Mismatch is judged per bridge, and only by a bridge that holds a pin and actually answered; a bridge
          // that was not asked (or did not answer) keeps what the store already knew about it.
          const holderAnswered =
            group !== null && pinned[target] !== undefined && (group.state === 'ready' || group.state === 'pinned')

          const present = holderAnswered && group.documents.some(row => row.pinned)
          const mismatch: Partial<Record<BridgeApp, boolean>> = {}

          for (const app of BRIDGE_APPS) {
            if (pinned[app] === undefined) {
              continue
            }

            mismatch[app] = app === target && holderAnswered ? !present : (store.mismatch[app] ?? false)
          }

          return {
            ...store,
            apps: { ...store.apps, [target]: { loading: false, group, failed: false } },
            pinned,
            mismatch
          }
        }, key)
      } catch {
        if (generations[target] === generation && currentScopeKey() === key) {
          patch(
            store => ({ ...store, apps: { ...store.apps, [target]: { loading: false, group: null, failed: true } } }),
            key
          )
        }
      }
    })
  )
}

/**
 * Pin a document row. Optimistic: the strip and the row's dot update at once, a failure rolls back visibly. It
 * replaces only this bridge's pin: the other bridge keeps its own (D-29).
 */
export async function pinRow(row: DocumentRow): Promise<void> {
  if (!row.identity) {
    return
  }

  syncDocumentsScope()
  const key = currentScopeKey()
  const before = $documents.get()

  const app = row.app

  patch(
    store => ({
      ...store,
      pinned: {
        ...store.pinned,
        [app]: {
          app,
          name: row.name,
          path: row.path,
          unsaved: row.unsaved,
          identity: row.identity as Record<string, unknown>
        }
      },
      mismatch: { ...store.mismatch, [app]: false },
      pinError: without(store.pinError, app),
      pinVersion: store.pinVersion + 1
    }),
    key
  )

  try {
    const { outcome, pinned } = await pinDocument(row.app, row.identity)

    if (currentScopeKey() !== key) {
      return
    }

    if (outcome || !pinned) {
      patch(store => rollback(store, before, app, outcome ?? { code: 'UNKNOWN' }), key)

      return
    }

    patch(
      store => ({
        ...store,
        pinned: { ...store.pinned, [app]: pinned },
        mismatch: { ...store.mismatch, [app]: false },
        pinError: without(store.pinError, app)
      }),
      key
    )
  } catch {
    patch(store => rollback(store, before, app, { code: 'DG_UNAVAILABLE' }), key)
  }

  // The group rows follow the answer: the pinned row gets its dot, the previous one loses it.
  void refreshDocuments(row.app)
}

/** A failed pin puts back only this bridge's previous pin, mismatch flag and message; the other bridge is untouched. */
function rollback(store: DocumentsStore, before: DocumentsStore, app: BridgeApp, outcome: OutcomeInfo): DocumentsStore {
  const pinned = before.pinned[app]

  return {
    ...store,
    pinned: pinned ? { ...store.pinned, [app]: pinned } : without(store.pinned, app),
    mismatch: { ...store.mismatch, [app]: before.mismatch[app] ?? false },
    pinError: { ...store.pinError, [app]: outcome }
  }
}

/** Unpin one bridge's document (D-29), or both when no bridge is named. The other bridge keeps its pin. */
export async function unpin(app?: BridgeApp): Promise<void> {
  syncDocumentsScope()
  const key = currentScopeKey()

  patch(
    store => ({
      ...store,
      pinned: app ? without(store.pinned, app) : {},
      mismatch: app ? without(store.mismatch, app) : {},
      pinError: app ? without(store.pinError, app) : {},
      pinVersion: store.pinVersion + 1
    }),
    key
  )

  try {
    await unpinDocument(app ?? null)
  } catch {
    // The next list read reports the backend's truth.
  }
}

/**
 * A preview read the pinned document of these bridges: they are present after all, so a mismatch recorded earlier
 * (by a list read) no longer applies to them. Never pins or switches anything.
 */
export function noteDocumentsRead(apps: readonly BridgeApp[]): void {
  const key = currentScopeKey()

  patch(store => {
    const stale = apps.filter(app => store.mismatch[app] === true)

    return stale.length === 0
      ? store
      : { ...store, mismatch: { ...store.mismatch, ...Object.fromEntries(stale.map(app => [app, false])) } }
  }, key)
}

/** A read came back with a bridge outcome: the strip and the picker follow it (neutral dot, no silent switch). */
export function noteBridgeOutcome(app: BridgeApp | null, outcome: OutcomeInfo): void {
  const key = currentScopeKey()
  const state = outcome.bridgeState as BridgeStateName | undefined

  if (!app || !state) {
    return
  }

  patch(store => {
    const entry = store.apps[app]

    const group: BridgeGroup = {
      app,
      state,
      documents: entry.group?.documents ?? [],
      code: outcome.code,
      reason: outcome.reason,
      message: outcome.message
    }

    return {
      ...store,
      apps: { ...store.apps, [app]: { ...entry, group } },
      // Only this bridge's document is left out (D-29): the other bridge's pin and mismatch state are untouched.
      mismatch: state === 'identity-mismatch' ? { ...store.mismatch, [app]: true } : store.mismatch
    }
  }, key)
}
