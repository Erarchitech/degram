// mapping-filters.tsx — the elements a Revit mapping reads (DG 1303-33, D-123, D-124).
//
// Three filters, each switched on by a click and applied only while on, combined as an intersection: View (the active
// view or one picked by name), Selection (the current Revit selection), Categories (a multi-select list of the model's
// categories that can hold DG_Class, searched by name; the chosen ones are listed under the filter). With no filter on
// the whole model is read. The element limit (default 5000, 1..5000: the stand's per-session cap) sits next to them.
// The lists are read from the open model once, when a picker is first opened.

import { useStore } from '@nanostores/react'
import { map } from 'nanostores'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemCheck,
  CommandList
} from '@/components/ui/command'
import { controlVariants } from '@/components/ui/control'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import type { DegramCopy } from './i18n'
import {
  type MappingCategoryChoice,
  type MappingSession,
  type MappingStartOptions,
  type MappingViewChoice,
  readMappingFilters
} from './mapping-api'

export const MAPPING_LIMIT_MAX = 5000

export interface MappingFilterState {
  view: { on: boolean; viewId: null | number; viewName: string }
  selection: boolean
  categories: { on: boolean; names: string[]; labels: Record<string, string> }
  limit: number
}

export const DEFAULT_MAPPING_FILTERS: MappingFilterState = {
  view: { on: false, viewId: null, viewName: '' },
  selection: false,
  categories: { on: false, names: [], labels: {} },
  limit: MAPPING_LIMIT_MAX
}

/** The filters of each document while DeGram runs, so collapsing the sub-tab keeps them. */
const $filters = map<Record<string, MappingFilterState>>({})

export function useMappingFilters(document: string): [MappingFilterState, (next: MappingFilterState) => void] {
  const all = useStore($filters)

  return [all[document] ?? DEFAULT_MAPPING_FILTERS, next => $filters.setKey(document, next)]
}

/** D-124: a continuation replaces the open session, and the connector writes only that session's confirmations, so it
 *  waits until nothing of this session is left to confirm or to write. */
export function canContinueAfter(session: MappingSession | null): boolean {
  return !session || (session.pendingAnswerIds.length === 0 && !session.batches.some(b => b.delivery === 'queued'))
}

export function resetMappingFiltersForTests(): void {
  $filters.set({})
}

/** The dg_start_mapping arguments of these filters; a Categories filter with nothing chosen applies nothing. */
export function mappingStartOptions(state: MappingFilterState): MappingStartOptions {
  const filters: MappingStartOptions['filters'] = {}

  if (state.view.on) {
    filters.view = state.view.viewId ?? 'active'
  }

  if (state.selection) {
    filters.selection = true
  }

  if (state.categories.on && state.categories.names.length > 0) {
    filters.categories = [...state.categories.names]
  }

  return { filters, limit: state.limit }
}

const noFilterOn = (state: MappingFilterState) =>
  !state.view.on && !state.selection && !(state.categories.on && state.categories.names.length > 0)

interface Lists {
  loading: boolean
  failed: boolean
  categories: MappingCategoryChoice[]
  views: MappingViewChoice[]
}

function useFilterLists() {
  const [lists, setLists] = useState<Lists>({ loading: false, failed: false, categories: [], views: [] })
  const asked = useRef(false)

  const load = () => {
    if (asked.current) {
      return
    }

    asked.current = true
    setLists(l => ({ ...l, loading: true }))
    readMappingFilters()
      .then(found =>
        setLists({ loading: false, failed: Boolean(found.outcome), categories: found.categories, views: found.views })
      )
      .catch(() => {
        asked.current = false
        setLists(l => ({ ...l, loading: false, failed: true }))
      })
  }

  return { lists, load }
}

const TRIGGER = cn(controlVariants({ size: 'xs' }), 'flex w-auto max-w-full items-center gap-1.5 whitespace-nowrap')

function FilterChip({
  label,
  on,
  onToggle,
  testId,
  children
}: {
  label: string
  on: boolean
  onToggle: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <div className="grid min-w-0 content-start gap-1" data-filter-on={on} data-testid={testId}>
      <Button aria-pressed={on} onClick={onToggle} size="xs" variant={on ? 'default' : 'outline'}>
        {label}
      </Button>
      <div className="min-w-0 text-[0.75rem] leading-[1.4] text-muted-foreground">{children}</div>
    </div>
  )
}

