// scope-gate.ts — which DeGram scope profile may have a running backend (Phase 1301-35, G-25).
//
// A project switch makes the scope controller release the backend of the scope it leaves and start the next one.
// Before this gate main honoured every `ensureBackend(profile)`: the renderer's registry still held a wantOpen
// secondary for the left profile, saw its socket die and its reconnect ladder dialed `getConnection(left)`, so main
// respawned the backend it had just killed. The 3-slot pool filled with left scopes (0.1.9 desktop.log 11:18-11:32,
// «waiting for a free local slot») and once evicted the active backend.
//
// One scope owns a backend at a time. The controller's own start marks the scope (`allow`), its release unmarks it
// (`release`), and every other start of a `scope-<16 hex>` profile (a renderer dial, a boot-restored route of the
// previous run) is refused unless it is for the marked scope. Profiles that are not DeGram scope profiles are never
// touched. The refusal reads «no longer exists» so the renderer's reconnect ladder fail-stops instead of retrying
// (store/gateway.ts isMissingProfileError).
//
// The pool arbiter (electron/pool-retire.ts) must also never choose the active scope as an LRU or foreground-recovery
// victim: `guardPrepare` wraps its `prepare` step, and a null token means «not retired».

/** `scope-` + 16 lowercase hex (degram_variant/profiles.py profile_name_for_scope), bare or `conn:local::`-prefixed. */
export const SCOPE_PROFILE_KEY = /^(?:conn:local::)?scope-[0-9a-f]{16}$/

const LOCAL_PREFIX = 'conn:local::'

export interface ScopeBackendGateDeps {
  /** Receives one line the first time a profile is refused. The profile name stays out of it. */
  log: (message: string) => void
  /** Tell every window the pooled backend under this key is going away, BEFORE it is stopped. */
  broadcastRetiring: (poolKey: string) => void
  /** The pool keys a profile's backend may live under (bare and `conn:local::`). */
  poolKeys: (profile: string) => string[]
}

const bare = (key: string): string => {
  const normalized = String(key ?? '')
    .trim()
    .toLowerCase()

  return normalized.startsWith(LOCAL_PREFIX) ? normalized.slice(LOCAL_PREFIX.length) : normalized
}

/** True for a DeGram scope profile name (or its local pool key). */
export const isScopeProfile = (key: string): boolean => SCOPE_PROFILE_KEY.test(String(key ?? '').trim().toLowerCase())

export function createScopeBackendGate(deps: ScopeBackendGateDeps) {
  let active: string | null = null
  const refused = new Set<string>()

  const isActive = (key: string): boolean => active !== null && bare(key) === active

  return {
    /** The scope controller is starting this scope's backend: it becomes the one active scope profile. */
    allow: (profile: string): void => {
      active = bare(profile)
      refused.delete(active)
    },

    /**
     * The scope controller releases the scope it leaves (switch, sign-out, failed start). The profile stops being
     * active, every window parks the scopes riding it BEFORE the child is killed (so the dying socket does not start
     * a reconnect ladder), then `teardown` stops it.
     */
    release: async (profile: string, teardown: () => Promise<void>): Promise<void> => {
      if (isActive(profile)) {
        active = null
      }

      for (const key of deps.poolKeys(profile)) {
        deps.broadcastRetiring(key)
      }

      await teardown()
    },

    /** Called at the head of every backend start. Throws for a scope profile that is not the active scope. */
    assertCanStart: (key: string): void => {
      if (!isScopeProfile(key) || isActive(key)) {
        return
      }

      const name = bare(key)

      if (!refused.has(name)) {
        refused.add(name)
        deps.log('[degram] refused to start the backend of a scope profile that is not the active scope')
      }

      throw new Error(`DeGram scope profile "${name}" no longer exists in this window (it is not the active scope)`)
    },

    isActive,

    /** Wrap the pool arbiter's `prepare` so the active scope's backend is never chosen for retirement. */
    guardPrepare:
      <A extends unknown[]>(prepare: (key: string, ...rest: A) => Promise<string | null>) =>
      (key: string, ...rest: A): Promise<string | null> =>
        isActive(key) ? Promise.resolve(null) : prepare(key, ...rest)
  }
}

export type ScopeBackendGate = ReturnType<typeof createScopeBackendGate>
