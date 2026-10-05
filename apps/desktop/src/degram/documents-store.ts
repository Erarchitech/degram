// documents-store.ts — the renderer's cache of the CAD bridges (Phase 1301-14, DGCL-04, D-13).
//
// Authority (apps/desktop/AGENTS.md): the agent backend owns the documents and the pin; this store is a cache of
// `degram.documents.list` / `pin`, painted optimistically and reconciled with the answer. Every entry is tagged with
// the scope it was read for, and a reader whose scope differs sees nothing, so a project change empties the strip
// and the card in the same render, before any effect runs (DGCL-02). Nothing is pinned implicitly: a single open
// document stays unpinned until the user picks it.

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
  type PinnedDocument,
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
  pinned: null | PinnedDocument
  /** The pinned document is gone or another file answers in its place: reads are blocked until the user reselects. */
  mismatch: boolean
  /** The last pin attempt failed with this outcome. */
  pinError: null | OutcomeInfo
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
  pinned: null,
  mismatch: false,
  pinError: null,
  pinVersion: 0
}

export const $documents = atom<DocumentsStore>(INITIAL)

/** The scope a read belongs to: company, project and the epoch of the selection; empty until a scope is ready. */
export function scopeKeyOf(store: Pick<DegramStore, 'state'>): string {
  const scope = store.state?.scope

  return scope && scope.status === 'ready' ? `${scope.company ?? ''}|${scope.project ?? ''}|${scope.epoch}` : ''
}

const currentScopeKey = (): string => scopeKeyOf($degram.get())

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
          const pinnedApp = pinned?.app

          // Mismatch is judged only by the bridge that holds the pin and actually answered.
          const holderAnswered =
            group !== null && pinnedApp === target && (group.state === 'ready' || group.state === 'pinned')

          const present = holderAnswered && group.documents.some(row => row.pinned)

          return {
            ...store,
            apps: { ...store.apps, [target]: { loading: false, group, failed: false } },
            pinned,
            mismatch: pinned === null ? false : holderAnswered ? !present : store.mismatch
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

/** Pin a document row. Optimistic: the strip and the row's dot update at once, a failure rolls back visibly. */
export async function pinRow(row: DocumentRow): Promise<void> {
  if (!row.identity) {
    return
  }

  syncDocumentsScope()
  const key = currentScopeKey()
  const before = $documents.get()

  patch(
    store => ({
      ...store,
      pinned: {
        app: row.app,
        name: row.name,
        path: row.path,
        unsaved: row.unsaved,
        identity: row.identity as Record<string, unknown>
      },
      mismatch: false,
      pinError: null,
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
      patch(
        store => ({
          ...store,
          pinned: before.pinned,
          mismatch: before.mismatch,
          pinError: outcome ?? { code: 'UNKNOWN' }
        }),
        key
      )

      return
    }

    patch(store => ({ ...store, pinned, mismatch: false, pinError: null }), key)
  } catch {
    patch(
      store => ({ ...store, pinned: before.pinned, mismatch: before.mismatch, pinError: { code: 'DG_UNAVAILABLE' } }),
      key
    )
  }

  // The group rows follow the answer: the pinned row gets its dot, the previous one loses it.
  void refreshDocuments(row.app)
}

export async function unpin(): Promise<void> {
  syncDocumentsScope()
  const key = currentScopeKey()

  patch(store => ({ ...store, pinned: null, mismatch: false, pinError: null, pinVersion: store.pinVersion + 1 }), key)

  try {
    await unpinDocument()
  } catch {
    // The next list read reports the backend's truth.
  }
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
      mismatch: state === 'identity-mismatch' ? true : store.mismatch
    }
  }, key)
}
