// DeGram build identity (Phase 1301, D-01/D-03/D-04), proven offline: the
// resolved electron-builder config, the build stamp and the updater strategy
// are asserted as data. Nothing here runs electron-builder, a build or the app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test, vi } from 'vitest'

const electronNet = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn() }))

vi.mock('electron', () => ({ net: electronNet, app: {} }))

const require = createRequire(import.meta.url)

const ENV_KEYS = [
  'HERMES_DESKTOP_VARIANT',
  'HERMES_PAYLOAD_TAG',
  'HERMES_BUILD_COMMIT',
  'HERMES_PAYLOAD_VERSION',
  'AZURE_SIGN_ENDPOINT',
  'AZURE_CLIENT_ID',
  'CLOUDFLARE_R2_PUBLIC_URL'
]

let saved = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

function loadConfig(variant) {
  if (variant === undefined) delete process.env.HERMES_DESKTOP_VARIANT
  else process.env.HERMES_DESKTOP_VARIANT = variant
  delete require.cache[require.resolve('../product-identity.cjs')]
  delete require.cache[require.resolve('../electron-builder.config.cjs')]

  return require('../electron-builder.config.cjs')
}

test('degram builder config: identity, protocol and no release feed', () => {
  const config = loadConfig('degram')
  assert.equal(config.appId, 'com.erarchitech.degram')
  assert.equal(config.productName, 'DeGram')
  assert.equal(config.executableName, 'DeGram')
  assert.deepEqual(config.protocols.map(entry => entry.schemes), [['degram']])
  assert.equal(config.publish, null)
  assert.equal(config.mac.publish, null)
  assert.equal(config.extraMetadata.desktopName, 'com.erarchitech.degram')
})

// electron-builder derives the exe CompanyName, the default LegalCopyright and the NSIS
// uninstall Publisher from package `author`, merged with extraMetadata. DeGram is not a
// Nous Research product; the stock variants keep the upstream vendor.
test('degram exe vendor is Erarchitech, not Nous Research', () => {
  assert.equal(loadConfig('degram').extraMetadata.author, 'Erarchitech')

  for (const variant of [undefined, 'bundled', 'light', 'store']) {
    assert.equal(loadConfig(variant).extraMetadata.author, undefined, `variant ${variant ?? '(default)'}`)
  }
})

// F-05: DeGram carries its own pilot version (0.x, patch +1 per installer build, never
// reused) through extraMetadata, which electron-builder applies to app.getVersion(), the
// exe version resource and the installer filename. The shared package.json stays 0.0.0.
test('degram has its own semver pilot version; stock variants keep package.json', () => {
  const version = loadConfig('degram').extraMetadata.version
  assert.match(version, /^0\.\d+\.\d+$/)
  assert.notEqual(version, '0.0.0')

  for (const variant of [undefined, 'bundled', 'light', 'store']) {
    assert.equal(loadConfig(variant).extraMetadata.version, undefined, `variant ${variant ?? '(default)'}`)
  }
})

test('degram builds an unsigned NSIS target with the bundled Python payload (D-04)', () => {
  const config = loadConfig('degram')
  assert.deepEqual(config.win.target, ['nsis'])
  assert.deepEqual(config.nsis, {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'DeGram-Setup-${version}.${ext}'
  })
  assert.equal(config.artifactName, 'DeGram-Setup-${version}.${ext}')
  assert.ok(
    config.extraResources.some(entry => entry.from === 'build/agent-payload' && entry.to === 'agent-payload'),
    'the bundled payload must ship as an extraResource'
  )
  // Without Azure signing credentials the Windows config carries no signer: unsigned, by design.
  assert.equal(config.win.sign, undefined)
})

