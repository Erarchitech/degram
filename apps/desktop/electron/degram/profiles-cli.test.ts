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
      '--home',
      HOME,
      '--user',
      'alice',
      '--company',
      'ACME',
      '--project',
      'alpha'
    ])
  })

  it('omits --company when the project has none and passes shell metacharacters as plain argv items', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '{"profile":"scope-abc"}', stderr: '' }))
    const cli = createProfilesCli({ run, home: HOME })

    await cli.ensure({ user: 'a; rm -rf /', company: null, project: 'p&q' })

    const args = run.mock.calls[0]![0] as string[]

    expect(args).not.toContain('--company')
    expect(args).toContain('a; rm -rf /')
    expect(args).toContain('p&q')
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
