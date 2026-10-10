// pairing-panel.tsx — "Connection to DG" / «Подключение к DG» (Phase 1301-17, D-25, D-27).
//
// The user pastes the DeGram pairing token created on the DG Connectors tab. It crosses IPC exactly once
// (`degram.setPairing`), the field is cleared at once, and the renderer never holds it again: main keeps it
// encrypted (pairing-store.ts) and only the status comes back. The DG sign-in (D-05) is unchanged; the
// pairing replaces only how the agent's short-lived token is minted. Shown in the project choice, so a
// revoked pairing (the scope closes) lands the user right here.

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldHint } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import { degramBridge, useDegram } from './use-degram-state'

const PAIRING_PATTERN = /^dgp_[A-Za-z0-9_-]{32,200}$/

type Problem = 'invalid' | 'failed' | 'unavailable' | null

export function PairingPanel({ focusRequest = false }: { focusRequest?: boolean }) {
  const { t } = useI18n()
  const copy = t.degram.pairing
  const { state } = useDegram()
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<Problem>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (focusRequest) inputRef.current?.focus() }, [focusRequest])

  const pairing = state?.pairing

  if (!pairing) {
    return null
  }

  const user = state.auth.username ?? ''
  const holdsPairing = pairing.status === 'stored' || pairing.status === 'connected'

  const connect = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()

    const token = value.trim()

    // The field never keeps the token past this point, whatever the outcome.
    setValue('')

    if (!PAIRING_PATTERN.test(token)) {
      setProblem('invalid')

      return
    }

    const bridge = degramBridge()

    if (!bridge) {
      setProblem('failed')

      return
    }

    setBusy(true)

    try {
      const result = await bridge.setPairing(token)

      setProblem(
        result.ok
          ? null
          : result.code === 'PAIRING_INVALID'
            ? 'invalid'
            : result.code === 'ENCRYPTION_UNAVAILABLE'
              ? 'unavailable'
              : 'failed'
      )
    } catch {
      setProblem('invalid')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setProblem(null)
    await degramBridge()?.clearPairing()
  }

  const status =
    pairing.status === 'connected'
      ? copy.connected(user, pairing.company)
      : pairing.status === 'stored'
        ? copy.stored
        : pairing.status === 'revoked'
          ? copy.revoked
          : pairing.status === 'mismatch'
            ? copy.mismatch(user)
            : null

  return (
    <section
      aria-label={copy.title}
      className="grid w-full max-w-md gap-3 rounded-md border border-border p-4"
      data-testid="degram-pairing"
    >
      <h2 className="text-sm font-medium text-foreground">{copy.title}</h2>

      {!pairing.available ? (
        <p className="text-[0.8125rem] leading-[1.4] text-muted-foreground">{copy.unavailable}</p>
      ) : (
        <>
          {status && (
            <p
              className={
                pairing.status === 'revoked' || pairing.status === 'mismatch'
                  ? 'text-[0.8125rem] leading-[1.4] text-destructive'
                  : 'text-[0.8125rem] leading-[1.4] text-foreground'
              }
              role="status"
            >
              {status}
            </p>
          )}

          {holdsPairing ? (
            <div className="grid gap-2">
              <FieldHint>{copy.disconnectHint}</FieldHint>
              <Button className="justify-self-start" onClick={() => void disconnect()} variant="secondary">
                {copy.disconnect}
              </Button>
            </div>
          ) : (
            <form className="grid gap-2" onSubmit={event => void connect(event)}>
              <p className="text-[0.8125rem] leading-[1.4] text-muted-foreground">{copy.body}</p>
              <Field htmlFor="degram-pairing-token" label={copy.fieldLabel}>
                <Input
                  id="degram-pairing-token"
                  ref={inputRef}
                  onChange={event => setValue(event.target.value)}
                  placeholder="dgp_…"
                  spellCheck={false}
                  type="password"
                  value={value}
                />
              </Field>
              {problem && <FieldHint error>{copy[problem]}</FieldHint>}
              <Button className="justify-self-start" disabled={busy || !value.trim()} type="submit">
                {copy.connect}
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