export function MappingFilters({
  copy,
  state,
  onChange,
  disabled
}: {
  copy: DegramCopy
  state: MappingFilterState
  onChange: (next: MappingFilterState) => void
  disabled?: boolean
}) {
  const text = copy.mapping.filters
  const { lists, load } = useFilterLists()
  const [viewOpen, setViewOpen] = useState(false)
  const [categoriesOpen, setCategoriesOpen] = useState(false)

  const listBody = (empty: string) =>
    lists.loading ? (
      <CommandEmpty>{text.loading}</CommandEmpty>
    ) : lists.failed ? (
      <CommandEmpty>{copy.errors.unknown}</CommandEmpty>
    ) : (
      <CommandEmpty>{empty}</CommandEmpty>
    )

  const toggleCategory = (choice: MappingCategoryChoice) => {
    const chosen = state.categories.names.includes(choice.name)

    onChange({
      ...state,
      categories: {
        on: true,
        names: chosen
          ? state.categories.names.filter(name => name !== choice.name)
          : [...state.categories.names, choice.name],
        labels: { ...state.categories.labels, [choice.name]: choice.label }
      }
    })
  }

  const chosenLabels = state.categories.names.map(name => state.categories.labels[name] ?? name)

  return (
    <fieldset className="grid gap-2" data-testid="degram-mapping-filters" disabled={disabled}>
      <legend className="text-[0.75rem] font-medium tracking-wide text-muted-foreground uppercase">{text.title}</legend>
      <div className="grid grid-cols-3 gap-2">
        <FilterChip
          label={text.view}
          on={state.view.on}
          onToggle={() => onChange({ ...state, view: { ...state.view, on: !state.view.on } })}
          testId="degram-mapping-filter-view"
        >
          {state.view.on ? (
            <Popover
              onOpenChange={open => {
                setViewOpen(open)

                if (open) {
                  load()
                }
              }}
              open={viewOpen}
            >
              <PopoverTrigger asChild>
                <button className={TRIGGER} data-testid="degram-mapping-view-picker" type="button">
                  <span className="truncate">{state.view.viewId === null ? text.viewActive : state.view.viewName}</span>
                  <Codicon className="shrink-0 opacity-60" name="chevron-down" size="0.875rem" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" variant="menu">
                <Command variant="menu">
                  <CommandInput autoFocus placeholder={text.viewSearch} />
                  <CommandList>
                    {listBody(text.noMatch)}
                    <CommandGroup>
                      <CommandItem
                        onSelect={() => {
                          onChange({ ...state, view: { on: true, viewId: null, viewName: '' } })
                          setViewOpen(false)
                        }}
                        value={text.viewActive}
                      >
                        <span className="min-w-0 flex-1 truncate">{text.viewActive}</span>
                        <CommandItemCheck checked={state.view.viewId === null} />
                      </CommandItem>
                      {lists.views.map(view => (
                        <CommandItem
                          key={view.id}
                          onSelect={() => {
                            onChange({ ...state, view: { on: true, viewId: view.id, viewName: view.name } })
                            setViewOpen(false)
                          }}
                          value={`${view.name} ${view.type} ${view.id}`}
                        >
                          <span className="min-w-0 flex-1 truncate">{view.name}</span>
                          <span className="shrink-0 text-(--ui-text-tertiary)">{view.type}</span>
                          <CommandItemCheck checked={state.view.viewId === view.id} />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : (
            text.off
          )}
        </FilterChip>

        <FilterChip
          label={text.selection}
          on={state.selection}
          onToggle={() => onChange({ ...state, selection: !state.selection })}
          testId="degram-mapping-filter-selection"
        >
          {state.selection ? text.selectionHint : text.off}
        </FilterChip>

        <FilterChip
          label={text.categories}
          on={state.categories.on}
          onToggle={() => onChange({ ...state, categories: { ...state.categories, on: !state.categories.on } })}
          testId="degram-mapping-filter-categories"
        >
          {state.categories.on ? (
            <div className="grid gap-1">
              <Popover
                onOpenChange={open => {
                  setCategoriesOpen(open)

                  if (open) {
                    load()
                  }
                }}
                open={categoriesOpen}
              >
                <PopoverTrigger asChild>
                  <button className={TRIGGER} data-testid="degram-mapping-categories-picker" type="button">
                    <span className="truncate">{text.categoriesPick}</span>
                    <Codicon className="shrink-0 opacity-60" name="chevron-down" size="0.875rem" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" variant="menu">
                  <Command variant="menu">
                    <CommandInput autoFocus placeholder={text.categoriesSearch} />
                    <CommandList>
                      {listBody(text.noMatch)}
                      <CommandGroup>
                        {lists.categories.map(choice => (
                          <CommandItem
                            key={choice.name}
                            onSelect={() => toggleCategory(choice)}
                            value={`${choice.label} ${choice.name}`}
                          >
                            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                            <span className="shrink-0 tabular-nums text-(--ui-text-tertiary)">{choice.count}</span>
                            <CommandItemCheck checked={state.categories.names.includes(choice.name)} />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {chosenLabels.length > 0 && (
                <span className="text-foreground" data-testid="degram-mapping-categories-chosen">
                  {chosenLabels.join(', ')}
                </span>
              )}
            </div>
          ) : (
            text.off
          )}
        </FilterChip>
      </div>

      <label className="flex items-center gap-2 text-[0.8125rem]">
        <span>{text.limit}</span>
        <Input
          aria-label={text.limit}
          className="w-24"
          data-testid="degram-mapping-limit"
          max={MAPPING_LIMIT_MAX}
          min={1}
          onChange={event => {
            const value = Math.trunc(Number(event.target.value))

            if (Number.isFinite(value)) {
              onChange({ ...state, limit: Math.min(MAPPING_LIMIT_MAX, Math.max(1, value)) })
            }
          }}
          size="xs"
          type="number"
          value={state.limit}
        />
      </label>
      {noFilterOn(state) && (
        <p className="text-[0.75rem] leading-[1.4] text-muted-foreground" data-testid="degram-mapping-whole-model">
          {text.wholeModel(state.limit)}
        </p>
      )}
    </fieldset>
  )
}
