// scope-gate.test.ts — one DeGram scope profile owns a backend at a time (Phase 1301-35, G-25).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPoolRetirer, type PoolRetireEntry } from '../pool-retire'
import { LocalBackendSpawnCoordinator } from '../pool-spawn-coordinator'

import { createScopeBackendGate, isScopeProfile, SCOPE_PROFILE_KEY } from './scope-gate'

const A = 'scope-00000000000000aa'
const B = 'scope-00000000000000bb'

const gateWith = () => {
  const events: string[] = []

  const gate = createScopeBackendGate({
    log: message => events.push(`log:${message}`),
    broadcastRetiring: key => events.push(`retiring:${key}`),
    poolKeys: profile => [profile, `conn:local::${profile}`]
  })

  return { gate, events }
}

describe('scope profile names', () => {
  it('matches exactly `scope-` + 16 lowercase hex, bare or as the local pool key', () => {
    expect(SCOPE_PROFILE_KEY.test(A)).toBe(true)
    expect(isScopeProfile(`conn:local::${A}`)).toBe(true)
    expect(isScopeProfile(A.toUpperCase())).toBe(true)

    for (const other of ['default', 'scope-', 'scope-123', `${A}0`, `x${A}`, 'conn:ssh::' + A, 'work', '']) {
      expect(isScopeProfile(other)).toBe(false)
    }
  })
})

describe('createScopeBackendGate', () => {
  it('refuses every scope profile until the scope controller allows one', () => {
    const { gate } = gateWith()

    expect(() => gate.assertCanStart(A)).toThrow(/no longer exists/)
    gate.allow(A)
    expect(() => gate.assertCanStart(A)).not.toThrow()
    expect(() => gate.assertCanStart(`conn:local::${A}`)).not.toThrow()
    expect(() => gate.assertCanStart(B)).toThrow(/no longer exists/)
  })

  it('never refuses a profile that is not a DeGram scope profile', () => {
    const { gate } = gateWith()

    for (const profile of ['default', 'work', 'conn:local::work', '']) {
      expect(() => gate.assertCanStart(profile)).not.toThrow()
    }
  })

  it('allowing the next scope makes the previous one a refused profile', () => {
    const { gate } = gateWith()

    gate.allow(A)
    gate.allow(B)
    expect(() => gate.assertCanStart(A)).toThrow()
    expect(() => gate.assertCanStart(B)).not.toThrow()
  })

  it('release unmarks the scope, tells the windows BEFORE the teardown, then tears down', async () => {
    const { gate, events } = gateWith()

    gate.allow(A)

    await gate.release(A, async () => {
      events.push('teardown')
    })

    expect(events).toEqual([`retiring:${A}`, `retiring:conn:local::${A}`, 'teardown'])
    expect(gate.isActive(A)).toBe(false)
    expect(() => gate.assertCanStart(A)).toThrow()
  })

  it('releasing a profile that is not the active one leaves the active scope alone', async () => {
    const { gate } = gateWith()

    gate.allow(B)
    await gate.release(A, async () => undefined)
    expect(gate.isActive(B)).toBe(true)
    expect(() => gate.assertCanStart(B)).not.toThrow()
  })

  it('logs a refusal once per profile, without the profile name, and logs again after the profile was allowed', () => {
    const { gate, events } = gateWith()

    for (let i = 0; i < 4; i += 1) {
      expect(() => gate.assertCanStart(A)).toThrow()
    }

    expect(events.filter(event => event.startsWith('log:'))).toHaveLength(1)
    expect(events.join('\n')).not.toContain(A)

    gate.allow(A)
    gate.allow(B)
    expect(() => gate.assertCanStart(A)).toThrow()
    expect(events.filter(event => event.startsWith('log:'))).toHaveLength(2)
  })
})

describe('the pool arbiter never picks the active scope (guardPrepare)', () => {
  it('LRU eviction skips the active scope even when it is the oldest, and retires the others', async () => {
    const { gate } = gateWith()

    const pool = new Map<string, PoolRetireEntry>([
      [A, { process: {}, lastActiveAt: 1 }],
      ['old-tool', { process: {}, lastActiveAt: 2 }],
      ['newer-tool', { process: {}, lastActiveAt: 3 }]
    ])

    const prepared: string[] = []
    const stopped: string[] = []

    gate.allow(A)

    const retirer = createPoolRetirer({
      pool,
      coordinator: new LocalBackendSpawnCoordinator(3),
      prepare: gate.guardPrepare(async key => {
        prepared.push(key)

        return 'permit'
      }),
      commit: async () => true,
      cancel: async () => undefined,
      stopBackend: async key => {
        stopped.push(key)
        pool.delete(key)
      }
    })

    try {
      // keep 0: every candidate is over the cap and stale; only the active scope may survive.
      await retirer.evictTo(0, 0)
    } finally {
      retirer.dispose()
    }

    expect(stopped).toEqual(['old-tool', 'newer-tool'])
    expect(prepared).toEqual(['old-tool', 'newer-tool'])
    expect([...pool.keys()]).toEqual([A])
  })

  it('idle retirement of the active scope is also declined, and a non-active scope is retired as before', async () => {
    const { gate } = gateWith()

    const pool = new Map<string, PoolRetireEntry>([
      [A, { process: {}, lastActiveAt: 1 }],
      [B, { process: {}, lastActiveAt: 1 }]
    ])

    const stopped: string[] = []

    gate.allow(A)

    const retirer = createPoolRetirer({
      pool,
      coordinator: new LocalBackendSpawnCoordinator(3),
      prepare: gate.guardPrepare(async () => 'permit'),
      commit: async () => true,
      cancel: async () => undefined,
      stopBackend: async key => {
        stopped.push(key)
        pool.delete(key)
      }
    })

    try {
      expect(await retirer.retireIdle(A, 1000)).toBe(false)
      expect(await retirer.retireIdle(B, 1000)).toBe(true)
    } finally {
      retirer.dispose()
    }

    expect(stopped).toEqual([B])
  })
})

describe('main.ts wiring (source pins; main.ts cannot be imported in a unit test)', () => {
  const main = readFileSync(resolve(__dirname, '..', 'main.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('hands the scope controller allow/release and gates both backend start paths for the DeGram identity', () => {
    expect(main).toContain("import { createScopeBackendGate } from './degram/scope-gate'")
    expect(main).toMatch(/ensure: async \(profile: string\) => \{\n\s*\/\/[^\n]*\n\s*scopeGate\.allow\(profile\)\n\s*await ensureBackend\(profile,/)
    expect(main).toMatch(/scopeGate\.release\(profile, \(\): Promise<void> => teardownPoolBackendAndWait\(profile\)\)/)
    // ensureBackend and ensureRegistryBackend (the local source): after the deletion gate, only for the DeGram identity.
    expect(main.match(/if \(PRODUCT_IDENTITY\.degram\) \{\n\s*scopeGate\.assertCanStart\((key|profileKey)\)\n\s*\}/g)).toHaveLength(2)
  })

  it('wraps the pool arbiter prepare step so the active scope is never retired', () => {
    expect(main).toMatch(/prepare: scopeGate\.guardPrepare\(poolRetirementClient\.prepare\)/)
  })
})
