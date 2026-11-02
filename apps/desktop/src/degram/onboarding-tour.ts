// onboarding-tour.ts — DeGram's part of the onboarding tour (quick 261101-dzj).
//
// The tour is one walk of 14 steps. The DG page shows the first eleven over its main menu (ui-v2 src/tour): the page
// is a native view above the renderer, so only the page can point inside itself. DeGram starts that part
// (`#degram-tour=start`) on its first run as soon as the DG page is on screen, the sign-in page included: step 2 is the
// first sign-in by invitation. The page hands the tour back after its eleventh step (`tour-handoff`) and DeGram shows
// steps 12–14 over its own chrome: the sessions sidebar, the bottom bar and the top bar. Until a project is open the
// gate covers that chrome, so a hand-off waits (across a restart too) until the shell is usable. While DeGram's steps
// run, the native view is hidden and a picture of the page stands in for it. Back on step 12 returns to the page's
// step 11 (`#degram-tour=resume`).
//
// It drives driver.js directly instead of the agent tour holder (lib/tour/run-tour.ts) so the buttons speak the
// DeGram locale and the upstream engine stays untouched; the look comes from the same app-tour.css.

import 'driver.js/dist/driver.css'
import '@/lib/tour/app-tour.css'

import { useStore } from '@nanostores/react'
import { type Config, driver, type Driver, type DriveStep } from 'driver.js'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import { useI18n } from '@/i18n'

import type { DegramCopy } from './i18n'
import { degramBridge, isEnvironmentReady, useDegram } from './use-degram-state'

/** Set once the tour has been started on this computer (closing it early is a choice, it does not come back). */
export const DEGRAM_TOUR_SEEN_KEY = 'degram.onboarding.v1.seen'
/** A hand-off from the page that is still waiting for the shell (no project open yet). */
export const DEGRAM_TOUR_TAIL_KEY = 'degram.onboarding.v1.tail'

/** The page's steps, then DeGram's. Paired with tourSteps / DEGRAM_TAIL_STEPS in ui-v2/src/tour/tour.js. */
export const PAGE_TOUR_STEPS = 11
export const DEGRAM_TOUR_STEPS = 3
export const TOUR_TOTAL = PAGE_TOUR_STEPS + DEGRAM_TOUR_STEPS

/** Let the DG page or the shell settle before a part of the tour starts measuring it. */
export const FIRST_RUN_DELAY_MS = 800

/** True while DeGram's own steps are on screen (the DG view is hidden then). */
export const $degramTourActive = atom(false)
/** The picture of the DG page shown in place of the hidden view during DeGram's steps. */
export const $degramTourSnapshot = atom<null | string>(null)
/** The page handed the tour over and DeGram's steps have not run yet. */
export const $degramTourTailPending = atom(readFlag(DEGRAM_TOUR_TAIL_KEY))

type TourCopy = DegramCopy['tour']

let current: Driver | null = null
/** Brings the DG route forward; set by the shell host (useDegramTour), which owns the router. */
let showDgPageNow: (() => void) | null = null

/** The top bar has no element of its own (its tools are separate clusters): the tour frames them with this one. */
const TOP_BAR_ID = 'degram-tour-top-bar'

const ANCHORS: ReadonlyArray<{ key: keyof TourCopy['steps']; selector: string; side: 'bottom' | 'right' | 'top' }> = [
  { key: 'sessions', selector: '[data-tour="sessions-sidebar"]', side: 'right' },
  { key: 'bottomBar', selector: '[data-slot="statusbar"]', side: 'top' },
  { key: 'topBar', selector: `#${TOP_BAR_ID}`, side: 'bottom' }
]

/** DeGram's steps, numbered 12–14 of the whole tour. Back on the first one is enabled and calls `onBack`. */
export function degramTourSteps(copy: TourCopy, onBack: () => void): DriveStep[] {
  return ANCHORS.map(({ key, selector, side }, index) => {
    const last = index === ANCHORS.length - 1

    return {
      element: selector,
      popover: {
        description: copy.steps[key].body,
        popoverClass: last ? 'tour-pop-next tour-pop-accent' : index === 0 ? 'tour-pop-in' : 'tour-pop-next',
        progressText: copy.progress(PAGE_TOUR_STEPS + index + 1, TOUR_TOTAL),
        side,
        title: copy.steps[key].title,
        ...(index === 0 ? { disableButtons: [], onPrevClick: onBack } : {})
      }
    }
  })
}

function readFlag(key: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) {
      window.localStorage.setItem(key, new Date().toISOString())
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable: the flag lives for this run only.
  }
}

