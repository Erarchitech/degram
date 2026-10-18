// mapping-view.ts — pure presentation helpers of the Mapping sub-tab (Phase 1303-10): option and type labels, class
// labels, the five progress segments and the polling rule. Fixed option ids are UI text in the user's language; class
// and property names stay data.

import type { DegramCopy } from './i18n'
import {
  MAPPING_STATES,
  type MappingOption,
  type MappingSession,
  type MappingState,
  type MappingSummary
} from './mapping-api'
import { failureSentence } from './outcome-copy'
import type { BridgeApp, OutcomeInfo } from './use-degram-gateway'

/** How often an open sub-tab re-reads a session that is still moving (open questions, LLM pending, just started). */
export const MAPPING_POLL_MS = 4000

type MappingCopy = DegramCopy['mapping']

const TYPE_KEYS: Record<string, keyof MappingCopy['types']> = {
  'batch-assign': 'batchAssign',
  assign: 'assign',
  disambiguate: 'disambiguate',
  'mapping-or-design': 'mappingOrDesign',
  'batch-parameters': 'batchParameters',
  'batch-measures': 'batchMeasures',
  'map-measure': 'mapMeasure'
}

const KIND_KEYS: Record<string, keyof MappingCopy['kinds']> = {
  stream: 'stream',
  measure: 'measure',
  parameter: 'parameter'
}

export const typeLabel = (copy: MappingCopy, type: string): string =>
  TYPE_KEYS[type] ? copy.types[TYPE_KEYS[type]] : type

export const kindLabel = (copy: MappingCopy, kind: string): string =>
  KIND_KEYS[kind] ? copy.kinds[KIND_KEYS[kind]] : ''

/** `class:ex:GlassPanel` -> `{ kind: 'class', arg: 'ex:GlassPanel' }`; ids without an argument have `arg: ''`. */
export function optionKind(optionId: string): { kind: string; arg: string } {
  const at = optionId.indexOf(':')

  return at < 0 ? { kind: optionId, arg: '' } : { kind: optionId.slice(0, at), arg: optionId.slice(at + 1) }
}

/** The local name of an IRI (`ex:GlassPanel` -> `GlassPanel`, `http://x#Panel` -> `Panel`). */
export const localName = (iri: string): string => iri.split(/[#/:]/).filter(Boolean).pop() ?? iri

/** Every class/property label the session names (proposals and alternatives of open and answered items). */
export function sessionLabels(session: Pick<MappingSession, 'answers' | 'questions'> | null): Map<string, string> {
  const labels = new Map<string, string>()

  for (const entry of [...(session?.questions ?? []), ...(session?.answers ?? [])]) {
    for (const item of entry.items) {
      for (const label of [item.proposal, ...item.alternatives]) {
        if (label && !labels.has(label.iri)) {
          labels.set(label.iri, label.label)
        }
      }
    }
  }

  return labels
}

/** The button text of an option id, by question type (contract §3 options; owner copy 2026-10-18). */
export function optionText(
  copy: MappingCopy,
  type: string,
  option: Pick<MappingOption, 'label' | 'optionId'>,
  labels: Map<string, string>
): string {
  const { kind, arg } = optionKind(option.optionId)
  const named = () => labels.get(arg) ?? (option.label && !option.label.includes(' ') ? option.label : localName(arg))

  switch (kind) {
    case 'accept-all':
      return copy.options.acceptAll

    case 'none':
      return type === 'map-measure' ? copy.options.notProperty : copy.options.none

    case 'both':
      return copy.options.both

    case 'class':

    case 'property':
      return named()

    case 'design-error':
      return copy.options.designError(named())

    default:
      return option.label || option.optionId
  }
}

export const questionTitle = (q: { title: string; titleRu: string }, ru: boolean): string =>
  (ru ? q.titleRu || q.title : q.title || q.titleRu) || ''

export const questionText = (q: { text: string; textRu: string }, ru: boolean): string =>
  (ru ? q.textRu || q.text : q.text || q.textRu) || ''

export interface ProgressSegment {
  state: MappingState
  count: number
  /** Share of the total, 0..100. */
  percent: number
}

export function progressSegments(summary: MappingSummary): ProgressSegment[] {
  const total = MAPPING_STATES.reduce((n, state) => n + summary[state], 0)

  return MAPPING_STATES.map(state => ({
    state,
    count: summary[state],
    percent: total > 0 ? (summary[state] / total) * 100 : 0
  }))
}

const REFUSED: Record<string, keyof Omit<MappingCopy['refused'], 'generic'>> = {
  MAPPING_SESSION_APPLIED: 'sessionApplied',
  MAPPING_ANSWER_NOT_FOUND: 'answerGone',
  MAPPING_QUESTION_NOT_FOUND: 'questionGone',
  MAPPING_OPTION_INVALID: 'optionInvalid',
  MAPPING_SESSION_NOT_FOUND: 'sessionGone'
}

/**
 * The sentence for a failed mapping call: DG's own refusal codes have their copy, an unknown refusal shows DG's
 * message, and an operational outcome (bridge off, busy, access denied, DG unavailable) reads like everywhere else.
 */
export function mappingFailureText(
  copy: DegramCopy,
  outcome: OutcomeInfo,
  ctx: { app: BridgeApp; project?: string }
): string {
  const refused = REFUSED[outcome.code]

  if (refused) {
    return copy.mapping.refused[refused]
  }

  if (/^(MAPPING_|HTTP_\d)/.test(outcome.code) || outcome.code === 'BAD_REQUEST') {
    return copy.mapping.refused.generic(outcome.message ?? outcome.code)
  }

  return (
    failureSentence(copy, { code: outcome.code, reason: outcome.reason, message: outcome.message ?? '' }, ctx) ??
    copy.errors.unknown
  )
}

/**
 * Keep re-reading while something can still change on its own: open proposals, a pending LLM, a start in flight, and
 * answers waiting for CONNECTOR's apply (it applies about 10 s after the last answer; undo then closes, §7.5).
 */
export function needsPolling(session: MappingSession | null, starting: boolean): boolean {
  if (starting) {
    return true
  }

  return Boolean(
    session &&
    !session.appliedAt &&
    (session.questions.length > 0 || session.llmStatus === 'pending' || session.answers.length > 0)
  )
}
