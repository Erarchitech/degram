// scope-strip.tsx — `company · project · Revit ● · Grasshopper ●` in the shell statusbar
// (DGCL-02, 1301-UI-SPEC E1). Visible whenever the user is signed in, so the scope of the next request is never a
// guess. Company and project come from the bridge; the bridge segments are fed by plan 14 (`ConnectedScopeStrip`) and
// read «Проверка» until their first status arrives. D-43: documents are chosen on the «Модели» screen, so the strip
// has no document segment; it only shows statuses.
//
// Colour: bridge dots are neutral (off/busy/setup-incomplete/identity-mismatch) or ink (ready); the accent dot is a
// pinned document. D-29: one document is pinned per bridge, so each bridge segment carries its own pinned document
// name and dot. Segment labels ellipsize at 24 characters, bridges never collapse or wrap, and the
// company segment is the first to give way when the bar is narrow (it shrinks fastest, then names ellipsize).

import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { ProjectPicker } from './project-picker'
import { useDegram } from './use-degram-state'

export type BridgeStatus = 'busy' | 'checking' | 'identity-mismatch' | 'off' | 'pinned' | 'ready' | 'setup-incomplete'

export interface BridgeSegment {
  status: BridgeStatus
  /** Short state label next to the name. Defaults to the «Проверка» copy while checking, none otherwise. */
  label?: string
  /** The full diagnostic, shown as the segment's tip. */
  detail?: string
  /** The document pinned on this bridge (D-29): with the `pinned` status it replaces the state label. */
  document?: string
}

export interface ScopeStripProps {
  bridges?: { revit?: BridgeSegment; grasshopper?: BridgeSegment }
}

const CHECKING: BridgeSegment = { status: 'checking' }

/** Truncation shared by every text segment: 24 characters, ellipsis at the end, full value in the tip. */
const SEGMENT_TEXT = 'min-w-0 max-w-[24ch] truncate text-[0.6875rem] leading-[1.45]'

function toneFor(status: BridgeStatus): StatusTone {
  return status === 'ready' ? 'good' : 'muted'
}

function Segment({ text, className }: { text: string; className?: string }) {
  return (
    <OverflowTip label={text}>
      <span className={cn(SEGMENT_TEXT, className)}>{text}</span>
    </OverflowTip>
  )
}

function Bridge({
  detail,
  document,
  label,
  name,
  status
}: { detail?: string; label?: string; name: string } & BridgeSegment) {
  const { t } = useI18n()
  const pinnedName = status === 'pinned' ? document : undefined
  const shown = pinnedName ?? label ?? (status === 'checking' ? t.degram.bridge.checking : undefined)

  const body = (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" data-bridge-status={status}>
      <StatusDot className={status === 'pinned' ? 'bg-ring' : undefined} tone={toneFor(status)} />
      <span className="text-[0.6875rem] leading-[1.45]">{name}</span>
      {shown && (
        <span
          className={cn(
            'font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground',
            pinnedName && 'max-w-[16ch] truncate'
          )}
        >
          {shown}
        </span>
      )}
    </span>
  )

  const tip = detail ?? pinnedName

  return tip ? <OverflowTip label={tip}>{body}</OverflowTip> : body
}

export function ScopeStrip({ bridges }: ScopeStripProps) {
  const { t } = useI18n()
  const copy = t.degram
  const { state } = useDegram()

  if (state?.auth.kind !== 'signed-in') {
    return null
  }

  const { company, project } = state.scope
  const projectLabel = project ?? copy.cta.chooseProject

  return (
    <div
      aria-label={copy.brand}
      className="flex min-w-0 items-center gap-2 text-muted-foreground"
      data-testid="degram-scope-strip"
      role="group"
    >
      {company && <Segment className="shrink-[4]" text={company} />}

      <ProjectPicker>
        <Button
          aria-label={`${copy.scope.project}: ${projectLabel}`}
          className="min-w-0 shrink"
          size="micro"
          variant="text"
        >
          <span className={cn(SEGMENT_TEXT, project ? 'text-foreground' : undefined)}>{projectLabel}</span>
        </Button>
      </ProjectPicker>

      <Bridge name={copy.bridge.revit} {...(bridges?.revit ?? CHECKING)} />
      <Bridge name={copy.bridge.grasshopper} {...(bridges?.grasshopper ?? CHECKING)} />
    </div>
  )
}
