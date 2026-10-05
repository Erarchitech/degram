// register-dg-page.tsx — contributes the DG page and its sidebar row through the same registry areas a bundled
// plugin uses (`routes`, `sidebar.nav`), so the page sits next to Chat without touching the sidebar or router code.
// Only the DeGram shell host calls it, so no other variant gains a route.

import { type RouteContribution, ROUTES_AREA, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import { registry } from '@/contrib'
import { subscribeRuntimeI18nLocale, translateNow } from '@/i18n/runtime'

import { DgPage } from './dg-page'

export const DG_PAGE_PATH = '/dg'

/** Register the page and a locale-following sidebar row. Returns one disposer for both. */
export function registerDgPage(): () => void {
  const disposeRoute = registry.register({
    id: 'degram.page',
    area: ROUTES_AREA,
    source: 'core',
    data: { path: DG_PAGE_PATH } satisfies RouteContribution,
    render: () => <DgPage />
  })

  let disposeNav = () => {}

  const registerNav = () => {
    disposeNav()
    disposeNav = registry.register({
      id: 'degram.nav',
      area: SIDEBAR_NAV_AREA,
      source: 'core',
      order: 50,
      data: {
        codicon: 'globe',
        label: translateNow('degram.nav.dg'),
        path: DG_PAGE_PATH
      } satisfies SidebarNavContribution
    })
  }

  registerNav()
  const offLocale = subscribeRuntimeI18nLocale(registerNav)

  return () => {
    offLocale()
    disposeNav()
    disposeRoute()
  }
}
