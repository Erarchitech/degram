import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $degramEnabled } from '@/store/degram-flag'
import { $notifications } from '@/store/notifications'

import type { DegramState } from '../../electron/degram/ipc'

import { PairingPanel } from './pairing-panel'
import { install, makeState } from './test-harness'
import { resetDegramStore } from './use-degram-state'

const TOKEN = `dgp_${'Q'.repeat(43)}`

afterEach(() => {
  cleanup()
  resetDegramStore()
  $notifications.set([])
  $degramEnabled.set(false)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

function withPairing(pairing: DegramState['pairing']): DegramState {
  return { ...makeState(), pairing }
}

const renderPanel = () => render(<PairingPanel />)

describe('pairing panel (Phase 1301-17, D-25)', () => {
  it('pastes the token once over IPC, clears the field and never shows the token back', async () => {
    const h = install(withPairing({ status: 'none', company: null, available: true }))
    h.emitState(withPairing({ status: 'none', company: null, available: true }))
    h.bridge.setPairing = vi.fn(async () => ({ ok: true as const }))
    renderPanel()

    const field = (await screen.findByLabelText('Pairing token')) as HTMLInputElement

    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: `  ${TOKEN}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(h.bridge.setPairing).toHaveBeenCalledTimes(1))
    expect(h.bridge.setPairing).toHaveBeenCalledWith(TOKEN)
    expect(field.value).toBe('')
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(screen.getByTestId('degram-pairing').textContent).not.toContain(TOKEN)
  })

  it('refuses a value that is not a pairing token without calling main', async () => {
    const h = install(withPairing({ status: 'none', company: null, available: true }))
    h.emitState(withPairing({ status: 'none', company: null, available: true }))
    h.bridge.setPairing = vi.fn(async () => ({ ok: true as const }))
    renderPanel()

    fireEvent.change(await screen.findByLabelText('Pairing token'), { target: { value: 'dgc_not-a-pairing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/isn't a DeGram pairing token/)).toBeTruthy()
    expect(h.bridge.setPairing).not.toHaveBeenCalled()
  })

  it('shows the connected state with the signed-in user and the company, and disconnects', async () => {
    const h = install(withPairing({ status: 'connected', company: 'Acme', available: true }))
    h.emitState(withPairing({ status: 'connected', company: 'Acme', available: true }))
    h.bridge.clearPairing = vi.fn(async () => undefined)
    renderPanel()

    expect(await screen.findByText('Connected as ann · Acme.')).toBeTruthy()
    expect(screen.queryByLabelText('Pairing token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(h.bridge.clearPairing).toHaveBeenCalledTimes(1))
  })

  it('shows the revoked state and asks for a new token', async () => {
    const h = install(withPairing({ status: 'revoked', company: null, available: true }))
    h.emitState(withPairing({ status: 'revoked', company: null, available: true }))
    renderPanel()

    expect(await screen.findByText(/This pairing was revoked in DG/)).toBeTruthy()
    expect(screen.getByLabelText('Pairing token')).toBeTruthy()
  })

  it('shows the other-user state', async () => {
    const h = install(withPairing({ status: 'mismatch', company: null, available: true }))
    h.emitState(withPairing({ status: 'mismatch', company: null, available: true }))
    renderPanel()

    expect(await screen.findByText(/belongs to another DG user than ann/)).toBeTruthy()
  })

  it('says so when this computer cannot encrypt the token and offers no field', async () => {
    const h = install(withPairing({ status: 'none', company: null, available: false }))
    h.emitState(withPairing({ status: 'none', company: null, available: false }))
    renderPanel()

    expect(await screen.findByText(/can't encrypt the pairing token/)).toBeTruthy()
    expect(screen.queryByLabelText('Pairing token')).toBeNull()
  })

  it('reports a store failure', async () => {
    const h = install(withPairing({ status: 'none', company: null, available: true }))
    h.emitState(withPairing({ status: 'none', company: null, available: true }))
    h.bridge.setPairing = vi.fn(async () => ({ ok: false as const, code: 'WRITE_FAILED' as const }))
    renderPanel()

    fireEvent.change(await screen.findByLabelText('Pairing token'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/couldn't be saved/)).toBeTruthy()
  })
})
