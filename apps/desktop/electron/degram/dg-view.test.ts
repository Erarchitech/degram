// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { DEGRAM_DG_PARTITION } from './dg-config'
import { createDgView, DG_VIEW_WEB_PREFERENCES, isAllowedDgUrl } from './dg-view'
import type { DegramEvent } from './scope'
import { createFakeNavigationEvent, createFakeViewFactory, createLog } from './test-support'

const ORIGIN = 'http://dg.test:8080'

function setup(options: { log?: ReturnType<typeof createLog> } = {}) {
  const log = options.log ?? createLog()
  const viewFactory = createFakeViewFactory(log)
  const events: DegramEvent[] = []
  const openExternal = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  const dgView = createDgView({
    origin: ORIGIN,
    createView: viewFactory.factory,
    emit: event => events.push(event),
    openExternal,
    logger
  })

  return { ...viewFactory, dgView, events, openExternal, logger, log }
}

describe('isAllowedDgUrl (exact origin allowlist, D-07)', () => {
  it('admits only the configured origin: scheme, host and port exact', () => {
    expect(isAllowedDgUrl(`${ORIGIN}/`, ORIGIN)).toBe(true)
    expect(isAllowedDgUrl(`${ORIGIN}/#degram`, ORIGIN)).toBe(true)
    expect(isAllowedDgUrl(`${ORIGIN}/data-service/auth/me?x=1`, ORIGIN)).toBe(true)

    expect(isAllowedDgUrl('https://dg.test:8080/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('http://dg.test:8081/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('http://dg.test/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('http://evil.test:8080/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('http://dg.test.evil.test:8080/', ORIGIN)).toBe(false)
  })

  it('rejects userinfo tricks, other schemes and unparseable input', () => {
    expect(isAllowedDgUrl('http://dg.test:8080@evil.test/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('http://evil.test\\@dg.test:8080/', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('javascript:alert(1)', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('file:///C:/Windows/win.ini', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('data:text/html,<b>x</b>', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('about:blank', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('blob:http://evil.test/abc', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl('not a url', ORIGIN)).toBe(false)
    expect(isAllowedDgUrl(`${ORIGIN}/`, 'not an origin')).toBe(false)
  })
})

describe('createDgView web preferences (T-1301-12-01)', () => {
  it('is built in the DG partition with no preload and the sandbox on', () => {
    const { preferences } = setup()
    const prefs = preferences()

    expect(prefs).not.toBeNull()
    expect(prefs!.partition).toBe(DEGRAM_DG_PARTITION)
    expect(prefs!.partition).toBe('persist:degram-dg')
    expect(prefs!.contextIsolation).toBe(true)
    expect(prefs!.sandbox).toBe(true)
    expect(prefs!.nodeIntegration).toBe(false)
    expect(prefs!.webviewTag).toBe(false)
    expect(prefs!.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs!.webSecurity).toBe(true)
    expect(prefs!.allowRunningInsecureContent).toBe(false)
    expect('preload' in prefs!).toBe(false)
    expect('additionalArguments' in prefs!).toBe(false)
  })

  it('exports preferences that cannot be mutated into a weaker set', () => {
    expect(Object.isFrozen(DG_VIEW_WEB_PREFERENCES)).toBe(true)
  })

  it('denies every permission request of the remote content', () => {
    const { fake } = setup()

    expect(fake.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)

    const handler = fake.session.setPermissionRequestHandler.mock.calls[0][0] as (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void

    const callback = vi.fn()

    handler({}, 'media', callback)
    handler({}, 'geolocation', callback)

    expect(callback.mock.calls).toEqual([[false], [false]])
  })
})

describe('navigation guards (T-1301-12-02)', () => {
  it('prevents will-navigate and will-redirect to another origin and reports the URL', () => {
    const { fake, events } = setup()
    const navigate = createFakeNavigationEvent()
    const redirect = createFakeNavigationEvent()

    fake.emit('will-navigate', navigate, 'https://evil.test/phish')
    fake.emit('will-redirect', redirect, 'https://evil.test/next')

    expect(navigate.prevented).toBe(true)
    expect(redirect.prevented).toBe(true)
    expect(events).toEqual([
      { type: 'external-link-blocked', url: 'https://evil.test/phish' },
      { type: 'external-link-blocked', url: 'https://evil.test/next' }
    ])
  })

  it('lets same-origin navigation and redirects through without a report', () => {
    const { fake, events } = setup()
    const navigate = createFakeNavigationEvent()
    const redirect = createFakeNavigationEvent()

    fake.emit('will-navigate', navigate, `${ORIGIN}/#degram`)
    fake.emit('will-redirect', redirect, `${ORIGIN}/login`)

    expect(navigate.prevented).toBe(false)
    expect(redirect.prevented).toBe(false)
    expect(events).toEqual([])
  })

  it('denies every window.open: a foreign URL is reported, a DG URL navigates the same view', () => {
    const { fake, events, log } = setup()
    const handler = fake.windowOpenHandler()

    expect(handler).not.toBeNull()
    expect(handler!({ url: 'https://evil.test/popup' })).toEqual({ action: 'deny' })
    expect(events).toEqual([{ type: 'external-link-blocked', url: 'https://evil.test/popup' }])

    expect(handler!({ url: `${ORIGIN}/#degram` })).toEqual({ action: 'deny' })
    expect(log.entries).toContain(`view.load ${ORIGIN}/#degram`)
    expect(events).toHaveLength(1)
  })

  it('refuses a webview attachment', () => {
    const { fake } = setup()
    const event = createFakeNavigationEvent()

    fake.emit('will-attach-webview', event)

    expect(event.prevented).toBe(true)
  })
})

describe('openExternalConfirmed (T-1301-12-06)', () => {
  it('opens http(s) URLs only', () => {
    const { dgView, openExternal } = setup()

    expect(dgView.openExternalConfirmed('https://example.test/doc?a=1')).toBe(true)
    expect(dgView.openExternalConfirmed('http://example.test/')).toBe(true)

    expect(dgView.openExternalConfirmed('file:///C:/Windows/System32/cmd.exe')).toBe(false)
    expect(dgView.openExternalConfirmed('javascript:alert(1)')).toBe(false)
    expect(dgView.openExternalConfirmed('ms-msdt:/id PCWDiagnostic')).toBe(false)
    expect(dgView.openExternalConfirmed('mailto:a@b.test')).toBe(false)
    expect(dgView.openExternalConfirmed('')).toBe(false)
    expect(dgView.openExternalConfirmed(42 as unknown as string)).toBe(false)
    expect(dgView.openExternalConfirmed('https://user:pw@example.test/')).toBe(false)

    expect(openExternal.mock.calls.map(call => call[0])).toEqual([
      'https://example.test/doc?a=1',
      'http://example.test/'
    ])
  })
})

describe('modes, sign-in page and reset', () => {
  it('graph mode loads the #degram slice, full mode the whole V2 app', async () => {
    const { dgView, fake } = setup()

    await dgView.showDg()
    expect(dgView.getState()).toEqual({ page: 'dg', mode: 'graph' })
    expect(fake.loaded).toEqual([`${ORIGIN}/#degram`])

    await dgView.setMode('full')
    expect(dgView.getState()).toEqual({ page: 'dg', mode: 'full' })
    expect(fake.loaded).toEqual([`${ORIGIN}/#degram`, `${ORIGIN}/`])
  })

  it('remembers a mode chosen before the DG page is shown and does not load while on sign-in', async () => {
    const { dgView, fake } = setup()

    await dgView.showSignIn()
    await dgView.setMode('full')

    expect(fake.loaded).toEqual([`${ORIGIN}/`])
    expect(dgView.getState()).toEqual({ page: 'sign-in', mode: 'full' })

    await dgView.showDg()
    expect(fake.loaded).toEqual([`${ORIGIN}/`, `${ORIGIN}/`])
  })

  it('rejects an unknown mode', async () => {
    const { dgView, fake } = setup()

    await expect(dgView.setMode('bogus' as never)).rejects.toThrow()
    expect(fake.loaded).toEqual([])
  })

  it('the sign-in state loads the DG login page top-level in the same view', async () => {
    const { dgView, fake, created } = setup()

    await dgView.showSignIn()

    expect(dgView.getState().page).toBe('sign-in')
    expect(fake.loaded).toEqual([`${ORIGIN}/`])
    expect(created()).toBe(1)
  })

  it('reset blanks the view and clearStorage wipes cookies, storage and cache', async () => {
    const { dgView, fake, log } = setup()

    await dgView.showDg()
    await dgView.reset()
    await dgView.clearStorage()

    expect(dgView.getState().page).toBe('blank')
    expect(log.entries.slice(-3)).toEqual(['view.load about:blank', 'view.clearStorageData', 'view.clearCache'])
    expect(fake.session.clearStorageData).toHaveBeenCalledWith()
  })

  it('clearStorage with keepCookies leaves the sign-in cookie alone', async () => {
    const { dgView, fake } = setup()

    await dgView.clearStorage({ keepCookies: true })

    const options = fake.session.clearStorageData.mock.calls[0][0] as { storages?: string[] }

    expect(options.storages).toBeDefined()
    expect(options.storages).not.toContain('cookies')
    expect(options.storages).toContain('localstorage')
  })

  it('reload reloads the page when one is shown and loads the current page otherwise', async () => {
    const { dgView, fake } = setup()

    await dgView.showDg()
    await dgView.reload()
    expect(fake.reloads()).toBe(1)

    await dgView.reset()
    await dgView.reload()
    expect(fake.reloads()).toBe(1)
    expect(fake.loaded[fake.loaded.length - 1]).toBe('about:blank')
  })

  it('a failed main-frame load reports dg-unreachable and a finished DG load reports dg-reachable', async () => {
    const { dgView, fake, events } = setup()

    await dgView.showDg()
    fake.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', `${ORIGIN}/`, true)
    fake.emit('did-fail-load', {}, -3, 'ERR_ABORTED', `${ORIGIN}/`, true)
    fake.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', `${ORIGIN}/sub`, false)
    expect(events).toEqual([{ type: 'dg-unreachable' }])

    // the next navigation succeeds
    fake.emit('did-start-loading')
    fake.emit('did-finish-load')

    expect(events).toEqual([{ type: 'dg-unreachable' }, { type: 'dg-reachable' }])
  })

  it('did-finish-load of the error page after a failed load does not report DG reachable (G-16)', async () => {
    const { dgView, fake, events } = setup()

    await dgView.showDg()
    fake.emit('did-start-loading')
    fake.emit('did-fail-load', {}, -101, 'ERR_CONNECTION_RESET', `${ORIGIN}/#degram`, true)
    fake.emit('did-finish-load')
    fake.emit('did-finish-load')

    expect(events).toEqual([{ type: 'dg-unreachable' }])
  })

  it('a finished load that is not a DG page (about:blank after a reset) reports nothing', async () => {
    const { dgView, fake, events } = setup()

    await dgView.reset()
    fake.emit('did-finish-load')

    expect(events).toEqual([])
  })

  it('a load rejection is logged without a URL query and does not throw', async () => {
    const { dgView, fake, logger } = setup()

    fake.failNextLoad()
    await expect(dgView.showDg()).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalled()
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('?')
  })

  it('bounds hide the view when null, and destroy closes the web contents', () => {
    const { dgView, fake } = setup()

    dgView.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    expect(fake.bounds()).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(fake.visible()).toBe(true)

    dgView.setBounds(null)
    expect(fake.visible()).toBe(false)

    dgView.setBounds({ x: 0, y: 0, width: -5, height: Number.NaN })
    expect(fake.visible()).toBe(false)

    dgView.destroy()
    expect(fake.closed()).toBe(true)
  })
})
