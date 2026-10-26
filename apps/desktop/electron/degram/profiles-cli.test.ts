import { describe, expect, it, vi } from 'vitest'

import { createProfilesCli, profileNameForScope, ProfilesCliError, resolveProfilesInvocation } from './profiles-cli'
import { descriptorForDgTarget } from './dg-target-config'

const environment = descriptorForDgTarget('developer', 'http://localhost:8080')
const identity = { origin: environment.origin, environmentId: environment.environmentId }

const HOME = 'C:\\Users\\u\\AppData\\Local\\DeGram\\home'

function ensuredProfile(args: string[]): string {
  const value = (flag: string): string => args.find(arg => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? ''
  return JSON.stringify({ profile: profileNameForScope({ ...identity, user: value('user'), company: value('company') || null, project: value('project') }) })
}

describe('createProfilesCli', () => {
  it('runs ensure as an argv array with home, user, company and project', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 0,
      stdout: ensuredProfile(_args),
      stderr: ''
    }))

    const cli = createProfilesCli({ run, home: HOME, environment })

    await expect(cli.ensure({ ...identity, user: 'alice', company: 'ACME', project: 'alpha' })).resolves.toEqual({
      profile: profileNameForScope({ ...identity, user: 'alice', company: 'ACME', project: 'alpha' })
    })
    expect(run).toHaveBeenCalledWith([
      '-m',
      'degram_variant.profiles',
      'ensure',
      `--home=${HOME}`,
      '--user=alice',
      '--company=ACME',
      '--project=alpha',
      `--origin=${identity.origin}`,
      `--environment-id=${identity.environmentId}`
    ])
  })

  it('omits --company when the project has none and passes shell metacharacters as plain argv items', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: ensuredProfile(_args), stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME, environment })

    await cli.ensure({ ...identity, user: 'a; rm -rf /', company: null, project: 'p&q' })

    const args = run.mock.calls[0]![0] as string[]

    expect(args.some(arg => arg.startsWith('--company'))).toBe(false)
    expect(args).toContain('--user=a; rm -rf /')
    expect(args).toContain('--project=p&q')
  })

  it('binds every value to its flag so a value that looks like an option cannot become one', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: ensuredProfile(_args), stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME, environment })

    await cli.ensure({ ...identity, user: 'alice', company: '--home=/elsewhere', project: '--user=mallory' })

    const args = run.mock.calls[0]![0] as string[]

    expect(args.filter(arg => arg.startsWith('--home'))).toEqual([`--home=${HOME}`])
    expect(args.filter(arg => arg.startsWith('--user'))).toEqual(['--user=alice'])
    expect(args).toContain('--company=--home=/elsewhere')
    expect(args).toContain('--project=--user=mallory')
  })

  it('runs purge with the same scope arguments', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 0,
      stdout: '{"profile":"scope-abc","removed":true}',
      stderr: ''
    }))

    await createProfilesCli({ run, home: HOME, environment }).purge({ ...identity, user: 'alice', company: 'ACME', project: 'alpha' })

    expect(run.mock.calls[0]![0]).toEqual([
      '-m', 'degram_variant.profiles', 'purge', `--home=${HOME}`, '--user=alice', '--company=ACME',
      '--project=alpha', `--origin=${identity.origin}`, `--environment-id=${identity.environmentId}`
    ])
  })

  it('runs purge-project with user and project only and returns the removed profile names', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '["scope-a","scope-b"]\n', stderr: '' }))

    await expect(createProfilesCli({ run, home: HOME, environment }).purgeProject('alice', '--user=mallory')).resolves.toEqual([
      'scope-a',
      'scope-b'
    ])
    expect(run).toHaveBeenCalledWith([
      '-m',
      'degram_variant.profiles',
      'purge-project',
      `--home=${HOME}`,
      '--user=alice',
      '--project=--user=mallory',
      `--origin=${identity.origin}`,
      `--environment-id=${identity.environmentId}`
    ])
  })

  it('surfaces a purge-project failure', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 1,
      stdout: '',
      stderr: '{"error":"could not remove profile"}'
    }))

    await expect(createProfilesCli({ run, home: HOME, environment }).purgeProject('alice', 'alpha')).rejects.toThrow(
      /could not remove profile/
    )
  })

  it('runs cleanup-legacy with the kept scopes as one JSON flag', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 0,
      stdout: '{"ran":true,"backfilled":["scope-a"],"removed":["scope-b"],"failed":[]}',
      stderr: ''
    }))

    const result = await createProfilesCli({ run, home: HOME, environment }).cleanupLegacy([
      { ...identity, user: 'alice', company: 'ACME', project: 'alpha' }
    ])

    expect(result).toEqual({ ran: true, backfilled: ['scope-a'], removed: ['scope-b'], failed: [] })

    const args = run.mock.calls[0]![0] as string[]

    expect(args.slice(0, 4)).toEqual(['-m', 'degram_variant.profiles', 'cleanup-legacy', `--home=${HOME}`])
    expect(args).toContain(`--origin=${identity.origin}`)
    expect(args).toContain(`--environment-id=${identity.environmentId}`)
    expect(JSON.parse(args[4]!.replace('--keep-json=', ''))).toEqual([
      { ...identity, user: 'alice', company: 'ACME', project: 'alpha' }
    ])
  })

  it('turns a non-zero exit into a ProfilesCliError carrying the CLI error text', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 1, stdout: '', stderr: '{"error":"user is required"}\n' }))

    await expect(
      createProfilesCli({ run, home: HOME, environment }).ensure({ ...identity, user: '', company: null, project: 'p' })
    ).rejects.toThrow(ProfilesCliError)
    await expect(
      createProfilesCli({ run, home: HOME, environment }).ensure({ ...identity, user: '', company: null, project: 'p' })
    ).rejects.toThrow(/user is required/)
  })

  it('rejects an ensure result without a profile name', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '{"path":"x"}', stderr: '' }))

    await expect(
      createProfilesCli({ run, home: HOME, environment }).ensure({ ...identity, user: 'a', company: null, project: 'p' })
    ).rejects.toThrow(/no profile name/)
  })
})