export function hasSeenDegramTour(): boolean {
  try {
    return window.localStorage.getItem(DEGRAM_TOUR_SEEN_KEY) !== null
  } catch {
    // Storage unavailable: treat as seen, so a broken store never replays the tour on every start.
    return true
  }
}

export function markDegramTourSeen(): void {
  writeFlag(DEGRAM_TOUR_SEEN_KEY, true)
}

/** Start the tour from step 1: the DG page shows its part. Marks it seen. */
export function startDegramTour(): void {
  current?.destroy()
  markDegramTourSeen()
  void degramBridge()?.tourSignal?.('start')
}

/** The project menu's «Show the tour»: back to the DG page, then the whole tour from step 1. */
export function replayDegramTour(): void {
  showDgPageNow?.()
  startDegramTour()
}

/** The page handed the tour over: DeGram's steps run as soon as its chrome is on screen. */
export function requestDegramTourTail(): void {
  writeFlag(DEGRAM_TOUR_TAIL_KEY, true)
  $degramTourTailPending.set(true)
}

function mountTopBar(): void {
  document.getElementById(TOP_BAR_ID)?.remove()

  const rects = [...document.querySelectorAll('[data-titlebar-cluster]')]
    .map(el => el.getBoundingClientRect())
    .filter(r => r.height > 0)

  const top = rects.length ? Math.min(...rects.map(r => r.top)) : 0
  const bottom = rects.length ? Math.max(...rects.map(r => r.bottom)) : 36
  const frame = document.createElement('div')

  frame.id = TOP_BAR_ID
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, {
    height: `${Math.round(bottom + top)}px`,
    left: '0',
    pointerEvents: 'none',
    position: 'fixed',
    right: '0',
    top: '0'
  })
  document.body.append(frame)
}

/** Show DeGram's steps 12–14 now. The page picture is taken before the view is hidden. */
export async function startDegramTail(copy: TourCopy): Promise<void> {
  current?.destroy()
  $degramTourTailPending.set(false)
  writeFlag(DEGRAM_TOUR_TAIL_KEY, false)

  const bridge = degramBridge()
  const snapshot = (await bridge?.captureDg?.().catch(() => null)) ?? null

  const back = () => {
    current?.destroy()
    void bridge?.tourSignal?.('resume')
  }

  const config: Config = {
    allowClose: true,
    animate: true,
    doneBtnText: copy.done,
    duration: 520,
    nextBtnText: copy.next,
    onDestroyed: () => {
      current = null
      $degramTourActive.set(false)
      $degramTourSnapshot.set(null)
      document.getElementById(TOP_BAR_ID)?.remove()
    },
    popoverOffset: 8,
    prevBtnText: copy.back,
    showProgress: true,
    smoothScroll: true,
    stagePadding: 6,
    stageRadius: 8,
    steps: degramTourSteps(copy, back)
  }

  $degramTourSnapshot.set(snapshot)
  $degramTourActive.set(true)
  mountTopBar()
  current = driver(config)
  current.drive(0)
}

/**
 * The tour's triggers, used once by the shell host. On the first run the page's part starts as soon as the DG page
 * is on screen (`showDgPage` brings the DG route forward when the shell is already usable); a waiting hand-off runs
 * DeGram's part once the shell is usable.
 */
export function useDegramTour(showDgPage: () => void): void {
  const { t } = useI18n()
  const copy = t.degram.tour
  const { environment, painted, state } = useDegram()
  const pending = useStore($degramTourTailPending)

  const environmentReady = isEnvironmentReady(environment)
  const page = state?.dg.page

  const pageShown =
    environmentReady &&
    painted &&
    state?.dg.reachable !== false &&
    (page === 'sign-in' || (page === 'dg' && state?.dg.mode === 'full'))

  const shellReady = state?.auth.kind === 'signed-in' && state.scope.status === 'ready' && environmentReady

  useEffect(() => {
    showDgPageNow = showDgPage

    return () => {
      if (showDgPageNow === showDgPage) {
        showDgPageNow = null
      }
    }
  }, [showDgPage])

  useEffect(() => {
    if (!pageShown || hasSeenDegramTour()) {
      return
    }

    const timer = window.setTimeout(() => {
      if (hasSeenDegramTour()) {
        return
      }

      if (shellReady) {
        showDgPage()
      }

      startDegramTour()
    }, FIRST_RUN_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [pageShown, shellReady, showDgPage])

  useEffect(() => {
    if (!pending || !shellReady || !painted) {
      return
    }

    const timer = window.setTimeout(() => {
      showDgPage()
      void startDegramTail(copy)
    }, FIRST_RUN_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [copy, painted, pending, shellReady, showDgPage])
}
