// gateway-rpc.ts — a one-shot JSON-RPC call to a local agent backend's /api/ws (Phase 1301-12).
//
// Electron main hands the delegated credential to the agent (degram.credentials.set / clear) over the same
// gateway the renderer uses. The renderer owns the long-lived socket; main only needs a request-response
// pair a few times per scope, so each call opens a socket, sends one request on open, waits for the frame
// with the matching id, and closes. Frames without that id (gateway.ready, events) are ignored.
//
// The params of a call can carry the delegated token: they are written to the socket and nowhere else
// (never logged, never part of an error message).

export interface WebSocketLike {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (type: string, listener: (event: any) => void) => void
  removeEventListener: (type: string, listener: (event: any) => void) => void
}

export interface GatewayRpcDeps {
  WebSocketImpl: new (url: string) => WebSocketLike
  timeoutMs?: number
}

export class GatewayRpcError extends Error {
  readonly rpcCode: number | null
  /** The gateway's structured error code (for example DEGRAM_LOCKED, CREDENTIALS_INVALID), when present. */
  readonly code: string | null

  constructor(message: string, rpcCode: number | null, code: string | null) {
    super(message)
    this.name = 'GatewayRpcError'
    this.rpcCode = rpcCode
    this.code = code
  }
}

/** `http://127.0.0.1:PORT` + session token -> the backend gateway websocket URL. */
export function gatewayWsUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl)

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/ws'
  url.search = `?token=${encodeURIComponent(token)}`

  return url.toString()
}

export function createGatewayRpc(
  deps: GatewayRpcDeps
): (wsUrl: string, method: string, params: unknown) => Promise<unknown> {
  const timeoutMs: number = deps.timeoutMs ?? 10_000
  let seq = 0

  return (wsUrl: string, method: string, params: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      seq += 1

      const id = `degram-main-${seq}`
      const socket = new deps.WebSocketImpl(wsUrl)
      let settled = false

      const settle = (action: () => void): void => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)

        try {
          socket.close()
        } catch {
          // already closed
        }

        action()
      }

      const timer = setTimeout(
        () => settle(() => reject(new GatewayRpcError(`gateway call ${method} timed out`, null, 'RPC_TIMEOUT'))),
        timeoutMs
      )

      timer.unref?.()

      socket.addEventListener('open', () => {
        try {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        } catch {
          settle(() => reject(new GatewayRpcError(`gateway call ${method} could not be sent`, null, 'RPC_SEND_FAILED')))
        }
      })
      socket.addEventListener('message', (event: { data: unknown }) => {
        let frame: {
          id?: unknown
          result?: unknown
          error?: { code?: unknown; message?: unknown; data?: { code?: unknown } }
        }

        try {
          frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          return
        }

        if (!frame || frame.id !== id) {
          return
        }

        if (frame.error) {
          const rpcCode: number | null = typeof frame.error.code === 'number' ? frame.error.code : null
          const structured: unknown = frame.error.data?.code

          settle(() =>
            reject(
              new GatewayRpcError(
                typeof frame.error?.message === 'string' ? frame.error.message : `gateway call ${method} failed`,
                rpcCode,
                typeof structured === 'string' ? structured : null
              )
            )
          )

          return
        }

        settle(() => resolve(frame.result))
      })
      socket.addEventListener('error', () =>
        settle(() => reject(new GatewayRpcError(`gateway socket error during ${method}`, null, 'RPC_SOCKET_ERROR')))
      )
      socket.addEventListener('close', () =>
        settle(() => reject(new GatewayRpcError(`gateway socket closed during ${method}`, null, 'RPC_SOCKET_CLOSED')))
      )
    })
}