describe('profile environment boundary', () => {
  it('shares the Python UTF-8 identity vector', () => {
    const demo = descriptorForDgTarget('demo', 'https://dg.example.test')
    expect(profileNameForScope({ ...demo, user: 'alice', company: 'acme', project: 'tower' })).toBe(
      'scope-d882f6d4f1a222fd5d31569011e990ef'
    )
  })

  it('refuses a conflicting scope before any CLI is run', async () => {
    const run = vi.fn()
    const cli = createProfilesCli({ run, home: HOME, environment })
    await expect(cli.ensure({ ...identity, origin: 'https://other.test', user: 'alice', company: null, project: 'p' })).rejects.toThrow(/match/)
    await expect(cli.cleanupLegacy([{ ...descriptorForDgTarget('demo', 'https://dg.example.test'), user: 'alice', company: null, project: 'p' }])).rejects.toThrow(/another environment/)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a CLI profile from a different scope before a backend can use it', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '{"profile":"scope-wrong"}', stderr: '' }))
    await expect(createProfilesCli({ run, home: HOME, environment }).ensure({
      ...identity, user: 'alice', company: null, project: 'tower'
    })).rejects.toThrow(/does not match/)
  })

  it('stops every journal candidate before migrating, independent of selected target', async () => {
    const order: string[] = []
    const run = vi.fn(async (args: string[]) => {
      order.push(args[2]!)
      return { code: 0, stdout: args[2] === 'migration-status' ? '["scope-0123456789abcdef"]' : '{"migrated":[],"reported":[]}', stderr: '' }
    })
    const cli = createProfilesCli({ run, home: HOME, environment })
    await cli.migrateLegacy([], async name => { order.push(`stop:${name}`) })
    expect(order).toEqual(['migration-status', 'stop:scope-0123456789abcdef', 'migrate'])
    expect(run.mock.calls[1]![0]).toContain('--backend-stopped')
    expect(run.mock.calls[1]![0]).toContain(`--environment-id=${identity.environmentId}`)
  })

  it('never moves history if stopping a backend fails', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '["scope-0123456789abcdef"]', stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME, environment })
    await expect(cli.migrateLegacy([], async () => { throw new Error('still running') })).rejects.toThrow('still running')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('resolveProfilesInvocation', () => {
  const baseEnv = { PATH: 'p' }

  it('prefers the bundled payload python with the payload code first on PYTHONPATH', () => {
    const out = resolveProfilesInvocation({
      payload: { storePython: '/app/python', repoDir: '/app/repo', sitePackages: '/app/site' },
      backend: { command: '/other/python', args: ['-m', 'hermes_cli.main'], env: {} },
      delimiter: ';',
      baseEnv
    })

    expect(out).toEqual({ command: '/app/python', env: { PATH: 'p', PYTHONPATH: '/app/repo;/app/site' } })
  })

  it('uses the interpreter of a source checkout backend', () => {
    const env = { PYTHONPATH: '/src' }

    expect(
      resolveProfilesInvocation({
        payload: null,
        backend: { command: '/src/.venv/python', args: ['-m', 'hermes_cli.main'], env },
        delimiter: ';',
        baseEnv
      })
    ).toEqual({ command: '/src/.venv/python', env })
  })

  it('refuses a launcher shim, which cannot run python -m', () => {
    expect(
      resolveProfilesInvocation({
        payload: null,
        backend: { command: '/bin/hermes', args: ['serve'], env: {} },
        delimiter: ';',
        baseEnv
      })
    ).toBeNull()
    expect(resolveProfilesInvocation({ payload: null, backend: null, delimiter: ';', baseEnv })).toBeNull()
  })
})
