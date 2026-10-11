// register-dg-page.tsx — contributes the DG page and the «Модели» page through the same `routes` registry area a
// bundled plugin uses, so the pages sit next to Chat without touching the sidebar or router code. Only the DeGram
// shell host calls it, so no other variant gains a route.

import { type RouteContribution, ROUTES_AREA } from '@/app/routes'
import { registry } from '@/contrib'

import { DgPage } from './dg-page'
import { ModelsPage } from './models-page'
import { DEGRAM_MODELS_PATH, DG_PAGE_PATH } from './sidebar-nav'

export { DG_PAGE_PATH }

/**
 * Register the DG page route and the «Модели» route (D-43). Both are reached from the DeGram sidebar rows
 * (sidebar-nav.ts, D-42); neither has a row of its own. Returns the disposer of both.
 */
export function registerDgPage(): () => void {
  const disposers = [
    registry.register({
      id: 'degram.page',
      area: ROUTES_AREA,
      source: 'core',
      data: { path: DG_PAGE_PATH } satisfies RouteContribution,
      render: () => <DgPage />
    }),
    registry.register({
      id: 'degram.models',
      area: ROUTES_AREA,
      source: 'core',
      data: { path: DEGRAM_MODELS_PATH } satisfies RouteContribution,
      render: () => <ModelsPage />
    })
  ]

  return () => {
    for (const dispose of disposers) {
      dispose()
    }
  }
}
