// use-mapping-session.ts — one narrow job: keep the newest mapping session of one document fresh while its Mapping
// sub-tab is open (Phase 1303-10). DG owns the session; this is a cache of it. Reads start on expand, repeat every
// MAPPING_POLL_MS while the session can still change on its own (needsPolling) and stop on collapse or unmount. A
// generation counter drops answers that arrive after a newer read or a local answer/undo, so a stale poll never
// brings back an undone answer. A start is followed for START_FOLLOW_MS, then polling ends on its own.

import { useCallback, useEffect, useRef, useState } from 'react'

import { listMappingSessions, MappingRefusal, type MappingSession, readMappingSession } from './mapping-api'
import { MAPPING_POLL_MS, needsPolling } from './mapping-view'
import type { OutcomeInfo } from './use-degram-gateway'

/** How long after a start the sub-tab keeps looking for the new session. */
export const START_FOLLOW_MS = 60_000

export interface MappingPanelState {
  /** A read is in flight and nothing was read yet for this document. */
  loading: boolean
  /** At least one read finished. */
  loaded: boolean
  session: MappingSession | null
  /** The last read failed with this outcome (a bridge, DG or refusal code). */
  outcome: null | OutcomeInfo
  /** Grasshopper: CONNECTOR is signed in; null when the canvas did not say. */
  signedIn: boolean | null
  connectorMessage: null | string
}

const INITIAL: MappingPanelState = {
  loading: false,
  loaded: false,
  session: null,
  outcome: null,
  signedIn: null,
  connectorMessage: null
}

const failure = (error: unknown): OutcomeInfo =>
  error instanceof MappingRefusal
    ? { code: error.code, message: error.message }
    : { code: 'DG_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }

export function useMappingSession(app: string, document: string, open: boolean, scopeKey: string) {
  const [state, setState] = useState<MappingPanelState>(INITIAL)
  const [followUntil, setFollowUntil] = useState(0)
  const generation = useRef(0)

  /** Read the session `sessionId`, or (without one) find the document's newest session first. */
  const read = useCallback(
    async (sessionId?: string): Promise<void> => {
      const gen = ++generation.current
      const current = () => gen === generation.current

      try {
        let id = sessionId
        let connector: Pick<MappingPanelState, 'connectorMessage' | 'signedIn'> | null = null

        if (!id) {
          const list = await listMappingSessions(app, document)

          if (!current()) {
            return
          }

          if (list.outcome) {
            setState(s => ({ ...s, loading: false, loaded: true, outcome: list.outcome }))

            return
          }

          connector = { signedIn: list.signedIn, connectorMessage: list.connectorMessage }
          id = list.sessions[0]?.sessionId

          if (!id) {
            setState(s => ({ ...s, ...connector, loading: false, loaded: true, outcome: null, session: null }))

            return
          }
        }

        const result = await readMappingSession(id)

        if (!current()) {
          return
        }

        setState(s => ({
          ...s,
          ...connector,
          loading: false,
          loaded: true,
          outcome: result.outcome,
          session: result.session ?? s.session
        }))
      } catch (error) {
        if (!current()) {
          return
        }

        // The session we followed is gone: look for the document's newest one again.
        if (sessionId && error instanceof MappingRefusal && error.code === 'MAPPING_SESSION_NOT_FOUND') {
          void read()

          return
        }

        setState(s => ({ ...s, loading: false, loaded: true, outcome: failure(error) }))
      }
    },
    [app, document]
  )

  // A new document or scope starts from nothing; collapsing drops in-flight answers but keeps the last view.
  useEffect(() => {
    generation.current++
    setState(INITIAL)
    setFollowUntil(0)
  }, [app, document, scopeKey])

  useEffect(() => {
    if (!open) {
      generation.current++

      return
    }

    setState(s => (s.loaded ? s : { ...s, loading: true }))
    void read()
  }, [open, read, scopeKey])

  const following = followUntil > Date.now()
  const sessionId = state.session?.sessionId

  // The start button shows only without a session, so the first session found while following is the started one.
  useEffect(() => {
    if (following && sessionId) {
      setFollowUntil(0)
    }
  }, [following, sessionId])

  useEffect(() => {
    if (!open || !needsPolling(state.session, following)) {
      return
    }

    // While a start is followed the list is re-read, so the new session replaces an older one.
    const timer = setTimeout(() => void read(following ? undefined : sessionId), MAPPING_POLL_MS)

    return () => clearTimeout(timer)
  }, [open, state, following, sessionId, read])

  /** A local answer or undo returned the recomputed session: it wins over any read still in flight. */
  const adopt = useCallback((session: MappingSession) => {
    generation.current++
    setState(s => ({ ...s, loading: false, loaded: true, outcome: null, session }))
  }, [])

  const follow = useCallback(() => {
    setFollowUntil(Date.now() + START_FOLLOW_MS)
    void read()
  }, [read])

  const reload = useCallback(() => void read(), [read])

  return { state, adopt, follow, reload, following }
}
