// use-dg-bounds.ts — tells Electron main where the DG WebContentsView belongs (Phase 1301-12 bridge).
//
// The DG view is a native view above the renderer, so the renderer cannot lay it out. It reserves a
// placeholder element and reports that element's rectangle in window content coordinates; main keeps the
// view hidden until the first rectangle arrives and hides it again on `null`. Reported on mount, resize,
// scroll and zoom, coalesced to one call per frame; the same rectangle is never sent twice.

import { type RefObject, useEffect } from 'react'

import { degramBridge } from './use-degram-state'

export interface DgRect {
  x: number
  y: number
  width: number
  height: number
}

/** The element's rectangle in window content coordinates (DIPs: CSS px times the window zoom factor). */
export function measureDgRect(element: HTMLElement): DgRect {
  const zoom = window.hermesDesktop?.zoom?.factor?.() || 1
  const rect = element.getBoundingClientRect()

  return {
    x: rect.left * zoom,
    y: rect.top * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom
  }
}

/**
 * Keep main informed of `ref`'s rectangle while `active`. Inactive or unmounted reports `null` so no tenant
 * page stays painted over a surface that is not showing it.
 */
export function useDgBounds(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const bridge = degramBridge()
    const element = ref.current

    if (!bridge || !element || !active) {
      void bridge?.setDgBounds(null)

      return
    }

    let frame = 0
    let last = ''

    const report = () => {
      frame = 0
      const rect = measureDgRect(element)
      const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`

      if (key !== last) {
        last = key
        void bridge.setDgBounds(rect)
      }
    }

    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(report)
      }
    }

    report()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)

    observer?.observe(element)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const offZoom = window.hermesDesktop?.zoom?.onChanged?.(schedule)

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame)
      }

      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      offZoom?.()
      void bridge.setDgBounds(null)
    }
  }, [active, ref])
}