test('degram never targets MSIX; the other variants keep their targets', () => {
  const degram = loadConfig('degram')
  assert.ok(!degram.win.target.includes('msix'))

  for (const variant of [undefined, 'bundled', 'light', 'store']) {
    const config = loadConfig(variant)
    assert.deepEqual(config.win.target, ['msix'], `variant ${variant ?? '(default)'} stays MSIX`)
    assert.equal(config.nsis, undefined)
    assert.deepEqual(config.protocols.map(entry => entry.schemes), [['hermes']])
  }

  assert.ok(
    loadConfig('bundled').extraResources.some(entry => entry.to === 'agent-payload'),
    'bundled still ships its payload'
  )
  assert.ok(
    !loadConfig('light').extraResources.some(entry => entry.to === 'agent-payload'),
    'light still ships none'
  )
})

test('degram ignores ambient canary and commit selectors in the builder config', () => {
  process.env.HERMES_PAYLOAD_TAG = 'v1.2.3+canary.20260818T000000Z'
  process.env.HERMES_BUILD_COMMIT = 'a'.repeat(40)
  const config = loadConfig('degram')
  assert.equal(config.appId, 'com.erarchitech.degram')
  assert.equal(config.productName, 'DeGram')
  assert.equal(config.publish, null)
})

test('degram build stamp: external updates on every platform and a bundled payload (D-03)', async () => {
  const { buildStampPayload } = await import('./write-build-stamp.mjs')
  const provenance = { commit: 'a'.repeat(40), branch: 'main', dirty: false, source: 'ci' }

  const runtime = {
    repoDir: 'app',
    toolsDir: 'tools',
    storePython: 'tools/python/python',
    sitePackages: 'deps',
    commands: { hermes: 'bin/degram' }
  }

  for (const platform of ['win32', 'darwin', 'linux']) {
    const stamp = buildStampPayload(provenance, { HERMES_DESKTOP_VARIANT: 'degram' }, platform, { runtime })
    assert.equal(stamp.updateMechanism, 'external', platform)
    assert.equal(stamp.variant, 'degram')
    assert.equal(stamp.payload, 'bundled')
    assert.deepEqual(stamp.runtime, runtime)
    assert.equal(stamp.distribution, 'desktop-app')
  }

  // Bundled semantics: a degram stamp without a completed payload contract is refused.
  assert.throws(
    () => buildStampPayload(provenance, { HERMES_DESKTOP_VARIANT: 'degram' }, 'win32', null),
    /payload/i
  )

  // Other variants never carry the degram marker.
  const bundled = buildStampPayload(provenance, { HERMES_DESKTOP_VARIANT: 'bundled' }, 'win32', { runtime })
  assert.equal(bundled.variant, undefined)
})

test('degram commit builds stay external (no update channel either way)', async () => {
  const { buildStampPayload } = await import('./write-build-stamp.mjs')
  const sha = 'b'.repeat(40)

  const runtime = {
    repoDir: 'app',
    toolsDir: 'tools',
    storePython: 'tools/python/python',
    sitePackages: 'deps',
    commands: { hermes: 'bin/degram' }
  }

  const stamp = buildStampPayload(
    { commit: sha, branch: null, dirty: false, source: 'commit-build' },
    { HERMES_DESKTOP_VARIANT: 'degram', HERMES_BUILD_COMMIT: sha },
    'win32',
    { runtime }
  )

  assert.equal(stamp.updateMechanism, 'external')
})

