// DeGram runtime isolation (Phase 1301, D-01/D-02): the degram variant owns its
// identity, a fixed home under %LOCALAPPDATA%\DeGram, and refuses to boot when
// that home touches any Hermes home. Inherited Hermes home sources are ignored.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test, vi } from 'vitest'

import { resolveDesktopHermesHome, resolveDesktopUserData } from '../data-paths'
import type { applyDesktopIdentity, ProductIdentity } from '../product-identity'

import {
  assertNoHermesOverlap,
  deepLinkProtocols,
  DegramIsolationError,
  type DegramPathInputs,
  type DegramPaths,
  degramProcessEnv,
  isolatedBackendRequired,
  resolveDegramPaths
} from './isolation'

const require: NodeJS.Require = createRequire(import.meta.url)
const LOCAL = 'C:\\Users\\tester\\AppData\\Local'
const HOME = 'C:\\Users\\tester'
const DEGRAM_HOME = `${LOCAL}\\DeGram\\home`
const DEGRAM_USER_DATA = `${LOCAL}\\DeGram\\userData`

beforeEach((): void => {
  vi.resetModules()
})

afterEach((): void => {
  delete process.env.HERMES_DESKTOP_VARIANT
  delete process.env.HERMES_PAYLOAD_TAG
  delete process.env.HERMES_BUILD_COMMIT
  vi.resetModules()
})

function inputs(over: Partial<DegramPathInputs> = {}): DegramPathInputs {
  return { env: {}, localAppData: LOCAL, homedir: HOME, platform: 'win32', readRegistry: () => null, ...over }
}

async function identityForVariant(variant: string | undefined): Promise<ProductIdentity> {
  if (variant === undefined) {
    delete process.env.HERMES_DESKTOP_VARIANT
  } else {
    process.env.HERMES_DESKTOP_VARIANT = variant
  }

  delete require.cache[require.resolve('../../product-identity.cjs')]
  vi.resetModules()

  return (await import('../product-identity')).PRODUCT_IDENTITY
}

test('degram variant has its own product identity (D-01)', async (): Promise<void> => {
  const degram: ProductIdentity = await identityForVariant('degram')
  assert.equal(degram.displayName, 'DeGram')
  assert.equal(degram.appId, 'com.erarchitech.degram')
  assert.equal(degram.cliName, 'degram')
  assert.equal(degram.channel, null)
  assert.equal(degram.degram, true)
  assert.equal(degram.light, false)
  assert.equal(degram.store, false)
  assert.equal(degram.appNamePascal, 'DeGram')

  for (const variant of [undefined, 'bundled', 'light'] as const) {
    const hermes: ProductIdentity = await identityForVariant(variant)
    assert.notEqual(hermes.degram, true)

    for (const field of [
      'displayName',
      'appId',
      'appNamePascal',
      'msixAppIdWithOrg',
      'windowsExecutableName',
      'cliName'
    ] as const) {
      assert.notEqual(degram[field], hermes[field], `${field} must differ from Hermes variant ${variant}`)
    }
  }
})

test('degram never inherits canary or commit suffixes or a release channel', async (): Promise<void> => {
  const plain: ProductIdentity = await identityForVariant('degram')
  process.env.HERMES_PAYLOAD_TAG = 'v1.2.3+canary.20260818T000000Z'
  process.env.HERMES_BUILD_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
  const noisy: ProductIdentity = await identityForVariant('degram')
  assert.deepEqual(noisy, plain)
})

