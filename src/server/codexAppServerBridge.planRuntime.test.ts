import { describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'
import type { AppServerJsonlTransportEvent, AppServerJsonlTransportFactory } from './appServerJsonlTransport'

function harness() {
  let listener: (event: AppServerJsonlTransportEvent) => void = () => {}
  let running = true
  const writes: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  const start = vi.fn(() => 1)
  const factory: AppServerJsonlTransportFactory = emit => {
    listener = emit
    return {
      get running() { return running },
      get activeGeneration() { return running ? 1 : 0 },
      start,
      stop() { running = false; return 1 },
      writeJson(payload) {
        const request = payload as unknown as typeof writes[number]
        writes.push(request)
        const result = request.method === 'config/read'
          ? { config: {}, layers: [] }
          : request.method === 'thread/read'
            ? { thread: { id: 'old', cwd: '/project' } }
            : { thread: { id: 'new', cwd: '/project' } }
        queueMicrotask(() => listener({ type: 'line', generation: 1, line: JSON.stringify({ id: request.id, result }) }))
      },
    }
  }
  const appServer = new AppServerProcess(null, undefined, factory, async () => true)
  const internals = appServer as unknown as { initialized: boolean; runtimeUserAgent: string; disposeIfConfigChanged(): void }
  internals.initialized = true
  internals.runtimeUserAgent = 'linux-codex-webui/0.154.0 (test)'
  vi.spyOn(internals, 'disposeIfConfigChanged').mockImplementation(() => {})
  return { appServer, writes, start }
}

describe('app-server plan tool integration', () => {
  it('injects native thread config for new and restored threads without restarting the process', async () => {
    const { appServer, writes, start } = harness()
    try {
      await appServer.rpc('thread/start', { cwd: '/project' })
      await appServer.rpc('thread/resume', { threadId: 'old' })
      expect(writes.map(request => request.method)).toEqual(['config/read', 'thread/start', 'thread/read', 'config/read', 'thread/resume'])
      expect(writes.find(request => request.method === 'thread/start')?.params).toMatchObject({ config: { 'tools.update_plan.enabled': true } })
      expect(writes.find(request => request.method === 'thread/resume')?.params).toEqual({ threadId: 'old', config: { 'tools.update_plan.enabled': true } })
      expect(start).not.toHaveBeenCalled()
    } finally { appServer.dispose() }
  })

  it('does not inspect configuration on lists, metadata reads, or normal turn starts', async () => {
    const { appServer, writes, start } = harness()
    try {
      await appServer.rpc('thread/list', { limit: 50 })
      await appServer.rpc('thread/read', { threadId: 'old', includeTurns: false })
      await appServer.rpc('turn/start', { threadId: 'old', input: [] })
      expect(writes.map(request => request.method)).toEqual(['thread/list', 'thread/read', 'turn/start'])
      expect(start).not.toHaveBeenCalled()
    } finally { appServer.dispose() }
  })

  it('announces runtime shutdown before disconnecting plan listeners', () => {
    const { appServer } = harness()
    const methods: string[] = []
    appServer.onNotification(notification => methods.push(notification.method))
    appServer.dispose()
    expect(methods).toContain('codex-ui/runtime-stopped')
  })
})