test('degram launchers are qualified with the degram CLI name', async () => {
  const { stageDesktopLaunchers } = await import('./write-build-stamp.mjs')
  const identity = (await loadIdentity('degram'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-launchers-'))

  try {
    fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'bin', 'hermes.exe'), 'x')
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ target: 'win32-x64', runtime: { commands: { hermes: 'bin/hermes.exe' } } })
    )
    const manifest = stageDesktopLaunchers(root, identity)
    assert.deepEqual(manifest.launchers, ['degram'])
    assert.equal(manifest.runtime.commands.hermes, 'bin/degram.exe')
    assert.ok(fs.existsSync(path.join(root, 'bin', 'degram.exe')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function loadIdentity(variant) {
  process.env.HERMES_DESKTOP_VARIANT = variant
  delete require.cache[require.resolve('../product-identity.cjs')]

  return require('../product-identity.cjs')
}

test('before-build never generates MSIX manifests or assets for degram', async () => {
  process.env.HERMES_DESKTOP_VARIANT = 'degram'
  delete require.cache[require.resolve('../product-identity.cjs')]
  const buildDir = path.join(import.meta.dirname, '..', 'build')

  const snapshot = () => {
    if (!fs.existsSync(buildDir)) return []

    return fs
      .readdirSync(buildDir, { recursive: true })
      .map(entry => {
        const full = path.join(buildDir, String(entry))

        return `${entry}:${fs.statSync(full).mtimeMs}`
      })
      .sort()
  }

  const before = snapshot()
  const beforeBuild = (await import('./before-build.mjs')).default
  assert.equal(await beforeBuild(), false)
  assert.deepEqual(snapshot(), before, 'degram before-build must not write MSIX staging files')
  assert.ok(!fs.existsSync(path.join(buildDir, 'msix-manifest.xml')) || before.some(e => e.startsWith('msix-manifest.xml')))
  assert.ok(!fs.existsSync(path.join(buildDir, 'msix-extensions.xml')) || before.some(e => e.startsWith('msix-extensions.xml')))
})

test('degram updater strategy is external and records zero update-feed requests (D-03)', async () => {
  const fetchStub = vi.fn(() => Promise.reject(new Error('network must not be touched')))
  vi.stubGlobal('fetch', fetchStub)
  const httpsRequest = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('network must not be touched') })
  const httpsGet = vi.spyOn(https, 'get').mockImplementation(() => { throw new Error('network must not be touched') })
  const httpRequest = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('network must not be touched') })
  const httpGet = vi.spyOn(http, 'get').mockImplementation(() => { throw new Error('network must not be touched') })

  const { buildStampPayload } = await import('./write-build-stamp.mjs')
  const { resolveUpdaterMechanism } = await import('../electron/updater/index.ts')
  const { ExternalStrategy } = await import('../electron/updater/external.ts')

  const runtime = {
    repoDir: 'app',
    toolsDir: 'tools',
    storePython: 'tools/python/python',
    sitePackages: 'deps',
    commands: { hermes: 'bin/degram' }
  }

  for (const platform of ['win32', 'darwin', 'linux']) {
    const stamp = buildStampPayload(
      { commit: 'c'.repeat(40), branch: 'main', dirty: false, source: 'ci' },
      { HERMES_DESKTOP_VARIANT: 'degram' },
      platform,
      { runtime }
    )

    const mechanism = resolveUpdaterMechanism({ platform, updateMechanism: stamp.updateMechanism, source: stamp.source })
    assert.equal(mechanism, 'external', platform)

    const strategy = new ExternalStrategy(stamp)
    assert.equal(strategy.mechanism, 'external')
    const status = await strategy.check({ force: true })
    assert.equal(status.supported, false)
    assert.equal(status.updateAvailable, undefined)
    const applied = await strategy.apply()
    assert.equal(applied.mechanism, 'external')
  }

  assert.equal(fetchStub.mock.calls.length, 0)
  assert.equal(electronNet.request.mock.calls.length, 0)
  assert.equal(electronNet.fetch.mock.calls.length, 0)

  for (const spy of [httpsRequest, httpsGet, httpRequest, httpGet]) {
    assert.equal(spy.mock.calls.length, 0)
  }
})

test('degram builder config contains no NousResearch or GitHub release feed', () => {
  process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://example.invalid/feed'
  const config = loadConfig('degram')
  const serialized = JSON.stringify({ publish: config.publish, macPublish: config.mac.publish })
  assert.equal(serialized, '{"publish":null,"macPublish":null}')
  assert.ok(!/nousresearch|github/i.test(serialized))
})

// ---- Plan 1301-15: the revit-mcp adapter ships as a resource, and NSIS is an admitted prepared format ----

