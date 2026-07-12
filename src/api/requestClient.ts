import { CodexApiError } from './codexErrors'

export type RequestTimeoutPreset = 'default' | 'rpc' | 'long'

export const REQUEST_TIMEOUT_MS = {
  default: 15_000,
  rpc: 30_000,
  long: 120_000,
} as const

export type RequestTimeout = RequestTimeoutPreset | number

export type RequestOptions = {
  timeout?: RequestTimeout
  signal?: AbortSignal
  operation?: string
}

function resolveTimeoutMs(timeout: RequestTimeout | undefined): number {
  if (typeof timeout === 'number') return timeout
  return REQUEST_TIMEOUT_MS[timeout ?? 'default']
}

function operationLabel(input: RequestInfo | URL, operation?: string): string {
  if (operation?.trim()) return operation.trim()
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url || 'request'
}

function abortedError(operation: string): CodexApiError {
  return new CodexApiError(`${operation} was cancelled`, {
    code: 'aborted',
    method: operation,
  })
}

function timeoutError(operation: string, timeoutMs: number): CodexApiError {
  return new CodexApiError(`${operation} timed out after ${timeoutMs}ms`, {
    code: 'timeout',
    method: operation,
    timeoutMs,
  })
}

function networkError(operation: string, error: unknown): CodexApiError {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
  return new CodexApiError(`${operation} failed due to a network error${detail}`, {
    code: 'network_error',
    method: operation,
  })
}

export async function requestWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  consume: (response: Response) => Promise<T>,
  options: RequestOptions = {},
): Promise<{ response: Response; value: T }> {
  const operation = operationLabel(input, options.operation)
  const timeoutMs = resolveTimeoutMs(options.timeout)
  const callerSignal = options.signal ?? init?.signal ?? undefined

  if (callerSignal?.aborted) throw abortedError(operation)

  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(input, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw timeoutError(operation, timeoutMs)
      if (callerSignal?.aborted) throw abortedError(operation)
      if (error instanceof CodexApiError) throw error
      throw networkError(operation, error)
    }

    let rejectOnAbort: (() => void) | null = null
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })

    try {
      const value = await Promise.race([consume(response), aborted])
      return { response, value }
    } catch (error) {
      if (timedOut) throw timeoutError(operation, timeoutMs)
      if (callerSignal?.aborted) throw abortedError(operation)
      throw error
    } finally {
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    }
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

async function readResponseBodyWithTimeout(
  response: Response,
  input: RequestInfo | URL,
  options: RequestOptions,
): Promise<Uint8Array> {
  const operation = operationLabel(input, options.operation)
  const timeoutMs = resolveTimeoutMs(options.timeout)
  const callerSignal = options.signal
  if (callerSignal?.aborted) throw abortedError(operation)

  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()

  let timedOut = false
  const abortRead = () => { void reader.cancel(callerSignal?.reason).catch(() => undefined) }
  callerSignal?.addEventListener('abort', abortRead, { once: true })
  const timeoutId = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => undefined)
  }, timeoutMs)

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      totalBytes += value.byteLength
    }
  } catch (error) {
    if (timedOut) throw timeoutError(operation, timeoutMs)
    if (callerSignal?.aborted) throw abortedError(operation)
    throw error
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortRead)
  }

  if (timedOut) throw timeoutError(operation, timeoutMs)
  if (callerSignal?.aborted) throw abortedError(operation)

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function responseWithBodyTimeout(
  response: Response,
  input: RequestInfo | URL,
  options: RequestOptions,
): Response {
  let bodyRead: Promise<Uint8Array> | null = null
  const readBody = () => {
    bodyRead ??= readResponseBodyWithTimeout(response, input, options)
    return bodyRead
  }

  return new Proxy(response, {
    get(target, property) {
      if (property === 'arrayBuffer') {
        return async () => {
          const body = await readBody()
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        }
      }
      if (property === 'blob') {
        return async () => {
          const body = await readBody()
          const part = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
          return new Blob([part], {
            type: target.headers.get('content-type') ?? '',
          })
        }
      }
      if (property === 'json') {
        return async () => JSON.parse(new TextDecoder().decode(await readBody())) as unknown
      }
      if (property === 'text') {
        return async () => new TextDecoder().decode(await readBody())
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RequestOptions = {},
): Promise<Response> {
  const timeoutMs = resolveTimeoutMs(options.timeout)
  const startedAt = Date.now()
  const { response } = await requestWithTimeout(input, init, async () => undefined, options)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
  return responseWithBodyTimeout(response, input, {
    ...options,
    timeout: remainingMs,
    signal: options.signal ?? init?.signal ?? undefined,
  })
}

export async function requestTextWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: RequestOptions,
): Promise<{ response: Response; text: string }> {
  const { response, value } = await requestWithTimeout(input, init, (current) => current.text(), options)
  return { response, text: value }
}
