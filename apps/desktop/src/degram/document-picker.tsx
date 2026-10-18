// document-picker.tsx — explicit document pinning with the bridge status in view (DGCL-04, 1301-UI-SPEC E3, D-13,
// D-29, D-43). One document is pinned per bridge: each group shows its own status, its own pinned row and its own
// «Открепить».
//
// The panel lives on the DeGram «Модели» screen (models-page.tsx); it used to be a popover on the strip's document
// segment (plan 14), which D-43 removed. A `Command variant="menu"` list. Rows are grouped by bridge (app glyph + name
// + status; path · identity in mono). Each bridge group loads on its own: a pending group is one row with the glyph
// spinner and «Проверка» while the other groups stay selectable; an off, busy or setup-incomplete bridge is one
// neutral notice row with its diagnostic. Nothing is pinned implicitly: a single open document still needs a click.
// An unsaved document reads «Не сохранён» in place of its path, and one without an identity is listed disabled.
// Under each document row sits its «Mapping» sub-tab (mapping-panel.tsx, Phase 1303-10), collapsed by default.

import { Fragment, type ReactNode } from 'react'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { bridgeView } from './bridge-status'
import { type AppEntry, pinRow, refreshDocuments, unpin, useDocuments } from './documents-store'
import { MappingSubtab } from './mapping-panel'
import { BRIDGE_APPS, type BridgeApp, type DocumentRow } from './use-degram-gateway'

/** Above this many rows the list gets a search field (UI-SPEC zero-one-many). */
export const DOCUMENT_SEARCH_THRESHOLD = 7

const APP_GLYPH: Record<BridgeApp, string> = { revit: 'symbol-structure', grasshopper: 'type-hierarchy' }

/**
 * Shorten a long path in the middle so the drive and the file name stay visible (`C:\Projects\…\Башня.rvt`). The
 * full path is in the row's tip. Shorter paths are returned unchanged.
 */
export function middleEllipsize(path: string, max = 44): string {
  if (path.length <= max) {
    return path
  }

  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(sep)
  const file = parts[parts.length - 1] ?? path
  const head = parts[0] && parts.length > 1 ? `${parts[0]}${sep}` : ''
  const tail = `${sep}${file}`
  const room = max - head.length - tail.length - 1

  if (room >= 0) {
    // Whole leading folders that still fit, then the ellipsis and the file name.
    let lead = head
    let i = 1

    while (i < parts.length - 1 && lead.length + parts[i]!.length + 1 <= head.length + room) {
      lead += `${parts[i]}${sep}`
      i += 1
    }

    return `${lead}…${tail}`
  }

  // Even drive + file name overflow: keep the end of the file name (its extension is the most telling part).
  return `${head}…${file.slice(-Math.max(8, max - head.length - 1))}`
}

const identityValue = (row: Pick<DocumentRow, 'app' | 'identity'>): string | undefined => {
  const value = row.app === 'grasshopper' ? row.identity?.documentId : row.identity?.creationGuid

  return typeof value === 'string' && value ? value : undefined
}

/** A row can be pinned only with the identity its bridge pins by (GH documentId, Revit creationGuid). */
export const hasIdentity = (row: Pick<DocumentRow, 'app' | 'identity'>): boolean => identityValue(row) !== undefined

/** The file name a mapping session is keyed by: the path's last segment, else the document's display name. */
export const mappingDocumentName = (row: Pick<DocumentRow, 'name' | 'path'>): string =>
  row.path?.split(/[\\/]/).filter(Boolean).pop() ?? row.name

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-2 py-1.5 text-[0.8125rem] leading-[1.4] text-muted-foreground"
      data-slot="degram-bridge-notice"
      role="status"
    >
      {children}
    </div>
  )
}

