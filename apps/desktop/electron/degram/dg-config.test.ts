import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DG_ORIGIN,
  DEGRAM_DG_PARTITION,
  degramBackendEnv,
  DgConfigError,
  normalizeDgOrigin,
  relayBaseUrlFor,
  resolveDgOrigin,
  resolveRevitAdapter
} from './dg-config'

const HOME = 'C:\\Users\\u\\AppData\\Local\\DeGram\\home'

const files =
  (map: Record<string, string>) =>
  (file: string): string | null =>
    file in map ? map[file] : null

describe('normalizeDgOrigin', () => {
  it.each([
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['https://dg.example.org', 'https://dg.example.org'],
    ['HTTPS://DG.Example.org:443/', 'https://dg.example.org']
  ])('accepts %s', (raw, expected) => {
    expect(normalizeDgOrigin(raw)).toBe(expected)
  })

  it.each([
    'ftp://dg.example.org',
    'file:///C:/x',
    'javascript:alert(1)',
    'http://dg.example.org/app',
    'http://dg.example.org/?a=1',
    'http://dg.example.org/#degram',
    'http://user:pw@dg.example.org',
    '',
    'not a url',
    42,
    null
  ])('rejects %j', raw => {
    expect(normalizeDgOrigin(raw)).toBeNull()
  })
})

describe('resolveDgOrigin', () => {
  it('defaults to http://localhost:8080', () => {
    expect(resolveDgOrigin({ env: {}, home: HOME, readFile: files({}) })).toEqual({
      origin: DEFAULT_DG_ORIGIN,
      source: 'default'
    })
    expect(DEFAULT_DG_ORIGIN).toBe('http://localhost:8080')
  })

  it('reads dgOrigin from <home>/degram.json', () => {
    const readFile = files({ [`${HOME}\\degram.json`]: JSON.stringify({ dgOrigin: 'https://dg.example.org/' }) })

    expect(resolveDgOrigin({ env: {}, home: HOME, readFile, platform: 'win32' })).toEqual({
      origin: 'https://dg.example.org',
      source: 'file'
    })
  })

  it('lets DEGRAM_DG_ORIGIN override the file', () => {
    const readFile = files({ [`${HOME}\\degram.json`]: JSON.stringify({ dgOrigin: 'https://file.example.org' }) })

    expect(
      resolveDgOrigin({ env: { DEGRAM_DG_ORIGIN: 'http://127.0.0.1:9000' }, home: HOME, readFile, platform: 'win32' })
    ).toEqual({ origin: 'http://127.0.0.1:9000', source: 'env' })
  })

  it('fails closed on an invalid origin instead of falling back', () => {
    expect(() =>
      resolveDgOrigin({ env: { DEGRAM_DG_ORIGIN: 'http://x/app' }, home: HOME, readFile: files({}) })
    ).toThrow(DgConfigError)

    const readFile = files({ [`${HOME}\\degram.json`]: JSON.stringify({ dgOrigin: 'ftp://x' }) })

    expect(() => resolveDgOrigin({ env: {}, home: HOME, readFile, platform: 'win32' })).toThrow(/DG_ORIGIN_INVALID/)
  })

  it('fails closed on a malformed degram.json', () => {
    const readFile = files({ [`${HOME}\\degram.json`]: '{nope' })

    expect(() => resolveDgOrigin({ env: {}, home: HOME, readFile, platform: 'win32' })).toThrow(/DG_CONFIG_INVALID/)
  })
})

describe('resolveRevitAdapter', () => {
  const exists =
    (...present: string[]) =>
    (p: string): boolean =>
      present.includes(p)

  it('prefers env over degram.json and never invents the gateway interpreter', () => {
    const readFile = files({
      [`${HOME}\\degram.json`]: JSON.stringify({ revitPython: 'C:\\file\\py.exe', revitMcpDir: 'C:\\file\\revit' })
    })

    expect(
      resolveRevitAdapter({
        env: { DEGRAM_PYTHON: 'C:\\env\\py.exe', DEGRAM_REVIT_MCP_DIR: 'C:\\env\\revit' },
        home: HOME,
        readFile,
        platform: 'win32',
        exists: exists()
      })
    ).toEqual({ python: 'C:\\env\\py.exe', mcpDir: 'C:\\env\\revit' })

    expect(resolveRevitAdapter({ env: {}, home: HOME, readFile, platform: 'win32', exists: exists() })).toEqual({
      python: 'C:\\file\\py.exe',
      mcpDir: 'C:\\file\\revit'
    })
  })

  it('finds the adapter uv environment under the revit-mcp directory', () => {
    const dir = 'C:\\res\\revit-mcp'

    expect(
      resolveRevitAdapter({
        env: {},
        home: HOME,
        readFile: files({}),
        platform: 'win32',
        resourcesPath: 'C:\\res',
        exists: exists(dir, `${dir}\\.venv\\Scripts\\python.exe`)
      })
    ).toEqual({ python: `${dir}\\.venv\\Scripts\\python.exe`, mcpDir: dir })
  })

  it('leaves the interpreter unset when no mcp 1.x environment exists (setup-incomplete, not a guess)', () => {
    const dir = 'C:\\res\\revit-mcp'

    expect(
      resolveRevitAdapter({
        env: {},
        home: HOME,
        readFile: files({}),
        platform: 'win32',
        resourcesPath: 'C:\\res',
        exists: exists(dir)
      })
    ).toEqual({ mcpDir: dir })
  })
})

describe('degramBackendEnv', () => {
  it('always carries HERMES_DEGRAM=1 and the degram home, plus the adapter paths when resolved', () => {
    expect(
      degramBackendEnv({
        env: { DEGRAM_PYTHON: 'C:\\py.exe', DEGRAM_REVIT_MCP_DIR: 'C:\\revit' },
        home: HOME,
        readFile: files({}),
        platform: 'win32',
        exists: () => false
      })
    ).toEqual({
      HERMES_DEGRAM: '1',
      HERMES_HOME: HOME,
      DEGRAM_PYTHON: 'C:\\py.exe',
      DEGRAM_REVIT_MCP_DIR: 'C:\\revit'
    })
  })

  it('omits the adapter variables that do not resolve', () => {
    expect(
      degramBackendEnv({ env: {}, home: HOME, readFile: files({}), platform: 'win32', exists: () => false })
    ).toEqual({
      HERMES_DEGRAM: '1',
      HERMES_HOME: HOME
    })
  })
})

describe('constants and relay url', () => {
  it('uses the colon-less-after-persist partition and the origin plus /data-service relay base', () => {
    expect(DEGRAM_DG_PARTITION).toBe('persist:degram-dg')
    expect(relayBaseUrlFor('http://dg.test:8080')).toBe('http://dg.test:8080/data-service')
    expect(relayBaseUrlFor('http://dg.test:8080')).not.toMatch(/degram\/v1/)
  })
})
