import { describe, expect, it } from 'vitest'

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