export function GroupBody({ app, entry }: { app: BridgeApp; entry: AppEntry }) {
  const { t } = useI18n()
  const copy = t.degram
  const documents = useDocuments()
  const group = entry.group
  const pinnedHere = documents.pinned[app] ?? null

  // Pending: one row with the spinner; the other bridges are not waiting for this one.
  if (entry.loading || (!group && !entry.failed)) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 text-[0.8125rem] leading-[1.4] text-muted-foreground"
        data-slot="degram-bridge-pending"
      >
        <GlyphSpinner ariaLabel={copy.bridge.checking} className="text-[0.85rem]" spinner="braille" />
        <span>{copy.bridge.checking}</span>
      </div>
    )
  }

  const view = bridgeView(copy, group ?? { app, state: 'off', documents: [], code: 'BRIDGE_OFF' }, pinnedHere?.name)

  if (!group || (group.state !== 'ready' && group.state !== 'pinned')) {
    return <Notice>{view.detail ?? copy.errors.setupIncomplete}</Notice>
  }

  if (group.documents.length === 0) {
    return <Notice>{copy.empty.noDocuments.title}</Notice>
  }

  return (
    <>
      {group.documents.map(row => {
        const identified = hasIdentity(row)
        const id = identityValue(row)

        const second = !identified
          ? copy.document.noIdentity
          : row.unsaved || !row.path
            ? copy.document.unsaved
            : middleEllipsize(row.path)

        const key = `${row.app}:${id ?? row.name}:${row.path ?? ''}`

        return (
          <Fragment key={key}>
            <CommandItem
              className="items-start"
              data-pinned={row.pinned ? 'true' : undefined}
              disabled={!identified}
              onSelect={() => void pinRow(row)}
              value={`${row.app} ${row.name} ${row.path ?? ''}`}
            >
              <span
                aria-current={row.pinned ? 'true' : undefined}
                aria-hidden
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${row.pinned ? 'bg-ring' : 'bg-transparent'}`}
              />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <OverflowTip label={row.name}>
                  <span className="min-w-0 truncate text-[0.8125rem] leading-[1.4]">{row.name}</span>
                </OverflowTip>
                <OverflowTip label={row.path ?? second}>
                  <span className="min-w-0 truncate font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground">
                    {second}
                    {identified && id && !row.unsaved && row.path ? ` · ${id.slice(0, 8)}` : ''}
                  </span>
                </OverflowTip>
              </span>
            </CommandItem>
            <MappingSubtab app={row.app} document={mappingDocumentName(row)} />
          </Fragment>
        )
      })}
    </>
  )
}

/** The connector's name, status and its Unpin control: the heading of its group. */
function GroupHeading({ app, entry }: { app: BridgeApp; entry: AppEntry }) {
  const { t } = useI18n()
  const copy = t.degram
  const documents = useDocuments()
  const pin = documents.pinned[app]

  // Before the first answer the group body carries the «Проверка» row; the heading shows a status only once known.
  const group = entry.group ?? (entry.failed ? { app, state: 'off' as const, documents: [], code: 'BRIDGE_OFF' } : undefined)
  const view = group ? bridgeView(copy, group, pin?.name) : null

  return (
    <span className="flex w-full items-center gap-1.5">
      <Codicon name={APP_GLYPH[app]} size="0.9rem" />
      {app === 'revit' ? copy.bridge.revit : copy.bridge.grasshopper}
      {view && (
        <span
          className="inline-flex items-center gap-1 text-[0.6875rem] font-normal text-muted-foreground"
          data-bridge-state={view.status}
        >
          <StatusDot className={view.status === 'pinned' ? 'bg-ring' : undefined} tone={view.status === 'ready' ? 'good' : 'muted'} />
          {view.label}
        </span>
      )}
      {pin && (
        <Button
          className="ml-auto"
          data-testid="degram-unpin"
          onClick={() => void unpin(app)}
          size="micro"
          variant="text"
        >
          {copy.document.unpin}
        </Button>
      )}
    </span>
  )
}

/**
 * The documents of every connector (D-43): a refresh button, then one group per bridge with its status and rows, or the
 * single «no open documents» empty state when every bridge answered and nothing is open. Reads happen in the caller
 * (the page refreshes on mount and on a scope change); this only renders the cache and the refresh button.
 */
export function DocumentsPanel() {
  const { t } = useI18n()
  const copy = t.degram
  const documents = useDocuments()

  const rowCount = BRIDGE_APPS.reduce((n, app) => n + (documents.apps[app].group?.documents.length ?? 0), 0)

  const settled = BRIDGE_APPS.every(
    app => !documents.apps[app].loading && (documents.apps[app].group || documents.apps[app].failed)
  )

  const everyReady = BRIDGE_APPS.every(app => ['pinned', 'ready'].includes(documents.apps[app].group?.state ?? ''))
  // Nothing open on a reachable bridge anywhere: the one «no open documents» empty state (with its instructions).
  const nothingOpen = settled && everyReady && rowCount === 0

  return (
    <div aria-label={copy.document.pickerLabel} data-testid="degram-documents-panel" role="region">
      <div className="flex items-center justify-end gap-1 px-1 pb-1">
        <Button
          aria-label={copy.document.refreshList}
          onClick={() => void refreshDocuments()}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.8rem" />
        </Button>
      </div>

      {nothingOpen ? (
        <div className="grid gap-1 px-2 pb-2" data-testid="degram-no-documents">
          <h3 className="text-base font-medium leading-tight">{copy.empty.noDocuments.title}</h3>
          <p className="text-[0.8125rem] leading-[1.4] text-muted-foreground">{copy.empty.noDocuments.body}</p>
        </div>
      ) : (
        <Command variant="menu">
          {rowCount > DOCUMENT_SEARCH_THRESHOLD && <CommandInput autoFocus placeholder={copy.document.pickerLabel} />}
          <CommandList className="max-h-none overscroll-y-contain">
            {rowCount > DOCUMENT_SEARCH_THRESHOLD && <CommandEmpty>{copy.empty.noDocuments.title}</CommandEmpty>}
            {BRIDGE_APPS.map(app => (
              <CommandGroup
                className="[&_[cmdk-group-heading]]:text-base [&_[cmdk-group-heading]]:font-medium"
                data-bridge={app}
                heading={<GroupHeading app={app} entry={documents.apps[app]} />}
                key={app}
              >
                <GroupBody app={app} entry={documents.apps[app]} />
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      )}
    </div>
  )
}
