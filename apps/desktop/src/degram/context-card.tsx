// context-card.tsx — what the next request will carry, always on screen (DGCL-07, 1301-UI-SPEC E4/E5, D-17/D-18).
//
// Mounted in the composer status stack, always expanded to its summary line (the documented exception to "status
// groups start collapsed"): project · document · objects · parameters · rules · fragments · size. The caret reveals
// the exact payload text the agent will embed byte for byte; truncation and missing data are warn badges; a failed
// read shows its diagnostic inline with «Повторить чтение» and nothing stale is ever sent. Choosing «Всё определение»
// re-reads for that scope and sends nothing; the Send that follows opens the whole-definition confirmation. A
// policy deny is a neutral banner with the server's reason and «Сузить контекст», never a confirm.

import { useEffect, useRef, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { ErrorIcon } from '@/components/ui/error-state'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { LogView } from '@/components/ui/log-view'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { scopeKeyOf, useDocuments } from './documents-store'
import { type DegramCopy } from './i18n'
import { failureSentence, isRetryable, parseFailureText } from './outcome-copy'
import {
  $lifecycle,
  type FailureInfo,
  narrowContext,
  refreshPreview,
  resolveConsent,
  retryRequest,
  setContextScope,
  useLifecycle
} from './request-lifecycle'
import type { ContextScope, TruncationEntry } from './use-degram-gateway'
import { useDegram } from './use-degram-state'

const partLabel = (copy: DegramCopy, what: string): string =>
  (copy.context.parts as Record<string, string | undefined>)[what] ?? what

function truncationBadge(copy: DegramCopy, entry: TruncationEntry): string {
  const bytes = entry.what === 'bytes'
  const kept = bytes ? copy.context.size(entry.kept) : entry.kept
  const total = bytes ? copy.context.size(entry.total) : entry.total

  return `${copy.context.truncated(kept, total)} · ${partLabel(copy, entry.what)}`
}

interface FailureBannerProps {
  failure: FailureInfo
  /** The composer's own submit: a retry is a new, explicit Send of the last message. */
  onSubmit?: (text: string) => Promise<boolean> | boolean
}

/** The failure banner: names its cause, offers «Повторить запрос» (a click, never a timer) or, for a policy deny, «Сузить контекст». */
export function FailureBanner({ failure, onSubmit }: FailureBannerProps) {
  const { t } = useI18n()
  const copy = t.degram
  const { state } = useDegram()
  const documents = useDocuments()
  const denied = failure.parsed.code === 'POLICY_DENY'

  const sentence =
    failureSentence(copy, failure.parsed, {
      app: failure.app,
      document: documents.pinned?.name,
      project: state?.scope.project ?? undefined,
      elapsedSeconds: failure.elapsedSeconds
    }) ?? copy.errors.unknown

  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 text-[0.8125rem] leading-[1.4]"
      data-code={failure.parsed.code ?? ''}
      data-slot="degram-failure-banner"
      data-testid="degram-failure-banner"
      role="alert"
    >
      {denied ? (
        <Codicon className="mt-0.5 shrink-0 text-muted-foreground" name="info" size="0.9rem" />
      ) : (
        <ErrorIcon className="mt-0.5 shrink-0" size="0.9rem" />
      )}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{sentence}</span>
      {denied ? (
        <Button onClick={narrowContext} size="micro" variant="textStrong">
          {copy.cta.narrowContext}
        </Button>
      ) : (
        isRetryable(failure.parsed) && (
          <Button
            disabled={!onSubmit}
            onClick={() => {
              if (onSubmit) {
                void retryRequest(onSubmit)
              }
            }}
            size="micro"
            variant="textStrong"
          >
            {copy.cta.retry}
          </Button>
        )
      )}
    </div>
  )
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-muted-foreground">
      {' · '}
    </span>
  )
}

