// sidebar-nav.ts — the DeGram sidebar row set (Phase 1301-34, D-42).
//
// Variant `degram` replaces the stock nav rows (Capabilities, Messaging, Artifacts, Scheduled jobs, the old «DG» row)
// with exactly seven, in this order: «Новая сессия», «Граф проекта», «Валидатор», «Коннекторы», «Модели», «Проекты», «Меню». The
// five DG rows open the DG page (`/dg`) and steer its region through main (`degram.dgGo`, the fixed `#degram-go=`
// vocabulary of ui-v2/src/lib/hostMode.js); «Новая сессия» starts a fresh chat (Ctrl+N unchanged); «Модели» opens the
// DeGram models screen (plan 1301-35) at `DEGRAM_MODELS_PATH`.
//
// Outside variant degram nothing here is consulted: the sidebar's `navItems` memo only branches under `$degramEnabled`.

import { atom } from 'nanostores'
import { createElement } from 'react'

import type { SidebarNavItem } from '@/app/types'
import { Codicon } from '@/components/ui/codicon'

import type { DgRegion } from '../../electron/degram/dg-view'

import type { DegramCopy } from './i18n'
import { degramBridge } from './use-degram-state'

/** The DG page route (the page itself is registered by register-dg-page.tsx). */
export const DG_PAGE_PATH = '/dg'

/** The DeGram models screen. Plan 1301-35 registers the page; the row already navigates here. */
export const DEGRAM_MODELS_PATH = '/degram/models'

/** Row ids, in display order. `new-session` keeps the stock id so the Ctrl+N hint and the drag source stay wired. */
export const DEGRAM_NAV_IDS = ['new-session', 'dg-graph', 'dg-model', 'dg-connectors', 'models', 'dg-projects', 'dg-menu'] as const

export type DegramNavId = (typeof DEGRAM_NAV_IDS)[number]

/** The DG region a row steers the page to. «Меню» is the page's own landing. */
const REGION_BY_ID: Readonly<Record<string, DgRegion>> = {
  'dg-graph': 'graph',
  'dg-model': 'model',
  'dg-connectors': 'connectors',
  'dg-projects': 'projects',
  'dg-menu': 'landing'
}

/** The region last sent to the page; the sidebar highlights the matching row while the DG page is shown. */
export const $degramNavRegion = atom<DgRegion>('landing')

const icon = (name: string) => (props: { className?: string }) => createElement(Codicon, { name, ...props })

export function degramSidebarNav(nav: DegramCopy['nav']): SidebarNavItem[] {
  return [
    { id: 'new-session', label: nav.newSession, icon: icon('robot'), action: 'new-session', keybindActionId: 'session.new' },
    { id: 'dg-graph', label: nav.graph, icon: icon('graph'), route: DG_PAGE_PATH },
    { id: 'dg-model', label: nav.validator, icon: icon('checklist'), route: DG_PAGE_PATH },
    { id: 'dg-connectors', label: nav.connectors, icon: icon('plug'), route: DG_PAGE_PATH },
    { id: 'models', label: nav.models, icon: icon('layers'), route: DEGRAM_MODELS_PATH },
    { id: 'dg-projects', label: nav.projects, icon: icon('folder'), route: DG_PAGE_PATH },
    { id: 'dg-menu', label: nav.menu, icon: icon('menu'), route: DG_PAGE_PATH }
  ]
}

/** True for a row that steers the DG page. */
export function isDgRegionRow(id: string): boolean {
  return Object.hasOwn(REGION_BY_ID, id)
}

/** A click on a DG row: remember the region for the highlight and tell main to steer the page (route navigation is the caller's). */
export function activateDegramNavItem(id: string): void {
  const region = REGION_BY_ID[id]

  if (!region) {
    return
  }

  $degramNavRegion.set(region)
  void degramBridge()?.dgGo(region)
}

/** Whether a row is the current one. «Новая сессия» is an action and never highlights. */
export function isDegramNavActive(id: string, pathname: string, region: DgRegion): boolean {
  if (id === 'models') {
    return pathname === DEGRAM_MODELS_PATH
  }

  const own = REGION_BY_ID[id]

  return own !== undefined && pathname === DG_PAGE_PATH && own === region
}
