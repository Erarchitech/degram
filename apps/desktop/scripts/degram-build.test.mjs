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
