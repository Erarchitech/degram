// sidebar-nav.ts — the DeGram sidebar head (Phase 1301-34, D-42; owner redesign 2026-11-02).
//
// Variant `degram` shows no nav rows at all: the sidebar holds only the session history and the pinned sessions.
// Every place the old rows led to is on the DG page's main menu (the ring of ui-v2's landing): Graph Viewer, Model
// Viewer, Connectors, Projects, Dashboard steer the page itself, «Модели» asks DeGram for its models screen
// (`#degram-open=models`), and «Начать новую сессию» is the ring's pill (Ctrl+N unchanged). The one control left
// above the history is the DeGram mark, which brings the main menu back from a chat or the models screen.
//
// Outside variant degram nothing here is consulted: the sidebar only branches under `$degramEnabled`.

import { atom } from 'nanostores'
import { createElement } from 'react'

import type { SidebarNavItem } from '@/app/types'
import { BrandMark } from '@/components/brand-mark'

import type { DgRegion } from '../../electron/degram/dg-view'

import { degramBridge } from './use-degram-state'

/** The DG page route (the page itself is registered by register-dg-page.tsx). */
export const DG_PAGE_PATH = '/dg'

/** The DeGram models screen (plan 1301-35), opened from the ring's «Модели» region. */
export const DEGRAM_MODELS_PATH = '/degram/models'

/** The id of the sidebar's main-menu control; it keeps the old «Меню» row's id. */
export const DEGRAM_MENU_ID = 'dg-menu'

/** The region last sent to the page («landing» once the mark is clicked). */
export const $degramNavRegion = atom<DgRegion>('landing')

/** The main-menu control as a nav item, so the sidebar routes it like any route-backed row. */
export function degramMenuItem(label: string): SidebarNavItem {
  return {
    id: DEGRAM_MENU_ID,
    label,
    icon: (props: { className?: string }) => createElement(BrandMark, props),
    route: DG_PAGE_PATH
  }
}

/** A click on the mark: remember the landing and tell main to steer the page there (route navigation is the caller's). */
export function openDegramMenu(): void {
  $degramNavRegion.set('landing')
  void degramBridge()?.dgGo('landing')
}
