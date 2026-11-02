// sidebar-menu-button.tsx — the DeGram mark at the top of the sidebar (owner redesign 2026-11-02).
//
// The sidebar holds only the session history and the pinned sessions; this mark is the one control above them. It
// brings back the DG page's main menu (the ring) from a chat or the models screen. Rendered only in variant degram.

import type { SidebarNavItem } from '@/app/types'
import { BrandMark } from '@/components/brand-mark'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { DEGRAM_MENU_ID, degramMenuItem, openDegramMenu } from './sidebar-nav'

export function DegramSidebarMenuButton({
  active,
  onNavigate
}: {
  active: boolean
  onNavigate: (item: SidebarNavItem) => void
}) {
  const copy = useI18n().t.degram

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-current={active ? 'page' : undefined}
        aria-label={copy.nav.mainMenu}
        className={cn(
          // no-drag: the row sits directly under the titlebar's drag strips (same carve-out as the stock rows).
          'flex h-9 w-full justify-start gap-2.5 rounded-md border border-transparent px-1.5 text-left text-[0.9375rem] font-semibold tracking-[0.02em] text-foreground transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:transition-none',
          active && 'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) hover:border-(--ui-stroke-tertiary)!'
        )}
        data-tip-region=""
        onClick={() => {
          openDegramMenu()
          onNavigate(degramMenuItem(copy.nav.mainMenu))
        }}
        tooltip={copy.nav.mainMenu}
        type="button"
      >
        <BrandMark className="size-6" />
        <span className="min-w-0 truncate" data-tour={`sidebar-nav-${DEGRAM_MENU_ID}`}>
          {copy.brand}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
