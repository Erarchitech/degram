// project-picker.tsx — explicit project selection (DGCL-01/02, 1301-UI-SPEC E2).
//
// A Popover + `Command variant="menu"` list of the server-authorized memberships from /auth/me, anchored to its
// trigger (the strip's project segment, or the EmptyState action). Nothing is ever selected implicitly: a single
// membership still needs a click (T-1301-13-04). While the list is being refreshed it shows only the shared
// Loader, never the previous session's list. Switching while a response runs asks first.

import { useStore } from '@nanostores/react'
import { type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { $busy } from '@/store/session'

import { degramBridge, refreshDegramState, useDegram, useDegramActions } from './use-degram-state'

/** Above this many projects the list gets a search field (UI-SPEC zero-one-many). */
export const PROJECT_SEARCH_THRESHOLD = 7

export function ProjectPicker({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const copy = t.degram
  const { refresh, state } = useDegram()
  const actions = useDegramActions()
  const running = useStore($busy)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<null | string>(null)

  const memberships = state?.auth.memberships ?? []
  const selected = state?.scope.project ?? null

  const select = async (project: string) => {
    await degramBridge()?.selectProject(project)
  }

  const choose = (project: string) => {
    setOpen(false)

    if (project === selected) {
      return
    }

    if (running) {
      setPending(project)

      return
    }

    void select(project)
  }

  return (
    <>
      <Popover
        onOpenChange={next => {
          setOpen(next)

          if (next) {
            // Loading is set synchronously, so a stale list is never painted for even one frame.
            void refreshDegramState()
          }
        }}
        open={open}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align="start" className="max-w-[min(24rem,calc(100vw-1rem))] min-w-64" variant="menu">
          {refresh === 'loading' ? (
            <div className="grid place-items-center p-4">
              <Loader label={copy.bridge.checking} type="lemniscate-bloom" />
            </div>
          ) : refresh === 'error' ? (
            <ErrorState className="p-2" description={copy.errors.dgUnreachable} title={null}>
              <Button onClick={() => void refreshDegramState()} size="xs" variant="secondary">
                {copy.cta.retry}
              </Button>
            </ErrorState>
          ) : (
            <Command variant="menu">
              {memberships.length > PROJECT_SEARCH_THRESHOLD && (
                <CommandInput autoFocus placeholder={copy.scope.searchProjects} />
              )}
              <CommandList className="max-h-80 overscroll-y-contain">
                <CommandEmpty>{copy.empty.noAccessible.title}</CommandEmpty>
                <CommandGroup>
                  {memberships.map(membership => (
                    <CommandItem
                      key={`${membership.project}\u0000${membership.company ?? ''}`}
                      onSelect={() => choose(membership.project)}
                      value={`${membership.project} ${membership.company ?? ''}`}
                    >
                      <OverflowTip label={membership.project}>
                        <span className="min-w-0 flex-1 truncate text-[0.8125rem] leading-[1.4]">
                          {membership.project}
                        </span>
                      </OverflowTip>
                      {membership.company && (
                        <span className="shrink-0 font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground">
                          {membership.company}
                        </span>
                      )}
                      {membership.project === selected && (
                        <span aria-current="true" aria-hidden className="size-1.5 shrink-0 rounded-full bg-ring" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        cancelLabel={copy.confirm.keepWorking}
        confirmLabel={copy.confirm.switchConfirm}
        description={
          <span className="block max-h-40 overflow-y-auto">
            {pending === null ? '' : copy.confirm.switchBody(pending)}
          </span>
        }
        destructive
        onClose={() => setPending(null)}
        onConfirm={async () => {
          const project = pending

          if (project === null) {
            return
          }

          await actions.stopResponse()
          await select(project)
        }}
        open={pending !== null}
        title={copy.confirm.switchTitle}
      />
    </>
  )
}
