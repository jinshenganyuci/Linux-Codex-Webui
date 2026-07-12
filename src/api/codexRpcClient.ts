import type { RpcEnvelope, RpcMethodCatalog } from '../types/codex'
import { CodexApiError, extractErrorMessage } from './codexErrors'
import { requestTextWithTimeout, type RequestOptions } from './requestClient'

type RpcRequestBody = {
  method: string
  params?: unknown
}

export type RpcNotification = {
  method: string
  params: unknown
  atIso: string
  streamId?: string
  sequence?: number
  generation?: number
}

type ServerRequestReplyBody = {
  id: number
  generation: number
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function rpcCall<T>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
  const body: RpcRequestBody = { method, params: params ?? null }

  let response: Response
  let rawText: string | null = null
  try {
    const result = await requestTextWithTimeout('/codex-api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, {
      timeout: options.timeout ?? 'rpc',
      signal: options.signal,
      operation: method,
    })
    response = result.response
    rawText = result.text
  } catch (error) {
    if (error instanceof CodexApiError) throw error
    throw new CodexApiError(
      error instanceof Error ? error.message : `RPC ${method} failed before request was sent`,
      { code: 'network_error', method },
    )
  }

  let payload: unknown = null
  try {
    payload = rawText ? JSON.parse(rawText) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = extractErrorMessage(payload, '') || rawText?.slice(0, 500) || ''
    const prefix = `RPC ${method} failed with HTTP ${response.status}`
    throw new CodexApiError(
      detail ? `${prefix}: ${detail}` : prefix,
      {
        code: 'http_error',
        method,
        status: response.status,
      },
    )
  }

  const envelope = payload as RpcEnvelope<T> | null
  if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) {
    throw new CodexApiError(`RPC ${method} returned malformed envelope`, {
      code: 'invalid_response',
      method,
      status: response.status,
    })
  }
  return envelope.result
}

export async function fetchRpcMethodCatalog(options: RequestOptions = {}): Promise<string[]> {
  const { response, text } = await requestTextWithTimeout('/codex-api/meta/methods', undefined, {
    timeout: options.timeout ?? 'rpc',
    signal: options.signal,
    operation: 'meta/methods',
  })

  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Method catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/methods',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

export async function fetchRpcNotificationCatalog(options: RequestOptions = {}): Promise<string[]> {
  const { response, text } = await requestTextWithTimeout('/codex-api/meta/notifications', undefined, {
    timeout: options.timeout ?? 'rpc',
    signal: options.signal,
    operation: 'meta/notifications',
  })

  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Notification catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/notifications',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

function toNotification(value: unknown): RpcNotification | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.method !== 'string' || record.method.length === 0) return null

  const atIso = typeof record.atIso === 'string' && record.atIso.length > 0
    ? record.atIso
    : new Date().toISOString()

  return {
    method: record.method,
    params: record.params ?? null,
    atIso,
    streamId: typeof record.streamId === 'string' ? record.streamId : undefined,
    sequence: typeof record.sequence === 'number' && Number.isInteger(record.sequence) ? record.sequence : undefined,
    generation: typeof record.generation === 'number' && Number.isInteger(record.generation) ? record.generation : undefined,
  }
}

function emitReadyNotification(
  onNotification: (value: RpcNotification) => void,
  params: unknown = { ok: true },
): void {
  onNotification({
    method: 'ready',
    params,
    atIso: new Date().toISOString(),
  })
}

