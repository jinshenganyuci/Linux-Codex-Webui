import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'
import { createRuntimeDiagnosticsReader } from './runtimeDiagnostics'
import type { AppServerJsonlTransportEvent } from './appServerJsonlTransport'

function harness() {
  let emit!: (event: AppServerJsonlTransportEvent) => void
  let running = true
  let generation = 7
  const start = vi.fn(() => generation)
  const stop = vi.fn(() => { running = false; const previous = generation; generation = 0; return previous })
  const writeJson = vi.fn()
  const server = new AppServerProcess(null, undefined, listener => {
    emit = listener
    return { get running() { return running }, get activeGeneration() { return generation }, start, stop, writeJson }
  })
  const internals = server as unknown as { initialized: boolean; runtimeUserAgent: string; call: (method: string, params: unknown) => Promise<unknown> }
  internals.initialized = true
  internals.runtimeUserAgent = 'codex-cli 0.159.3'
  const reply = (id: number, result: unknown) => emit({ type: 'line', generation: 7, line: JSON.stringify({ id, result }) })
  const readMemoryStatus = vi.fn((signal: AbortSignal) => server.readRuntimeMemoryStatus(signal))
  const reader = createRuntimeDiagnosticsReader({
    runtimeInfo: () => server.getRuntimeInfo(), readMemoryStatus, timeoutMs: 100,
    systemCli: { read: async () => ({ status: 'available', version: '0.159.3', command: '/global/codex', checkedAt: '' }) },
  })
  return { server, internals, reader, readMemoryStatus, writeJson, start, stop, reply }
}

afterEach(() => vi.useRealTimers())

describe('bounded memory diagnostics on the real app-server pending lifecycle', () => {
  it('removes timed-out pending diagnostics, releases idle waiters, and ignores late responses', async () => {
    vi.useFakeTimers()
    const { server, reader, readMemoryStatus, writeJson, reply } = harness()
    const request = reader.read()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.hasPendingRpc()).toBe(true)
    const requestId = writeJson.mock.calls[0]![0].id
    let idle = false
    const idleWait = server.waitUntilIdle().then(() => { idle = true })
    await vi.advanceTimersByTimeAsync(100)
    expect((await request).memory.status).toBe('unknown')
    await idleWait
    expect(server.hasPendingRpc()).toBe(false)
    expect(server.isBusy()).toBe(false)
    expect(idle).toBe(true)
    expect(readMemoryStatus.mock.calls[0]![0].aborted).toBe(true)
    reply(requestId, { v2Ready: true, v2ConsolidatedThreads: 999 })
    const refreshed = await Promise.all(Array.from({ length: 25 }, () => reader.read(true)))
    expect(readMemoryStatus).toHaveBeenCalledTimes(1)
    expect(refreshed.every(value => value.memory.status === 'unknown' && value.memory.v2ConsolidatedThreads === null)).toBe(true)
    server.dispose()
  })

  it.each(['configuration restart', 'graceful shutdown'])('unblocks %s when diagnostics hit their deadline', async operation => {
    vi.useFakeTimers()
    const { server, reader, stop } = harness()
    const request = reader.read()
    await vi.advanceTimersByTimeAsync(0)
    let drain: Promise<void> | undefined
    if (operation === 'configuration restart') expect(server.requestConfigRestartWhenIdle()).toBe(false)
    else drain = server.disposeWhenIdle()
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    await request
    await drain
    expect(server.hasPendingRpc()).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('cancels only memory diagnostics and preserves ordinary RPCs in drain accounting', async () => {
    const { server, internals, writeJson, reply } = harness()
    const controller = new AbortController()
    const diagnostic = server.readRuntimeMemoryStatus(controller.signal)
    const ordinary = internals.call('thread/read', { threadId: 'active', includeTurns: false })
    const ordinaryId = writeJson.mock.calls[1]![0].id
    controller.abort()
    await expect(diagnostic).rejects.toThrow('canceled')
    expect(server.hasPendingRpc()).toBe(true)
    expect(server.isBusy()).toBe(true)
    reply(ordinaryId, { thread: { id: 'active' } })
    await ordinary
    expect(server.isBusy()).toBe(false)
    server.dispose()
  })

  it('does not start or initialize a stopped runtime for diagnostics', async () => {
    const { server, start, writeJson } = harness()
    server.dispose()
    await expect(server.readRuntimeMemoryStatus(new AbortController().signal)).rejects.toThrow('not ready')
    expect(start).not.toHaveBeenCalled()
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('cleans its abort listener after a successful reply', async () => {
    const { server, writeJson, reply } = harness()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const diagnostic = server.readRuntimeMemoryStatus(controller.signal)
    reply(writeJson.mock.calls[0]![0].id, { v2Ready: true, v2ConsolidatedThreads: 3 })
    await expect(diagnostic).resolves.toEqual({ v2Ready: true, v2ConsolidatedThreads: 3 })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(server.hasPendingRpc()).toBe(false)
    server.dispose()
  })
})
