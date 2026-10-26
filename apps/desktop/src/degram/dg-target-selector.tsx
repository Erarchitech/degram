// dg-target-selector.tsx — target disclosure and explicit selection; main owns every transition.
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { $degramEnabled } from '@/store/degram-flag'

import type { DgTargetMode } from '../../electron/degram/dg-target-config'

import { degramBridge, isCurrentEnvironment, isEnvironmentReady, useDegram } from './use-degram-state'

// The gate and working header are separate surfaces; preserve explicit switch focus across that handoff.
let focusTargetWhenReady = false

export function DgTargetSelector({ working = false }: { working?: boolean } = {}) {
  const enabled = useStore($degramEnabled)
  const { environment, state } = useDegram()
  const { t } = useI18n()
  const copy = t.degram.target
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const onWorkingSurface =
      isEnvironmentReady(environment) && state?.auth.kind === 'signed-in' && state.scope.status === 'ready'

    if (
      focusTargetWhenReady &&
      (working || !onWorkingSurface) &&
      !pending &&
      environment?.status !== 'switching' &&
      trigger.current
    ) {
      trigger.current.focus()
      focusTargetWhenReady = false
    }
  }, [environment, state, pending, working])
  useEffect(() => {
    setRefusal(null)
    setPending(false)
  }, [environment?.generation])

  if (
    !enabled ||
    (working &&
      (!isEnvironmentReady(environment) || state?.auth.kind !== 'signed-in' || state.scope.status !== 'ready'))
  ) {
    return null
  }

  const select = async (mode?: DgTargetMode) => {
    const bridge = degramBridge()

    if (!bridge || !environment?.selected) {
      return
    }

    const stamp = { environmentId: environment.selected.environmentId, generation: environment.generation }
    focusTargetWhenReady = true
    setPending(true)
    setRefusal(null)

    try {
      const result = await (mode ? bridge.selectTarget({ ...stamp, mode }) : bridge.retryTarget(stamp))

      if (isCurrentEnvironment(stamp) && !result.ok) {
        setRefusal(result.code === 'BUSY' || result.code === 'QUIESCE_FAILED' ? copy.busy : copy.failed)
      }
    } catch {
      if (isCurrentEnvironment(stamp)) {
        setRefusal(copy.failed)
      }
    } finally {
      if (isCurrentEnvironment(stamp)) {
        setPending(false)
      }
    }
  }

  const selected = environment?.selected
  const effective = environment?.effectiveRuntime
  const disabled = pending || !selected || environment?.override || environment?.status === 'switching'

  return (
    <header
      className="flex shrink-0 flex-wrap items-center gap-2 bg-background px-6 py-2 text-sm [-webkit-app-region:no-drag]"
      data-testid="dg-target-header"
    >
      <Select
        disabled={disabled}
        onValueChange={mode => void select(mode as DgTargetMode)}
        value={selected?.mode ?? ''}
      >
        <SelectTrigger aria-label={copy.label} ref={trigger} size="sm">
          <SelectValue placeholder={copy.connecting} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="developer">Developer Mode</SelectItem>
          <SelectItem value="demo">Demo Mode</SelectItem>
        </SelectContent>
      </Select>
      <div className="min-w-0 flex-1 break-all text-muted-foreground">
        {selected && (
          <div>
            {copy.selected}: {selected.origin}
          </div>
        )}
        <div>
          {copy.effective}: {effective?.origin ?? copy.none}
        </div>
      </div>
      <div className="min-w-0 break-words" role="status">
        {!environment
          ? copy.connecting
          : environment.error === 'CONFIG_INVALID'
            ? copy.config
            : environment.status === 'switching'
              ? copy.switching
              : (refusal ??
                (environment.error
                  ? `${copy.failed} (${environment.error})`
                  : !isEnvironmentReady(environment)
                    ? copy.failed
                    : ''))}
        {environment?.override && <span>{copy.locked}</span>}
      </div>
      {selected && environment?.status === 'error' && (
        <Button disabled={pending} onClick={() => void select()} size="sm" variant="secondary">
          {copy.retry}
        </Button>
      )}
    </header>
  )
}
