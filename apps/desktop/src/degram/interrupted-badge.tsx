// interrupted-badge.tsx — the «Прервано» marker of a partial message (Phase 1301-14, 1301-UI-SPEC E5 partial).
//
// Stopping or failing mid-stream keeps the partial text and marks it with a muted badge. Kept in its own tiny module
// because the transcript (upstream) renders it, and it must not pull the whole chat surface into that import chain.

import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/i18n'

export function InterruptedBadge() {
  const { t } = useI18n()

  return (
    <Badge data-slot="degram-interrupted" variant="muted">
      {t.degram.cta.interrupted}
    </Badge>
  )
}
