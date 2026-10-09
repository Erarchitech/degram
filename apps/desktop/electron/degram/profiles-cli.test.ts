import { describe, expect, it, vi } from 'vitest'

import { createProfilesCli, ProfilesCliError, resolveProfilesInvocation } from './profiles-cli'

const HOME = 'C:\\Users\\u\\AppData\\Local\\DeGram\\home'

describe('createProfilesCli', () => {
  it('runs ensure as an argv array with home, user, company and project', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 0,
      stdout: '{"profile":"scope-abc","path":"x"}\n',
      stderr: ''
    }))

    const cli = createProfilesCli({ run, home: HOME })

    await expect(cli.ensure({ user: 'alice', company: 'ACME', project: 'alpha' })).resolves.toEqual({
      profile: 'scope-abc'
    })
    expect(run).toHaveBeenCalledWith([
      '-m',
      'degram_variant.profiles',
      'ensure',
      `--home=${HOME}`,
      '--user=alice',
      '--company=ACME',
      '--project=alpha'
    ])
  })

  it('omits --company when the project has none and passes shell metacharacters as plain argv items', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '{"profile":"scope-abc"}', stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME })

    await cli.ensure({ user: 'a; rm -rf /', company: null, project: 'p&q' })

    const args = run.mock.calls[0]![0] as string[]

    expect(args.some(arg => arg.startsWith('--company'))).toBe(false)
    expect(args).toContain('--user=a; rm -rf /')
    expect(args).toContain('--project=p&q')
  })

  it('binds every value to its flag so a value that looks like an option cannot become one', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '{"profile":"scope-abc"}', stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME })

    await cli.ensure({ user: 'alice', company: '--home=/elsewhere', project: '--user=mallory' })

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

    await createProfilesCli({ run, home: HOME }).purge({ user: 'alice', company: 'ACME', project: 'alpha' })

    expect((run.mock.calls[0]![0] as string[])[2]).toBe('purge')
  })

  it('runs purge-project with user and project only and returns the removed profile names', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '["scope-a","scope-b"]\n', stderr: '' }))

    await expect(createProfilesCli({ run, home: HOME }).purgeProject('alice', '--user=mallory')).resolves.toEqual([
      'scope-a',
      'scope-b'
    ])
    expect(run).toHaveBeenCalledWith([
      '-m',
      'degram_variant.profiles',
      'purge-project',
      `--home=${HOME}`,
      '--user=alice',
      '--project=--user=mallory'
    ])
  })

  it('surfaces a purge-project failure', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 1,
      stdout: '',
      stderr: '{"error":"could not remove profile"}'
    }))

    await expect(createProfilesCli({ run, home: HOME }).purgeProject('alice', 'alpha')).rejects.toThrow(
      /could not remove profile/
    )
  })

  it('runs cleanup-legacy with the kept scopes as one JSON flag', async () => {
    const run = vi.fn(async (_args: string[]) => ({
      code: 0,
      stdout: '{"ran":true,"backfilled":["scope-a"],"removed":["scope-b"],"failed":[]}',
      stderr: ''
    }))

    const result = await createProfilesCli({ run, home: HOME }).cleanupLegacy([
      { user: 'alice', company: 'ACME', project: 'alpha' }
    ])

    expect(result).toEqual({ ran: true, backfilled: ['scope-a'], removed: ['scope-b'], failed: [] })

    const args = run.mock.calls[0]![0] as string[]

    expect(args.slice(0, 4)).toEqual(['-m', 'degram_variant.profiles', 'cleanup-legacy', `--home=${HOME}`])
    expect(JSON.parse(args[4]!.replace('--keep-json=', ''))).toEqual([
      { user: 'alice', company: 'ACME', project: 'alpha' }
    ])
  })

  it('turns a non-zero exit into a ProfilesCliError carrying the CLI error text', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 1, stdout: '', stderr: '{"error":"user is required"}\n' }))

    await expect(
      createProfilesCli({ run, home: HOME }).ensure({ user: '', company: null, project: 'p' })
    ).rejects.toThrow(ProfilesCliError)
    await expect(
      createProfilesCli({ run, home: HOME }).ensure({ user: '', company: null, project: 'p' })
    ).rejects.toThrow(/user is required/)
  })

  it('rejects an ensure result without a profile name', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '{"path":"x"}', stderr: '' }))

    await expect(
      createProfilesCli({ run, home: HOME }).ensure({ user: 'a', company: null, project: 'p' })
    ).rejects.toThrow(/no profile name/)
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
