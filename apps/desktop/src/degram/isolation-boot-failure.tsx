// isolation-boot-failure.tsx — the in-window runtime-isolation failure (D-02, 1301-UI-SPEC E8).
//
// DeGram fails closed when its data folder overlaps a Hermes profile: it never falls back to another home. The
// user needs the FULL overlapping path to fix it, so the path wraps (mono, break-all) and is never truncated,
// and there is deliberately no "continue anyway" action.

import { ErrorState } from '@/components/ui/error-state'
import { LogView } from '@/components/ui/log-view'
import { useI18n } from '@/i18n'

const PATH_MARK = '\u0000path\u0000'

export function IsolationBootFailure({ code = 'HOME_OVERLAP', path }: { code?: string; path: string }) {
  const { t } = useI18n()
  const copy = t.degram

  // The catalog entry is one sentence with the path inside it; render the path as its own mono node.
  const [before = '', after = ''] = copy.errors.isolation(PATH_MARK).split(PATH_MARK)

  return (
    <section
      className="grid h-full min-h-0 place-items-center overflow-auto px-6 py-12"
      data-testid="degram-isolation-failure"
    >
      <div className="grid w-full max-w-xl gap-5">
        <ErrorState
          description={
            <p className="max-w-prose text-center text-[0.8125rem] leading-[1.4] text-muted-foreground">
              {before}
              <span className="font-mono text-[0.6875rem] leading-[1.45] break-all text-foreground">{path}</span>
              {after}
            </p>
          }
          title={copy.scope.isolationTitle}
        />
        <LogView className="max-h-40 w-full break-all">{`${code}\n${path}`}</LogView>
      </div>
    </section>
  )
}
