import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  requestTextWithTimeout,
  requestWithTimeout,
} from './requestClient'

function pendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    const rejectAborted = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) {
      rejectAborted()
      return
    }
    signal?.addEventListener('abort', rejectAborted, { once: true })
  }))
}

describe('requestClient', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns successful responses and clears the timeout timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))

    await expect(fetchWithTimeout('/ok')).resolves.toBeInstanceOf(Response)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the default timeout and aborts the fetch', async () => {
    vi.useFakeTimers()
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchWithTimeout('/slow', undefined, { operation: 'slow-request' })
    const assertion = expect(request).rejects.toMatchObject({
      code: 'timeout',
      method: 'slow-request',
      timeoutMs: REQUEST_TIMEOUT_MS.default,
    })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.default)

    await assertion
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports RPC and long timeout presets', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', pendingFetch())

    const rpcRequest = fetchWithTimeout('/rpc', undefined, { timeout: 'rpc', operation: 'rpc' })
    const longRequest = fetchWithTimeout('/long', undefined, { timeout: 'long', operation: 'long' })
    const rpcAssertion = expect(rpcRequest).rejects.toMatchObject({ code: 'timeout', timeoutMs: REQUEST_TIMEOUT_MS.rpc })
    const longAssertion = expect(longRequest).rejects.toMatchObject({ code: 'timeout', timeoutMs: REQUEST_TIMEOUT_MS.long })

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.rpc)
    await rpcAssertion

    let longSettled = false
    void longRequest.finally(() => { longSettled = true }).catch(() => undefined)
    await Promise.resolve()
    expect(longSettled).toBe(false)

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.long - REQUEST_TIMEOUT_MS.rpc)
    await longAssertion
  })

  it('allows an explicit timeout override', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', pendingFetch())

    const request = fetchWithTimeout('/custom', undefined, { timeout: 25, operation: 'custom' })
    const assertion = expect(request).rejects.toMatchObject({ code: 'timeout', timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)

    await assertion
  })

  it('classifies caller cancellation separately from timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', pendingFetch())
    const controller = new AbortController()

    const request = fetchWithTimeout('/cancelled', undefined, {
      signal: controller.signal,
      operation: 'cancelled-request',
    })
    controller.abort()

    await expect(request).rejects.toMatchObject({
      code: 'aborted',
      method: 'cancelled-request',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start fetch when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(fetchWithTimeout('/cancelled', undefined, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps network failures distinct from timeout failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('connection refused')
    }))

    await expect(fetchWithTimeout('/offline', undefined, {
      operation: 'offline-request',
    })).rejects.toMatchObject({
      code: 'network_error',
      method: 'offline-request',
    })
  })

  it('applies the timeout while consuming the response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('headers-arrived')))

    const request = requestWithTimeout('/slow-body', undefined, async () => new Promise<string>(() => {}), {
      timeout: 40,
      operation: 'slow-body',
    })
    const assertion = expect(request).rejects.toMatchObject({ code: 'timeout', timeoutMs: 40 })
    await vi.advanceTimersByTimeAsync(40)

    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves response parsing errors instead of reporting network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json')))

    await expect(requestWithTimeout('/invalid', undefined, async (response) => response.json()))
      .rejects.not.toMatchObject({ code: 'network_error' })
  })

  it('keeps concurrent request timers isolated', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', pendingFetch())

    const first = requestTextWithTimeout('/first', undefined, { timeout: 20, operation: 'first' })
    const second = requestTextWithTimeout('/second', undefined, { timeout: 50, operation: 'second' })
    const firstAssertion = expect(first).rejects.toMatchObject({ method: 'first', code: 'timeout' })
    const secondAssertion = expect(second).rejects.toMatchObject({ method: 'second', code: 'timeout' })

    await vi.advanceTimersByTimeAsync(20)
    await firstAssertion

    await vi.advanceTimersByTimeAsync(30)
    await secondAssertion
    expect(vi.getTimerCount()).toBe(0)
  })
})
