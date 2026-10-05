// scope-strip.tsx — `company · project · document · Revit ● · Grasshopper ●` in the shell statusbar
// (DGCL-02, 1301-UI-SPEC E1). Visible whenever the user is signed in, so the scope of the next request is never a
// guess. Company and project come from the bridge; the document and bridge segments are fed by plan 14
// (`ConnectedScopeStrip`) and read «Выбрать документ» / «Проверка» until their first status arrives.
//
// Colour: bridge dots are neutral (off/busy/setup-incomplete/identity-mismatch) or ink (ready); the one accent
// dot is the pinned document. Segment labels ellipsize at 24 characters, bridges never collapse or wrap, and the
// company segment is the first to give way when the bar is narrow (it shrinks fastest, then names ellipsize).

import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { DocumentPicker } from './document-picker'
import { ProjectPicker } from './project-picker'
import { useDegram } from './use-degram-state'

export type BridgeStatus = 'busy' | 'checking' | 'identity-mismatch' | 'off' | 'pinned' | 'ready' | 'setup-incomplete'

export interface BridgeSegment {
  status: BridgeStatus
  /** Short state label next to the name. Defaults to the «Проверка» copy while checking, none otherwise. */
  label?: string
  /** The full diagnostic, shown as the segment's tip. */
  detail?: string
}

export interface ScopeStripDocument {
  name: string
  pinned?: boolean
}

export interface ScopeStripProps {
  document?: ScopeStripDocument | null
  bridges?: { revit?: BridgeSegment; grasshopper?: BridgeSegment }
  /** Opens a custom document picker. Without it (and without `documentPicker`) the document segment is plain text. */
  onSelectDocument?: () => void
  /** The document segment opens the bridge-grouped document picker (plan 14). */
  documentPicker?: boolean
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

function Bridge({ detail, label, name, status }: { detail?: string; label?: string; name: string } & BridgeSegment) {
  const { t } = useI18n()
  const shown = label ?? (status === 'checking' ? t.degram.bridge.checking : undefined)

  const body = (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" data-bridge-status={status}>
      <StatusDot className={status === 'pinned' ? 'bg-ring' : undefined} tone={toneFor(status)} />
      <span className="text-[0.6875rem] leading-[1.45]">{name}</span>
      {shown && <span className="font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground">{shown}</span>}
    </span>
  )

  return detail ? <OverflowTip label={detail}>{body}</OverflowTip> : body
}

export function ScopeStrip({ bridges, document, documentPicker, onSelectDocument }: ScopeStripProps) {
  const { t } = useI18n()
  const copy = t.degram
  const { state } = useDegram()

  if (state?.auth.kind !== 'signed-in') {
    return null
  }

  const { company, project } = state.scope
  const projectLabel = project ?? copy.cta.chooseProject
  const documentLabel = document?.name ?? copy.cta.selectDocument

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

      {documentPicker ? (
        <DocumentPicker>
          <Button
            aria-label={`${copy.scope.document}: ${documentLabel}`}
            className="min-w-0 shrink"
            size="micro"
            variant="text"
          >
            {document?.pinned && <StatusDot className="bg-ring" tone="muted" />}
            <OverflowTip label={documentLabel}>
              <span className={SEGMENT_TEXT}>{documentLabel}</span>
            </OverflowTip>
          </Button>
        </DocumentPicker>
      ) : onSelectDocument ? (
        <Button
          aria-label={`${copy.scope.document}: ${documentLabel}`}
          className="min-w-0 shrink"
          onClick={onSelectDocument}
          size="micro"
          variant="text"
        >
          {document?.pinned && <StatusDot className="bg-ring" tone="muted" />}
          <span className={SEGMENT_TEXT}>{documentLabel}</span>
        </Button>
      ) : (
        <span className="inline-flex min-w-0 shrink items-center gap-1">
          {document?.pinned && <StatusDot className="bg-ring" tone="muted" />}
          <Segment text={documentLabel} />
        </span>
      )}

      <Bridge name={copy.bridge.revit} {...(bridges?.revit ?? CHECKING)} />
      <Bridge name={copy.bridge.grasshopper} {...(bridges?.grasshopper ?? CHECKING)} />
    </div>
  )
}