test('degram ships the read-only revit-mcp adapter as the revit-mcp resource, without tests, git or caches (D-04)', () => {
  const config = loadConfig('degram')
  const entry = config.extraResources.find(item => item.to === 'revit-mcp')
  assert.ok(entry, 'degram extraResources must carry the revit-mcp adapter')
  // The adapter is the sibling submodule of the framework checkout: apps/degram/apps/desktop -> apps/revit-mcp.
  assert.equal(path.resolve(entry.from), path.resolve(import.meta.dirname, '../../../../revit-mcp'))
  assert.ok(Array.isArray(entry.filter), 'the adapter copy must be filtered')

  for (const excluded of ['!tests/**', '!.git', '!.git/**', '!**/__pycache__/**', '!.venv/**', '!.pytest_cache/**']) {
    assert.ok(entry.filter.includes(excluded), `filter must exclude ${excluded}`)
  }

  // Nothing in the filter may re-include test or VCS material after the exclusions.
  assert.ok(!entry.filter.some(pattern => /^[^!].*(tests|\.git)/.test(pattern)))
  // The agent payload still ships next to it.
  assert.ok(config.extraResources.some(item => item.to === 'agent-payload'))
})

test('DEGRAM_REVIT_MCP_SOURCE overrides where the adapter is read from (builds of the fork outside the framework tree)', () => {
  process.env.DEGRAM_REVIT_MCP_SOURCE = path.join(os.tmpdir(), 'elsewhere', 'revit-mcp')

  try {
    const config = loadConfig('degram')
    const entry = config.extraResources.find(item => item.to === 'revit-mcp')
    assert.equal(path.resolve(entry.from), path.resolve(process.env.DEGRAM_REVIT_MCP_SOURCE))
  } finally {
    delete process.env.DEGRAM_REVIT_MCP_SOURCE
  }
})

test('no other variant ships the revit-mcp adapter', () => {
  for (const variant of [undefined, 'bundled', 'light', 'store']) {
    const config = loadConfig(variant)
    assert.ok(!config.extraResources.some(item => item.to === 'revit-mcp'), `variant ${variant ?? '(default)'}`)
  }
})

test('the packaged resource layout is the one resolveRevitAdapter looks for (resources/revit-mcp)', async () => {
  const { resolveRevitAdapter } = await import('../electron/degram/dg-config.ts')
  const resourcesPath = 'C:\\Users\\x\\AppData\\Local\\Programs\\DeGram\\resources'
  const bundled = `${resourcesPath}\\revit-mcp`

  const resolved = resolveRevitAdapter({
    env: {},
    home: 'C:\\Users\\x\\AppData\\Local\\DeGram\\home',
    readFile: () => null,
    platform: 'win32',
    resourcesPath,
    exists: file => file === bundled || file === `${bundled}\\.venv\\Scripts\\python.exe`
  })

  assert.equal(resolved.mcpDir, bundled)
  assert.equal(resolved.python, `${bundled}\\.venv\\Scripts\\python.exe`)
})

function preparedInputs(formats) {
  return { formats, target: 'win32-x64' }
}

test('NSIS is an admitted prepared format on Windows (plan 04 finding)', async () => {
  const { validatePreparedBuilderArgs } = await import('./run-electron-builder.mjs')
  validatePreparedBuilderArgs(['--win', 'nsis', '--x64'], preparedInputs(['nsis']))
  // An NSIS request against inputs prepared only for MSIX is still refused, never repaired.
  assert.throws(() => validatePreparedBuilderArgs(['--win', 'nsis'], preparedInputs(['msix'])), /not prepared: nsis/)
})

test('the default Windows package format is nsis for degram and msix for every other variant', async () => {
  const { validatePreparedBuilderArgs } = await import('./run-electron-builder.mjs')
  process.env.HERMES_DESKTOP_VARIANT = 'degram'
  validatePreparedBuilderArgs(['--win'], preparedInputs(['nsis']))
  assert.throws(() => validatePreparedBuilderArgs(['--win'], preparedInputs(['msix'])), /not prepared: nsis/)

  process.env.HERMES_DESKTOP_VARIANT = 'bundled'
  validatePreparedBuilderArgs(['--win'], preparedInputs(['msix']))
  assert.throws(() => validatePreparedBuilderArgs(['--win'], preparedInputs(['nsis'])), /not prepared: msix/)
})