export function subscribeRpcNotifications(onNotification: (value: RpcNotification) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  let cleanup: (() => void) | null = null
  let closed = false
  let reconnectTimer: number | null = null
  let activeStreamId = ''
  let lastSequence = 0

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const scheduleReconnect = (attach: () => void, attempt: number) => {
    if (closed || reconnectTimer !== null) return
    const delayMs = Math.min(1000 * (2 ** attempt), 10000)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      attach()
    }, delayMs)
  }

  const cursorQuery = () => {
    const query = new URLSearchParams()
    if (activeStreamId) query.set('streamId', activeStreamId)
    if (lastSequence > 0) query.set('sequence', String(lastSequence))
    const value = query.toString()
    return value ? `?${value}` : ''
  }

  const handleNotificationPayload = (payload: unknown) => {
    const notification = toNotification(payload)
    if (!notification) return
    if (notification.streamId && typeof notification.sequence === 'number') {
      if (notification.streamId === activeStreamId && notification.sequence <= lastSequence) return
      if (notification.streamId !== activeStreamId) {
        activeStreamId = notification.streamId
        lastSequence = 0
      }
      lastSequence = notification.sequence
    }
    onNotification(notification)
  }

  const handleReadyPayload = (payload: unknown) => {
    const ready = asRecord(payload)
    const streamId = typeof ready?.streamId === 'string' ? ready.streamId : ''
    const replayAvailable = ready?.replayAvailable === true
    const streamChanged = Boolean(activeStreamId) && Boolean(streamId) && activeStreamId !== streamId
    if (streamChanged) lastSequence = 0
    if (streamId) activeStreamId = streamId
    emitReadyNotification(onNotification, {
      ...(ready ?? { ok: true }),
      streamChanged,
      replayAvailable,
    })
  }

  const attachSse = (attempt = 0) => {
    if (typeof EventSource === 'undefined' || closed) return
    cleanup?.()
    const source = new EventSource(`/codex-api/events${cursorQuery()}`)
    let isConnectionClosed = false

    source.onmessage = (event) => {
      try {
        handleNotificationPayload(JSON.parse(event.data) as unknown)
      } catch {
        // Ignore malformed event payloads and keep stream alive.
      }
    }

    source.addEventListener('ready', (event: MessageEvent<string>) => {
      try {
        handleReadyPayload(event.data ? JSON.parse(event.data) as unknown : { ok: true })
      } catch {
        handleReadyPayload({ ok: true })
      }
    })

    source.onerror = () => {
      if (closed || isConnectionClosed) return
      isConnectionClosed = true
      source.close()
      scheduleReconnect(() => attachSse(attempt + 1), attempt)
    }

    cleanup = () => {
      isConnectionClosed = true
      source.close()
    }
  }

  const attachWebSocket = (attempt = 0) => {
    if (typeof WebSocket === 'undefined' || closed) {
      attachSse()
      return
    }

    cleanup?.()
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/codex-api/ws${cursorQuery()}`)
    let didOpen = false
    let intentionallyClosed = false
    let watchdogTriggered = false
    let lastFrameAt = Date.now()
    let watchdogTimer: number | null = null
    let fallbackTimer: number | null = window.setTimeout(() => {
      if (didOpen || closed || intentionallyClosed) return
      intentionallyClosed = true
      socket.close()
      attachSse()
    }, 2500)

    const clearWatchdog = () => {
      if (watchdogTimer === null) return
      window.clearInterval(watchdogTimer)
      watchdogTimer = null
    }

    socket.onopen = () => {
      didOpen = true
      lastFrameAt = Date.now()
      clearReconnectTimer()
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      watchdogTimer = window.setInterval(() => {
        if (closed || intentionallyClosed || watchdogTriggered) return
        if (Date.now() - lastFrameAt < 25_000) return
        watchdogTriggered = true
        clearWatchdog()
        socket.close()
        scheduleReconnect(() => attachWebSocket(0), 0)
      }, 5_000)
    }

    socket.onmessage = (event) => {
      lastFrameAt = Date.now()
      try {
        const payload = JSON.parse(String(event.data)) as unknown
        const notification = toNotification(payload)
        if (notification?.method === 'ready') {
          handleReadyPayload(notification.params)
        } else {
          handleNotificationPayload(payload)
        }
      } catch {
        // Ignore malformed event payloads and keep stream alive.
      }
    }

    socket.onerror = () => {
      // Wait for close so we do not race duplicate reconnect/fallback paths.
    }

    socket.onclose = () => {
      clearWatchdog()
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      if (closed || intentionallyClosed) return
      if (watchdogTriggered) return
      if (!didOpen) {
        attachSse()
        return
      }
      scheduleReconnect(() => attachWebSocket(attempt + 1), attempt)
    }

    cleanup = () => {
      intentionallyClosed = true
      clearWatchdog()
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      socket.close()
    }
  }

  if (typeof WebSocket !== 'undefined') {
    attachWebSocket()
  } else {
    attachSse()
  }

  return () => {
    closed = true
    clearReconnectTimer()
    cleanup?.()
  }
}

export async function respondServerRequest(body: ServerRequestReplyBody, options: RequestOptions = {}): Promise<void> {
  const { response, text } = await requestTextWithTimeout('/codex-api/server-requests/respond', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, {
    timeout: options.timeout ?? 'rpc',
    signal: options.signal,
    operation: 'server-requests/respond',
  })

  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Server request reply failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/respond',
        status: response.status,
      },
    )
  }
}

export async function fetchPendingServerRequests(options: RequestOptions = {}): Promise<unknown[]> {
  const { response, text } = await requestTextWithTimeout('/codex-api/server-requests/pending', undefined, {
    timeout: options.timeout ?? 'rpc',
    signal: options.signal,
    operation: 'server-requests/pending',
  })

  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Pending server requests failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/pending',
        status: response.status,
      },
    )
  }

  const record = asRecord(payload)
  const data = record?.data
  return Array.isArray(data) ? data : []
}
