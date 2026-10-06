// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEGRAM_ALLOWED_REST_PATHS, degramLockedApiError, degramRestLocked } from './rest-lock'

// F-06: the DeGram backend answers every /api/* path outside its allowlist with 403 DEGRAM_LOCKED
// (degram_variant/lockdown.py prune_rest_routes). Upstream renderer pollers kept asking, and every
// rejected `hermes:api` invoke logged a stack. The preload now answers a locked path locally, with the
// rejection the backend would have produced, so nothing is sent and nothing is logged.

describe('degramRestLocked mirrors prune_rest_routes', () => {
  it('keeps exactly the backend allowlist open', () => {
    expect([...DEGRAM_ALLOWED_REST_PATHS].sort()).toEqual(['/api/health', '/api/status', '/api/ws'])

    for (const path of DEGRAM_ALLOWED_REST_PATHS) {
      expect(degramRestLocked(path)).toBe(false)
      expect(degramRestLocked(`${path}?probe=1`)).toBe(false)
    }
  })

  it('locks every other /api/ and /dashboard-plugins/ path, query string or not', () => {
    for (const path of ['/api/config', '/api/profiles', '/api/model/info?x=1', '/api/cron/jobs', '/dashboard-plugins/x.js']) {
      expect(degramRestLocked(path)).toBe(true)
    }
  })

  it('leaves non-API paths and malformed input to the normal transport', () => {
    expect(degramRestLocked('/')).toBe(false)
    expect(degramRestLocked('/assets/app.js')).toBe(false)
    expect(degramRestLocked(undefined)).toBe(false)
    expect(degramRestLocked(42)).toBe(false)
  })

  it('builds the same "403: <body>" rejection the backend lock produces', () => {
    const error = degramLockedApiError('/api/config?x=1')

    expect(error.message.startsWith('403: ')).toBe(true)
    expect(JSON.parse(error.message.slice(5))).toEqual({
      detail: { code: 'DEGRAM_LOCKED', message: '/api/config is not available in DeGram' }
    })
  })
})

const host = vi.hoisted(() => ({
  flags: {} as Record<string, unknown>,
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }))
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: host.exposeInMainWorld },
  ipcRenderer: {
    invoke: host.invoke,
    send: vi.fn(),
    sendSync: vi.fn((channel: string): unknown => (channel === 'hermes:feature-flags' ? host.flags : {})),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webFrame: {},
  webUtils: {}
}))

async function bridgeApi(flags: Record<string, unknown>): Promise<(request: { path: string }) => Promise<unknown>> {
  host.flags = flags
  host.exposeInMainWorld.mockClear()
  host.invoke.mockClear()
  await import('../preload')
  const registration = host.exposeInMainWorld.mock.calls.find(([name]) => name === 'hermesDesktop')

  return (registration![1] as { api: (request: { path: string }) => Promise<unknown> }).api
}

describe('preload hermesDesktop.api', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('in DeGram, rejects a locked path locally without an IPC invoke', async () => {
    const api = await bridgeApi({ degram: true })

    await expect(api({ path: '/api/config' })).rejects.toThrow(/^403: .*DEGRAM_LOCKED/)
    expect(host.invoke).not.toHaveBeenCalled()
  })

  it('in DeGram, still sends allowlisted paths', async () => {
    const api = await bridgeApi({ degram: true })

    await api({ path: '/api/status' })
    expect(host.invoke).toHaveBeenCalledWith('hermes:api', { path: '/api/status' })
  })

  it('outside DeGram, sends every path as upstream does', async () => {
    const api = await bridgeApi({})

    await api({ path: '/api/config' })
    expect(host.invoke).toHaveBeenCalledWith('hermes:api', { path: '/api/config' })
  })
})
