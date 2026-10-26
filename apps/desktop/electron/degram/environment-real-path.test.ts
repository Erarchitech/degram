// @vitest-environment node
// Real-path DGMODE acceptance: production target identity plus the actual profiles CLI filesystem.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, expect, it } from 'vitest'

import { descriptorForDgTarget } from './dg-target-config'
import { createEnvironmentController, type TargetRuntime } from './environment-controller'

const childRoot = resolve(import.meta.dirname, '../../../..')
const profilesCliAvailable = spawnSync(process.env.PYTHON ?? 'python', ['-c', 'import ruamel.yaml'], {
  cwd: childRoot,
  encoding: 'utf8'
}).status === 0
const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(resolve(tmpdir(), 'degram-environment-real-path-'))
  homes.push(home)
  return home
}

function profileCli(home: string, origin: string, mode: 'developer' | 'demo') {
  const target = descriptorForDgTarget(mode, origin)
  const result = spawnSync(process.env.PYTHON ?? 'python', [
    '-m', 'degram_variant.profiles', 'ensure', `--home=${home}`, '--user=alice',
    '--company=acme', '--project=tower', `--origin=${target.origin}`,
    `--environment-id=${target.environmentId}`
  ], {
    cwd: childRoot,
    env: { ...process.env, HERMES_HOME: home },
    encoding: 'utf8'
  })

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return { target, output: JSON.parse(result.stdout) as { profile: string } }
}

function runtime(): TargetRuntime {
  return {
    quiesce: async () => undefined,
    resume: async () => undefined,
    closeForEnvironmentSwitch: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

it.runIf(profilesCliAvailable)('uses one temporary installation home for actual profile CLI A → B → A without same-ID state bleed', async () => {
  const home = temporaryHome()
  const stockHome = temporaryHome()
  const stockSentinel = resolve(stockHome, 'stock-home-sentinel.txt')
  writeFileSync(stockSentinel, 'stock Hermes must not change', 'utf8')

  const a = profileCli(home, 'http://localhost:8080', 'developer')
  const aState = resolve(home, 'profiles', a.output.profile, 'state.db')
  writeFileSync(aState, 'A cookie/history/native binding', 'utf8')
  const b = profileCli(home, 'https://dg.example.test', 'demo')
  const bState = resolve(home, 'profiles', b.output.profile, 'state.db')
  writeFileSync(bState, 'B cookie/history/native binding', 'utf8')
  const aAgain = profileCli(home, 'http://localhost:8080', 'developer')

  expect(a.output.profile).not.toBe(b.output.profile)
  expect(aAgain.output.profile).toBe(a.output.profile)
  expect(readFileSync(aState, 'utf8')).toBe('A cookie/history/native binding')
  expect(readFileSync(bState, 'utf8')).toBe('B cookie/history/native binding')
  expect(readFileSync(stockSentinel, 'utf8')).toBe('stock Hermes must not change')

  const persisted: string[] = []
  const controller = createEnvironmentController({
    targets: { developer: a.target, demo: b.target },
    selected: a.target,
    initialRuntime: runtime(),
    persist: mode => { persisted.push(mode) },
    createRuntime: descriptor => {
      expect(descriptor.origin).toBe(modeOrigin(descriptor.mode))
      expect(descriptor.partition).toBe(descriptorForDgTarget(descriptor.mode, descriptor.origin).partition)
      return runtime()
    }
  })

  await expect(controller.selectTarget('demo')).resolves.toMatchObject({ ok: true, state: { selected: b.target } })
  await expect(controller.selectTarget('developer')).resolves.toMatchObject({ ok: true, state: { selected: a.target } })
  expect(persisted).toEqual(['demo', 'developer'])
})

function modeOrigin(mode: 'developer' | 'demo'): string {
  return mode === 'developer' ? 'http://localhost:8080' : 'https://dg.example.test'
}
