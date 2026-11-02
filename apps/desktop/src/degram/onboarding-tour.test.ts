import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const driverMock = vi.hoisted(() => {
  const instance = { destroy: vi.fn(), drive: vi.fn() }

  return { factory: vi.fn((_config?: unknown) => instance), instance }
})

vi.mock('driver.js', () => ({ driver: driverMock.factory }))

import type { Config } from 'driver.js'

import { degramEn, degramRu } from './i18n'
import {
  $degramTourActive,
  $degramTourSnapshot,
  $degramTourTailPending,
  DEGRAM_TOUR_SEEN_KEY,
  DEGRAM_TOUR_TAIL_KEY,
  degramTourSteps,
  hasSeenDegramTour,
  markDegramTourSeen,
  PAGE_TOUR_STEPS,
  replayDegramTour,
  requestDegramTourTail,
  startDegramTail,
  startDegramTour,
  TOUR_TOTAL
} from './onboarding-tour'

const bridge = { captureDg: vi.fn(async (): Promise<null | string> => 'data:image/png;base64,AAAA'), tourSignal: vi.fn(async () => undefined) }

beforeEach(() => {
  window.localStorage.clear()
  driverMock.factory.mockClear()
  driverMock.instance.drive.mockClear()
  bridge.captureDg.mockClear()
  bridge.tourSignal.mockClear()
  $degramTourActive.set(false)
  $degramTourSnapshot.set(null)
  $degramTourTailPending.set(false)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { degram: bridge }
})

afterEach(() => {
  vi.restoreAllMocks()
  document.getElementById('degram-tour-top-bar')?.remove()
})

describe('degramTourSteps (quick 261101-dzj)', () => {
  it('points at the sessions sidebar, the bottom bar and the top bar as steps 12–14 of 14', () => {
    const steps = degramTourSteps(degramEn.tour, () => undefined)

    expect(PAGE_TOUR_STEPS).toBe(11)
    expect(TOUR_TOTAL).toBe(14)
    expect(steps.map(step => step.element)).toEqual([
      '[data-tour="sessions-sidebar"]',
      '[data-slot="statusbar"]',
      '#degram-tour-top-bar'
    ])
    expect(steps.map(step => step.popover?.progressText)).toEqual(['12 of 14', '13 of 14', '14 of 14'])
    expect(degramTourSteps(degramRu.tour, () => undefined).map(step => step.popover?.progressText)).toEqual([
      '12 из 14',
      '13 из 14',
      '14 из 14'
    ])
    expect(steps.at(-1)?.popover?.popoverClass).toContain('tour-pop-accent')
  })

  it('enables Back on step 12 and hands it to the caller (the page resumes its step 11)', () => {
    const back = vi.fn()
    const [first, second] = degramTourSteps(degramEn.tour, back)

    expect(first.popover?.disableButtons).toEqual([])
    first.popover?.onPrevClick?.(undefined, first, {} as never)
    expect(back).toHaveBeenCalledTimes(1)
    expect(second.popover?.onPrevClick).toBeUndefined()
  })

  it('carries the owner copy in English and Russian', () => {
    const ru = degramTourSteps(degramRu.tour, () => undefined)

    expect(ru.map(step => step.popover?.title)).toEqual(['Сессии', 'Нижняя панель', 'Верхняя панель'])
    expect(ru[1].popover?.description).toBe(
      'Текущий проект и состояние подключенных моделей. Нажмите на проект, чтобы сменить его или снова открыть тур.'
    )

    for (const step of degramTourSteps(degramEn.tour, () => undefined)) {
      expect(step.popover?.title?.trim()).toBeTruthy()
      expect(step.popover?.description?.trim()).toBeTruthy()
    }
  })
})

describe('seen flag', () => {
  it('is unset on a fresh computer, set once marked, and reads as seen when storage fails', () => {
    expect(hasSeenDegramTour()).toBe(false)
    markDegramTourSeen()
    expect(window.localStorage.getItem(DEGRAM_TOUR_SEEN_KEY)).not.toBeNull()
    expect(hasSeenDegramTour()).toBe(true)

    window.localStorage.clear()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(hasSeenDegramTour()).toBe(true)
  })
})

describe('the handshake with the DG page', () => {
  it('starts the page part through main and marks the tour seen', () => {
    startDegramTour()

    expect(bridge.tourSignal).toHaveBeenCalledWith('start')
    expect(hasSeenDegramTour()).toBe(true)
    expect(driverMock.factory).not.toHaveBeenCalled()
  })

  it('replays from the project menu: the DG page first, then the page part from step 1', () => {
    replayDegramTour()

    expect(bridge.tourSignal).toHaveBeenCalledWith('start')
  })

  it('keeps a hand-off waiting, across a restart, until DeGram shows its steps', async () => {
    requestDegramTourTail()

    expect($degramTourTailPending.get()).toBe(true)
    expect(window.localStorage.getItem(DEGRAM_TOUR_TAIL_KEY)).not.toBeNull()

    await startDegramTail(degramEn.tour)

    expect($degramTourTailPending.get()).toBe(false)
    expect(window.localStorage.getItem(DEGRAM_TOUR_TAIL_KEY)).toBeNull()
  })

  it('shows DeGram’s steps over a picture of the page and puts the view back when it ends', async () => {
    await startDegramTail(degramEn.tour)

    expect(bridge.captureDg).toHaveBeenCalledTimes(1)
    expect($degramTourSnapshot.get()).toBe('data:image/png;base64,AAAA')
    expect($degramTourActive.get()).toBe(true)
    expect(document.getElementById('degram-tour-top-bar')).not.toBeNull()
    expect(driverMock.instance.drive).toHaveBeenCalledWith(0)

    const config = driverMock.factory.mock.calls[0][0] as Config

    expect(config.nextBtnText).toBe('Next')
    expect(config.doneBtnText).toBe('Done')
    config.onDestroyed?.(undefined, {} as never, {} as never)
    expect($degramTourActive.get()).toBe(false)
    expect($degramTourSnapshot.get()).toBeNull()
    expect(document.getElementById('degram-tour-top-bar')).toBeNull()
  })

  it('Back on step 12 closes DeGram’s steps and resumes the page on its step 11', async () => {
    await startDegramTail(degramRu.tour)

    const config = driverMock.factory.mock.calls[0][0] as Config
    const first = config.steps![0]

    first.popover?.onPrevClick?.(undefined, first, {} as never)
    expect(driverMock.instance.destroy).toHaveBeenCalled()
    expect(bridge.tourSignal).toHaveBeenCalledWith('resume')
  })

  it('still runs when the page cannot be pictured', async () => {
    bridge.captureDg.mockResolvedValueOnce(null)
    await startDegramTail(degramEn.tour)

    expect($degramTourSnapshot.get()).toBeNull()
    expect($degramTourActive.get()).toBe(true)
  })
})