test('degram pins userData to its own directory, not a Hermes one (D-01)', async (): Promise<void> => {
  const degram: ProductIdentity = await identityForVariant('degram')
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('../product-identity')
  const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-userdata-'))
  const target: string = path.join(root, 'DeGram', 'userData')

  const paths: Record<string, string> = {
    appData: path.join(root, 'Roaming'),
    userData: path.join(root, 'Roaming', 'Hermes')
  }

  let name = 'Hermes'

  const app: Parameters<typeof applyDesktopIdentity>[0] = {
    getPath: (key: string): string => paths[key],
    setPath: (key: string, value: string): void => {
      paths[key] = value
    },
    setName: (value: string): void => {
      name = value
    }
  }

  try {
    assert.equal(runtime.applyDesktopIdentity(app, degram, target), 'DeGram')
    assert.equal(paths.userData, target)
    assert.ok(fs.statSync(target).isDirectory())
    assert.equal(name, 'DeGram')
    // The pin is unconditional for degram: appNamePascal === artifactNamePascal must not skip it.
    assert.equal(degram.appNamePascal, degram.artifactNamePascal)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('degram identity without a resolved userData refuses to guess one', async (): Promise<void> => {
  const degram: ProductIdentity = await identityForVariant('degram')
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('../product-identity')

  const app: Parameters<typeof applyDesktopIdentity>[0] = {
    getPath: (): string => 'C:\\appdata',
    setPath: (): void => {
      throw new Error('must not pin an unresolved userData')
    },
    setName: (): void => {
      throw new Error('must not rename')
    }
  }

  assert.throws(() => runtime.applyDesktopIdentity(app, degram), /DeGram/)
})

test('home and userData are fixed under LOCALAPPDATA\\DeGram (D-02)', (): void => {
  const paths: DegramPaths = resolveDegramPaths(inputs())
  assert.equal(paths.root, `${LOCAL}\\DeGram`)
  assert.equal(paths.home, DEGRAM_HOME)
  assert.equal(paths.userData, DEGRAM_USER_DATA)
})

test('LOCALAPPDATA falls back to the home-relative default when not injected', (): void => {
  const paths: DegramPaths = resolveDegramPaths(inputs({ localAppData: undefined, env: { LOCALAPPDATA: 'D:\\Data' } }))
  assert.equal(paths.home, 'D:\\Data\\DeGram\\home')
  const bare: DegramPaths = resolveDegramPaths(inputs({ localAppData: undefined }))
  assert.equal(bare.home, `${HOME}\\AppData\\Local\\DeGram\\home`)
})

test('every inherited Hermes home source is ignored, individually and together (D-02)', (): void => {
  const expected: DegramPaths = resolveDegramPaths(inputs())

  const sources: Array<[string, Partial<DegramPathInputs>]> = [
    ['env HERMES_HOME', { env: { HERMES_HOME: 'E:\\elsewhere\\hermes-home' } }],
    ['registry HERMES_HOME', { readRegistry: (): string => 'F:\\registry\\hermes-home' }],
    ['HERMES_DESKTOP_USER_DATA_DIR', { env: { HERMES_DESKTOP_USER_DATA_DIR: 'G:\\rehearsal\\user-data' } }],
    ['HERMES_DATA_DIR_SUFFIX', { env: { HERMES_DATA_DIR_SUFFIX: '-dev' } }],
    ['legacy ~/.hermes', { homedir: HOME }]
  ]

  for (const [label, over] of sources) {
    assert.deepEqual(resolveDegramPaths(inputs(over)), expected, `${label} must not move the degram home`)
  }

  const all: DegramPathInputs = inputs({
    env: {
      HERMES_HOME: 'E:\\elsewhere\\hermes-home',
      HERMES_DESKTOP_USER_DATA_DIR: 'G:\\rehearsal\\user-data',
      HERMES_DATA_DIR_SUFFIX: '-dev'
    },
    readRegistry: (): string => 'F:\\registry\\hermes-home'
  })

  assert.deepEqual(resolveDegramPaths(all), expected)
  // A disjoint inherited home is fine at boot: it is ignored, not an overlap.
  assert.doesNotThrow(() => assertNoHermesOverlap(expected, all))
})

test('resolving paths never consults the registry or filesystem', (): void => {
  const registry = vi.fn((): string | null => {
    throw new Error('registry must not be read to resolve the degram home')
  })

  assert.deepEqual(resolveDegramPaths(inputs({ readRegistry: registry })), resolveDegramPaths(inputs()))
  assert.equal(registry.mock.calls.length, 0)
})

test('the shared resolvers return a fixed home before any env, registry or legacy lookup', (): void => {
  const registry = vi.fn((): string | null => {
    throw new Error('registry consulted')
  })

  const exists = vi.fn((): boolean => {
    throw new Error('filesystem consulted')
  })

  const env: NodeJS.ProcessEnv = {
    HERMES_HOME: 'E:\\elsewhere',
    HERMES_DESKTOP_USER_DATA_DIR: 'G:\\rehearsal',
    HERMES_DATA_DIR_SUFFIX: '-dev'
  }

  assert.equal(
    resolveDesktopHermesHome({
      home: HOME,
      env,
      platform: 'win32',
      directoryExists: exists,
      readWindowsHome: registry,
      fixedHome: DEGRAM_HOME
    }),
    DEGRAM_HOME
  )

  assert.equal(registry.mock.calls.length, 0)
  assert.equal(exists.mock.calls.length, 0)
  assert.equal(resolveDesktopUserData('C:\\appdata\\Hermes', env, DEGRAM_USER_DATA), DEGRAM_USER_DATA)
})

test('degram boot is a hard overlap failure against every Hermes home candidate', (): void => {
  const paths: DegramPaths = resolveDegramPaths(inputs())

  // [label, inputs whose Hermes candidate collides with the degram home]
  const collisions: Array<[string, Partial<DegramPathInputs>, string]> = [
    ['env HERMES_HOME equals the degram home', { env: { HERMES_HOME: DEGRAM_HOME } }, DEGRAM_HOME],
    [
      'env HERMES_HOME inside the degram home',
      { env: { HERMES_HOME: `${DEGRAM_HOME}\\sub\\dir` } },
      `${DEGRAM_HOME}\\sub\\dir`
    ],
    ['env HERMES_HOME contains the degram home', { env: { HERMES_HOME: `${LOCAL}\\DeGram` } }, `${LOCAL}\\DeGram`],
    ['registry HERMES_HOME equals', { readRegistry: (): string => DEGRAM_HOME }, DEGRAM_HOME],
    ['registry HERMES_HOME contains', { readRegistry: (): string => LOCAL }, LOCAL],
    [
      'forward slashes and case differences still collide',
      { env: { HERMES_HOME: 'c:/USERS/Tester/appdata/local/DEGRAM/Home' } },
      'c:\\USERS\\Tester\\appdata\\local\\DEGRAM\\Home'
    ],
    [
      'a profiles/-rooted HERMES_HOME names its parent, which contains the degram home',
      { env: { HERMES_HOME: `${LOCAL}\\DeGram\\profiles\\work` } },
      `${LOCAL}\\DeGram`
    ],
    ['trailing separators do not hide an overlap', { env: { HERMES_HOME: `${DEGRAM_HOME}\\\\` } }, DEGRAM_HOME],
    ['userData collides too', { env: { HERMES_HOME: DEGRAM_USER_DATA } }, DEGRAM_USER_DATA]
  ]

  for (const [label, over, hermesPath] of collisions) {
    assert.throws(
      () => assertNoHermesOverlap(paths, inputs(over)),
      (error: unknown): boolean => {
        assert.ok(error instanceof DegramIsolationError, label)
        assert.equal(error.code, 'HOME_OVERLAP', label)
        assert.equal(
          error.path.toLowerCase().replaceAll('/', '\\').replace(/\\+$/, ''),
          hermesPath.toLowerCase().replaceAll('/', '\\').replace(/\\+$/, ''),
          label
        )
        assert.ok(error.message.includes('HOME_OVERLAP'), label)
        assert.ok(error.message.includes(error.path), label)

        return true
      },
      label
    )
  }
})

test('default Hermes homes are overlap candidates when a relocated LOCALAPPDATA lands on them', (): void => {
  // %LOCALAPPDATA% pointed at the Hermes home's parent chain: degram root sits
  // inside the default Hermes home %LOCALAPPDATA%\hermes -> fail closed.
  const trapped: string = `${HOME}\\AppData\\Local\\hermes\\nested`
  const insideDefault: DegramPaths = resolveDegramPaths(inputs({ localAppData: trapped }))
  assert.throws(
    () =>
      assertNoHermesOverlap(
        insideDefault,
        inputs({ localAppData: trapped, env: { LOCALAPPDATA: `${HOME}\\AppData\\Local` } })
      ),
    /HOME_OVERLAP/
  )

  const legacy: DegramPaths = resolveDegramPaths(inputs({ localAppData: `${HOME}\\.hermes\\x` }))
  assert.throws(
    () => assertNoHermesOverlap(legacy, inputs({ localAppData: `${HOME}\\.hermes\\x` })),
    (error: unknown): boolean => error instanceof DegramIsolationError && error.code === 'HOME_OVERLAP'
  )
})

test('the standard layout (LOCALAPPDATA\\DeGram beside LOCALAPPDATA\\hermes) boots clean', (): void => {
  const paths: DegramPaths = resolveDegramPaths(inputs())

  assert.doesNotThrow(() =>
    assertNoHermesOverlap(
      paths,
      inputs({
        env: { HERMES_HOME: `${LOCAL}\\hermes`, LOCALAPPDATA: LOCAL },
        readRegistry: (): string => `${LOCAL}\\hermes-dev`
      })
    )
  )

  // A sibling that merely shares a name prefix is not a containment.
  assert.doesNotThrow(() => assertNoHermesOverlap(paths, inputs({ env: { HERMES_HOME: `${LOCAL}\\DeGramX` } })))
})

test('degram never attaches to a host Hermes backend (D-02)', (): void => {
  for (const env of [{}, { HERMES_DESKTOP_ISOLATED_BACKEND: '0' }, { HERMES_DESKTOP_ISOLATED_BACKEND: '1' }]) {
    assert.equal(isolatedBackendRequired({ degram: true }, env), true)
  }

  assert.equal(isolatedBackendRequired({ degram: false }, {}), false)
  assert.equal(isolatedBackendRequired({}, {}), false)
  assert.equal(isolatedBackendRequired({ degram: false }, { HERMES_DESKTOP_ISOLATED_BACKEND: '1' }), true)
})

test('degram owns the degram:// protocol and never answers hermes:// (T-1301-04-04)', (): void => {
  assert.deepEqual(deepLinkProtocols({ degram: true }, false), { primary: 'degram', accepted: ['degram'] })
  assert.deepEqual(deepLinkProtocols({ degram: true }, true), {
    primary: 'degram-dev',
    accepted: ['degram-dev', 'degram']
  })
  assert.deepEqual(deepLinkProtocols({ degram: false }, false), { primary: 'hermes', accepted: ['hermes'] })
  assert.deepEqual(deepLinkProtocols({}, true), { primary: 'hermes-dev', accepted: ['hermes-dev', 'hermes'] })
})

test('degram process env pins the home, isolates the backend and drops inherited home selectors', (): void => {
  const paths: DegramPaths = resolveDegramPaths(inputs())

  const env: NodeJS.ProcessEnv = {
    HERMES_HOME: 'E:\\elsewhere',
    HERMES_DESKTOP_USER_DATA_DIR: 'G:\\rehearsal',
    HERMES_DATA_DIR_SUFFIX: '-dev',
    PATH: 'C:\\bin'
  }

  const before: NodeJS.ProcessEnv = { ...env }
  const next: NodeJS.ProcessEnv = degramProcessEnv(env, paths)
  assert.equal(next.HERMES_HOME, DEGRAM_HOME)
  assert.equal(next.HERMES_DESKTOP_ISOLATED_BACKEND, '1')
  assert.equal(next.HERMES_DESKTOP_USER_DATA_DIR, undefined)
  assert.equal(next.HERMES_DATA_DIR_SUFFIX, undefined)
  assert.equal(next.PATH, 'C:\\bin')
  assert.deepEqual(env, before, 'pure: the input env is not mutated')
})