export function ContextCard() {
  const { t } = useI18n()
  const copy = t.degram
  const degram = useDegram()
  const key = scopeKeyOf(degram)
  const documents = useDocuments()
  const lifecycle = useLifecycle()
  const [open, setOpen] = useState(false)
  const answered = useRef(false)

  const { mismatch, pinned } = documents
  const { phase, preview, previewError } = lifecycle
  const pinKey = pinned ? `${pinned.app}:${JSON.stringify(pinned.identity)}` : ''
  const reading = phase === 'previewing'
  const documentName = preview?.summary.document?.name ?? pinned?.name ?? ''

  // A read starts when the scope, the pinned document or its mismatch state changes: a new project or document
  // updates the card and the next request in the same render, and the read is never a send.
  useEffect(() => {
    if (key) {
      void refreshPreview()
    }
  }, [key, pinKey, mismatch])

  // Coming back from Revit or Grasshopper: the selection may have changed there, so read it again.
  useEffect(() => {
    const onFocus = () => {
      // A focus re-read must not interrupt a read in flight or a streaming turn.
      const { phase: current } = $lifecycle.get()

      if (pinKey && current !== 'previewing' && current !== 'streaming') {
        void refreshPreview()
      }
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [pinKey])

  const summary = preview?.summary
  const project = summary?.project ?? degram.state?.scope.project ?? ''
  const wholeAllowed = pinned?.app === 'grasshopper'

  const readError = previewError
    ? (failureSentence(
        copy,
        {
          code: previewError.code,
          reason: previewError.reason,
          message: previewError.message ?? '',
          // «No answer within N s»: the seconds the failing request itself reports (PREVIEW_TIMEOUT).
          seconds: parseFailureText(previewError.message ?? '').seconds
        },
        { app: pinned?.app, document: pinned?.name, reason: previewError.reason }
      ) ?? copy.errors.unknown)
    : null

  return (
    <div data-phase={phase} data-slot="degram-context-card" data-testid="degram-context-card">
      <StatusRow
        leading={
          <button
            aria-expanded={open}
            aria-label={copy.context.payloadToggle}
            className="flex items-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            data-testid="degram-payload-toggle"
            disabled={!preview}
            onClick={() => setOpen(value => !value)}
            type="button"
          >
            <DisclosureCaret open={open && Boolean(preview)} size="0.8rem" />
          </button>
        }
        trailing={
          <>
            {wholeAllowed && (
              <SegmentedControl<ContextScope>
                onChange={setContextScope}
                options={[
                  { id: 'selection', label: copy.cta.scopeSelection },
                  { id: 'whole-definition', label: copy.cta.scopeWhole }
                ]}
                value={lifecycle.scope}
              />
            )}
            {pinned && (
              <Button
                aria-label={copy.context.refresh}
                disabled={reading || phase === 'streaming'}
                onClick={() => void refreshPreview()}
                size="icon-xs"
                variant="ghost"
              >
                <Codicon name="refresh" size="0.8rem" />
              </Button>
            )}
          </>
        }
        trailingVisible
      >
        <div
          aria-label={copy.context.cardTitle}
          className="flex min-w-0 flex-1 items-center text-[0.8125rem] leading-[1.4]"
          data-testid="degram-context-summary"
          role="group"
        >
          <span className="min-w-0 shrink truncate">{project}</span>
          {pinned && (
            <>
              <Dot />
              <OverflowTip label={documentName}>
                <span className="min-w-0 shrink truncate" data-testid="degram-context-document">
                  {documentName}
                </span>
              </OverflowTip>
            </>
          )}
          {pinned && reading && (
            <>
              <Dot />
              <GlyphSpinner ariaLabel={copy.context.reading} className="text-[0.85rem]" spinner="braille" />
            </>
          )}
          {summary && !reading && (
            <span className="shrink-0 font-mono text-[0.6875rem] leading-[1.45] text-muted-foreground">
              <Dot />
              {copy.context.objects(summary.objects)}
              <Dot />
              {copy.context.parameters(summary.parameters)}
              <Dot />
              {copy.context.rules(summary.rules)}
              <Dot />
              {copy.context.fragments(summary.fragments)}
              <Dot />
              {copy.context.size(summary.bytes)}
            </span>
          )}
        </div>
      </StatusRow>

      {!pinned && (
        <p
          className="px-2 pb-1.5 text-[0.8125rem] leading-[1.4] text-muted-foreground"
          data-testid="degram-card-no-document"
        >
          {copy.context.noDocument}
        </p>
      )}

      {pinned && summary?.emptySelection && !reading && !readError && (
        <p className="px-2 pb-1.5 text-[0.8125rem] leading-[1.4] text-muted-foreground" data-testid="degram-card-empty">
          {copy.context.emptySelection(documentName)}
        </p>
      )}

      {readError && !reading && (
        <div
          className="flex items-start gap-2 px-2 pb-1.5 text-[0.8125rem] leading-[1.4]"
          data-testid="degram-card-read-error"
          role="status"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">{readError}</span>
          {!mismatch && (
            <Button onClick={() => void refreshPreview()} size="micro" variant="textStrong">
              {copy.document.retryRead}
            </Button>
          )}
        </div>
      )}

      {preview && !reading && (preview.truncation.length > 0 || preview.missing.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5" data-testid="degram-card-badges">
          {preview.truncation.map(entry => (
            <Badge key={`t:${entry.what}`} variant="warn">
              {truncationBadge(copy, entry)}
            </Badge>
          ))}
          {preview.missing.map(entry => (
            <Badge key={`m:${entry.what}`} variant="warn">
              {copy.context.missing(partLabel(copy, entry.what))}
            </Badge>
          ))}
        </div>
      )}

      {open && preview && !reading && (
        <div className="px-2 pb-1.5">
          <LogView
            aria-label={copy.context.payloadLabel}
            className="max-h-48 overscroll-y-auto"
            data-testid="degram-payload"
          >
            {preview.payload}
          </LogView>
        </div>
      )}

      <ConfirmDialog
        cancelLabel={copy.confirm.wholeKeep}
        confirmLabel={copy.confirm.wholeSend}
        description={
          <span className="block max-h-40 overflow-y-auto">
            {copy.confirm.wholeBody(
              summary?.objects ?? 0,
              summary?.parameters ?? 0,
              documentName,
              copy.context.size(summary?.bytes ?? 0)
            )}
          </span>
        }
        onClose={() => {
          // The dialog also closes itself after a confirmed answer: only an unanswered close is «Keep selection only».
          if (answered.current) {
            answered.current = false

            return
          }

          resolveConsent(false)
        }}
        onConfirm={() => {
          answered.current = true
          resolveConsent(true)
        }}
        open={lifecycle.confirmOpen}
        title={copy.confirm.wholeTitle}
      />
    </div>
  )
}

/** What the composer status stack mounts for the DeGram variant: the failure banner, then the card. */
export function DegramComposerSections({ onSubmit }: { onSubmit?: (text: string) => Promise<boolean> | boolean }) {
  const lifecycle = useLifecycle()

  return (
    <>
      {lifecycle.failure && <FailureBanner failure={lifecycle.failure} onSubmit={onSubmit} />}
      <ContextCard />
    </>
  )
}
