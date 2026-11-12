import { describe, expect, it, vi } from 'vitest'

import { createGatewayRpc, GatewayRpcError, gatewayWsUrl, type WebSocketLike } from './gateway-rpc'

class FakeSocket implements WebSocketLike {
  static last: FakeSocket
  readyState = 0
  sent: string[] = []
  closed = false
  private listeners = new Map<string, ((event: any) => void)[]>()

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(): void {}

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('gatewayWsUrl', () => {
  it('turns the backend http origin and token into the gateway websocket URL', () => {
    expect(gatewayWsUrl('http://127.0.0.1:5123', 'a b/c')).toBe('ws://127.0.0.1:5123/api/ws?token=a%20b%2Fc')
  })
})

describe('createGatewayRpc', () => {
  const rpc = createGatewayRpc({ WebSocketImpl: FakeSocket, timeoutMs: 200 })

  it('sends one JSON-RPC request on open, resolves with the matching result and closes', async () => {
    const pending = rpc('ws://x/api/ws?token=t', 'degram.credentials.status', { a: 1 })
    const socket = FakeSocket.last

    socket.emit('open')

    const sent = JSON.parse(socket.sent[0]) as { jsonrpc: string; id: string; method: string; params: unknown }

    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'degram.credentials.status', params: { a: 1 } })
    // A foreign frame (gateway.ready) and a different id are ignored.
    socket.emit('message', { data: JSON.stringify({ method: 'event', params: { type: 'gateway.ready' } }) })
    socket.emit('message', { data: JSON.stringify({ id: 'other', result: 'no' }) })
    socket.emit('message', { data: JSON.stringify({ id: sent.id, result: { status: 'ok' } }) })

    await expect(pending).resolves.toEqual({ status: 'ok' })
    expect(socket.closed).toBe(true)
  })

  it('rejects with the gateway error code and never echoes the params (token) in the message', async () => {
    const pending = rpc('ws://x/api/ws?token=t', 'degram.credentials.set', { token: 'dgd_SECRET' })
    const socket = FakeSocket.last

    socket.emit('open')

    const sent = JSON.parse(socket.sent[0]) as { id: string }

    socket.emit('message', {
      data: JSON.stringify({ id: sent.id, error: { code: 4403, message: 'locked', data: { code: 'DEGRAM_LOCKED' } } })
    })

    const error = (await pending.catch((e: unknown) => e)) as GatewayRpcError

    expect(error).toBeInstanceOf(GatewayRpcError)
    expect(error).toMatchObject({ rpcCode: 4403, code: 'DEGRAM_LOCKED' })
    expect(`${error.message}${error.stack}`).not.toContain('dgd_SECRET')
  })

  it('1303-35: keeps the structured code of the human-intent lane and tells a timeout apart (the broker reads status on both)', async () => {
    const pending = rpc('ws://x/api/ws?token=t', 'degram.mapping.advanced.confirmIntent', { sessionId: 's', intentId: 'hi-1', scope: {} })
    const socket = FakeSocket.last

    socket.emit('open')

    const sent = JSON.parse(socket.sent[0]) as { id: string }

    socket.emit('message', {
      data: JSON.stringify({ id: sent.id, error: { code: 4090, message: 'already', data: { code: 'INTENT_ALREADY_DISPATCHED', status: 409 } } })
    })
    await expect(pending).rejects.toMatchObject({ rpcCode: 4090, code: 'INTENT_ALREADY_DISPATCHED' })

    // an unresolved native outcome is a RESULT with status error, not a transport failure: it resolves as is
    const unresolved = rpc('ws://x/api/ws?token=t', 'degram.mapping.advanced.preview', { sessionId: 's', intentId: 'hi-1' })
    const second = FakeSocket.last

    second.emit('open')
    second.emit('message', {
      data: JSON.stringify({ id: JSON.parse(second.sent[0]).id, result: { status: 'error', code: 'BUSY', reason: 'NATIVE_OUTCOME_UNRESOLVED', unresolved: true } })
    })
    await expect(unresolved).resolves.toMatchObject({ unresolved: true })

    // a call nobody answers is a timeout, distinguishable from every coded refusal
    await expect(rpc('ws://x', 'degram.mapping.advanced.confirmIntent', {})).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
  })

  it('allows the native confirmation budget without extending unrelated RPCs', async () => {
    vi.useFakeTimers()
    try {
      const production = createGatewayRpc({ WebSocketImpl: FakeSocket, defaultTimeoutMs: 150_000 })
      const pending = production('ws://x', 'degram.mapping.advanced.confirmIntent', {})
      const socket = FakeSocket.last
      let settled = false
      const observed = pending.then(() => { settled = true }, () => { settled = true })
      socket.emit('open')
      await vi.advanceTimersByTimeAsync(180_000)
      expect(settled).toBe(false)
      socket.emit('message', { data: JSON.stringify({ id: JSON.parse(socket.sent[0]).id, result: { status: 'ok' } }) })
      await observed
      expect(settled).toBe(true)

      const ordinary = createGatewayRpc({ WebSocketImpl: FakeSocket })('ws://x', 'degram.credentials.status', {})
      const rejection = expect(ordinary).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects when the socket closes or errors before an answer, and on timeout', async () => {
    const closed = rpc('ws://x', 'm', {})

    FakeSocket.last.emit('close')
    await expect(closed).rejects.toMatchObject({ code: 'RPC_SOCKET_CLOSED' })

    const errored = rpc('ws://x', 'm', {})

    FakeSocket.last.emit('error')
    await expect(errored).rejects.toMatchObject({ code: 'RPC_SOCKET_ERROR' })

    await expect(rpc('ws://x', 'm', {})).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
  })
})
