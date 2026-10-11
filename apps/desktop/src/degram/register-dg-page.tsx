// register-dg-page.tsx — contributes the DG page and its sidebar row through the same registry areas a bundled
// plugin uses (`routes`, `sidebar.nav`), so the page sits next to Chat without touching the sidebar or router code.
// Only the DeGram shell host calls it, so no other variant gains a route.

import { type RouteContribution, ROUTES_AREA } from '@/app/routes'
import { registry } from '@/contrib'

import { DgPage } from './dg-page'
import { DG_PAGE_PATH } from './sidebar-nav'

export { DG_PAGE_PATH }

/**
 * Register the DG page route. The page is reached from the DeGram sidebar rows (sidebar-nav.ts, D-42); it has no
 * row of its own any more (the old «DG» row is gone). Returns the disposer.
 */
export function registerDgPage(): () => void {
  return registry.register({
    id: 'degram.page',
    area: ROUTES_AREA,
    source: 'core',
    data: { path: DG_PAGE_PATH } satisfies RouteContribution,
    render: () => <DgPage />
  })
}