test('packaging preparation supports nsis on win32 only and defaults it for degram', async () => {
  const { supportedPackagingFormats, defaultPackagingFormats } = await import('./prepare-packaging-tools.mjs')
  assert.ok(supportedPackagingFormats('win32').includes('nsis'))
  assert.ok(supportedPackagingFormats('win32').includes('msix'))
  assert.ok(!supportedPackagingFormats('darwin').includes('nsis'))
  assert.ok(!supportedPackagingFormats('linux').includes('nsis'))
  assert.deepEqual(defaultPackagingFormats('win32', 'degram'), ['nsis'])
  assert.deepEqual(defaultPackagingFormats('win32', 'bundled'), ['msix'])
  assert.deepEqual(defaultPackagingFormats('win32', undefined), ['msix'])
  assert.deepEqual(defaultPackagingFormats('darwin', 'degram'), ['dmg', 'zip'])
})

test('the NSIS toolset comes from the builder pinned supplier and is copied into the work directory', async () => {
  const { prepareNsisToolset } = await import('./prepare-packaging-tools.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-toolset-'))

  try {
    const bundle = path.join(root, 'cache', 'nsis-bundle')
    fs.mkdirSync(path.join(bundle, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'makensis.cmd'), '@echo off')
    fs.writeFileSync(path.join(bundle, 'elevate.exe'), 'x')
    const out = path.join(root, 'work')
    fs.mkdirSync(out)
    const calls = []

    const nsis = await prepareNsisToolset({
      load: async relative => {
        assert.equal(relative, 'toolsets/nsis.js')

        return {
          getMakeNsisPath: async (setting, resourcesDir) => {
            calls.push([setting, resourcesDir])

            return { path: path.join(bundle, 'makensis.cmd') }
          }
        }
      },
      config: {},
      resourcesDir: path.join(root, 'build'),
      out
    })

    assert.equal(nsis, path.join(out, 'nsis'))
    assert.ok(fs.existsSync(path.join(nsis, 'makensis.cmd')))
    assert.ok(fs.existsSync(path.join(nsis, 'plugins')))
    assert.deepEqual(calls, [[undefined, path.join(root, 'build')]])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('prepared inputs for nsis are refused without the prepared NSIS toolset', async () => {
  const prepared = await import('./prepared-packaging.mjs')
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-nsis-'))

  try {
    const out = path.join(source, 'work')
    fs.mkdirSync(path.join(source, 'apps/desktop'), { recursive: true })
    fs.writeFileSync(path.join(source, 'package-lock.json'), '{}')
    fs.writeFileSync(path.join(source, 'apps/desktop/package.json'), '{}')
    fs.writeFileSync(path.join(source, 'apps/desktop/electron-builder.config.cjs'), 'module.exports = {}')
    const electron = path.join(out, 'electron.zip')
    const sevenZip = path.join(out, 'sevenZip')
    const icons = path.join(out, 'icons')
    const nsis = path.join(out, 'nsis')

    for (const dir of [sevenZip, icons, nsis]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(electron, 'archive fixture')
    fs.writeFileSync(path.join(nsis, 'makensis.cmd'), '@echo off')

    const withNsis = await prepared.publishPackagingInputs({
      source,
      out,
      electron,
      target: 'linux-x64',
      formats: ['nsis'],
      toolsets: { sevenZip, icons, nsis }
    })

    assert.deepEqual(prepared.readPackagingInputs(withNsis, source, 'linux-x64').toolsets.nsis, nsis)

    const without = await prepared.publishPackagingInputs({
      source,
      out,
      electron,
      target: 'linux-x64',
      formats: ['nsis'],
      toolsets: { sevenZip, icons }
    })

    assert.throws(() => prepared.readPackagingInputs(without, source, 'linux-x64'), /NSIS|nsis/)
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
  }
})

// ---- Plan 1301-15 launch finding: the identity baked into the PACKAGED main bundle ----
//
// The first launch of the built installer ran as stock "Hermes Agent <commit>": it attached to the user's
// running Hermes backend and wrote to the user's Hermes home, because bundle-electron-main.mjs derived the
// baked product identity from the stamp's `payload` ("bundled") and ignored `variant: "degram"`. The env-driven
// tests above could not see it: a packaged app has no HERMES_DESKTOP_VARIANT at run time.

const DEGRAM_STAMP = {
  schemaVersion: 1,
  commit: 'a'.repeat(40),
  source: 'commit-build',
  payload: 'bundled',
  variant: 'degram',
  updateMechanism: 'external',
  tag: null
}

test('the baked product identity of a degram stamp is the DeGram identity (isolated, own appId and CLI)', async () => {
  const { productIdentity } = await import('./bundle-electron-main.mjs')
  const source = path.resolve(import.meta.dirname, '../../..')
  const identity = JSON.parse(productIdentity(source, DEGRAM_STAMP))
  assert.equal(identity.degram, true)
  assert.equal(identity.appId, 'com.erarchitech.degram')
  assert.equal(identity.displayName, 'DeGram')
  assert.equal(identity.cliName, 'degram')
  assert.equal(identity.channel, null)
})

test('the baked identity of every other stamp is unchanged and never degram', async () => {
  const { productIdentity } = await import('./bundle-electron-main.mjs')
  const source = path.resolve(import.meta.dirname, '../../..')

  const bundled = JSON.parse(productIdentity(source, { ...DEGRAM_STAMP, variant: undefined, source: 'ci' }))
  assert.equal(bundled.degram, false)
  assert.equal(bundled.appId, 'com.nousresearch.hermes-bundled')

  const bootstrap = JSON.parse(productIdentity(source, { ...DEGRAM_STAMP, variant: undefined, payload: 'bootstrap', source: 'ci' }))
  assert.equal(bootstrap.degram, false)
  assert.equal(bootstrap.appId, 'com.nousresearch.hermes')

  // A stray marker on a non-bundled payload must not select the isolated product.
  assert.throws(() => productIdentity(source, { ...DEGRAM_STAMP, payload: 'bootstrap' }), /payload|variant/i)
})

test('the packaged electron-main bundle carries the DeGram identity and fixed-home isolation (not stock Hermes)', async () => {
  const { bundleElectronMain } = await import('./bundle-electron-main.mjs')
  const source = path.resolve(import.meta.dirname, '../../..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'degram-main-'))

  try {
    const stamp = path.join(root, 'install-stamp.json')
    fs.writeFileSync(stamp, JSON.stringify({ ...DEGRAM_STAMP, builtAt: '2026-10-05T00:00:00.000Z' }))
    const out = path.join(root, 'dist')
    await bundleElectronMain({ source, out, stamp })
    const text = fs.readFileSync(path.join(out, 'electron-main.mjs'), 'utf8')
    assert.ok(text.includes('com.erarchitech.degram'), 'the packaged main must bake the DeGram appId')
    assert.ok(text.includes('HOME_OVERLAP'), 'the isolation module ships in the bundle')

    // Control: a plain bundled stamp bakes the stock identity.
    const stock = path.join(root, 'stock-stamp.json')
    fs.writeFileSync(stock, JSON.stringify({ ...DEGRAM_STAMP, variant: undefined, builtAt: '2026-10-05T00:00:00.000Z' }))
    const stockOut = path.join(root, 'stock')
    await bundleElectronMain({ source, out: stockOut, stamp: stock })
    assert.ok(!fs.readFileSync(path.join(stockOut, 'electron-main.mjs'), 'utf8').includes('com.erarchitech.degram'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
