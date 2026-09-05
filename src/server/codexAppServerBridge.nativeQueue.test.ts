import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { NATIVE_QUEUE_METHODS } from '../nativeThreadControls'

const originalHome = process.env.CODEX_HOME
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (originalHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalHome
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'native-queue-test-'))
  process.env.CODEX_HOME = home
  const scope = globalThis as typeof globalThis & Record<string, unknown>
  const previous = scope.__codexRemoteSharedBridge__
  const rows: unknown[] = []
  let busy = false
  const rpc = vi.fn(async (method: string, params: unknown) => {
    if (method === 'thread/queue/list') return { data: rows, nextCursor: null }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: busy ? 'active' : 'idle' } } }
    if (method === 'thread/queue/add') {
      const input = params as Record<string, unknown>
      const queuedSubmission = { id: 'native-item', clientUserMessageId: input.clientUserMessageId, input: input.input }
      rows.push(queuedSubmission)
      return { queuedSubmission }
    }
    return {}
  })
  const noOp = () => undefined
  const methods = vi.fn(async () => NATIVE_QUEUE_METHODS)
  scope.__codexRemoteSharedBridge__ = {
    version: 'experimental-api-v6-native-extensions',
    appServer: { rpc, onNotification: () => noOp, dispose: noOp, disposeWhenIdle: async () => {}, isThreadBusy: () => busy, getNativeThreadSettings: () => null, emitLocalNotification: vi.fn() },
    terminalManager: { subscribe: () => noOp, dispose: noOp }, methodCatalog: { listMethods: methods },
    telegramBridge: { configureAllowedUserIds: noOp, configureToken: noOp, start: noOp, stop: noOp },
    backendQueueProcessor: { dispose: noOp, scheduleAllQueuedThreads: vi.fn() },
    threadRuntimeState: { dispose: async () => {} },
  }
  const middleware = createCodexBridgeMiddleware()
  const server = createServer((request, response) => void middleware(request, response, () => { response.statusCode = 404; response.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    middleware.dispose()
    if (previous === undefined) delete scope.__codexRemoteSharedBridge__
    else scope.__codexRemoteSharedBridge__ = previous
    await rm(home, { recursive: true, force: true })
  })
  const request = (endpoint: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${endpoint}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const mode = (value: string) => request('/codex-api/native-queue-mode', 'PUT', { threadId: 'thread', mode: value })
  const legacy = (text = 'keep legacy') => request('/codex-api/thread-queue-state', 'PUT', { thread: [{ id: 'old-id', text, imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', model: 'gpt-5.6-luna' }] })
  return { home, request, mode, legacy, rpc, methods, rows, setBusy: (value: boolean) => { busy = value } }
}

describe('native queue single-owner migration', () => {
  it('keeps existing legacy messages and refuses a non-empty migration', async () => {
    const test = await fixture()
    expect((await test.legacy()).status).toBe(200)
    const result = await test.mode('native')
    expect(result.status).toBe(409)
    expect(await result.text()).toContain('不会丢弃消息')
    const queue = await test.request('/codex-api/thread-queue-state').then(response => response.json())
    expect(queue.data.thread[0].text).toBe('keep legacy')
  })

  it('persists native ownership and rejects stale legacy writers and non-empty downgrade', async () => {
    const test = await fixture()
    expect((await test.mode('native')).status).toBe(200)
    expect((await test.legacy('must not send')).status).toBe(409)
    const result = await test.request('/codex-api/rpc', 'POST', { method: 'thread/queue/add', params: { threadId: 'thread', clientUserMessageId: 'client-1', input: [{ type: 'text', text: 'native only' }] } })
    expect(result.status).toBe(200)
    expect(test.rows).toHaveLength(1)
    expect((await test.mode('legacy')).status).toBe(409)
    const disk = JSON.parse(await readFile(join(test.home, 'webui-native-queue-owners.json'), 'utf8'))
    expect(disk['linux-codex-webui-native-queue-threads']).toEqual(['thread'])
    await writeFile(join(test.home, '.codex-global-state.json'), JSON.stringify({ 'thread-titles': {} }))
    expect((await test.legacy('stale after global state write')).status).toBe(409)
    test.rows.length = 0
    expect((await test.mode('legacy')).status).toBe(200)
    expect((await test.legacy()).status).toBe(200)
  })

  it('refuses switching active threads or using an incomplete native API', async () => {
    const test = await fixture()
    test.setBusy(true)
    expect((await test.mode('native')).status).toBe(409)
    test.setBusy(false)
    test.methods.mockResolvedValue(['thread/queue/list'])
    expect((await test.mode('native')).status).toBe(409)
    const response = await test.request('/codex-api/rpc', 'POST', { method: 'thread/queue/add', params: { threadId: 'thread', clientUserMessageId: 'client', input: [] } })
    expect(response.status).toBe(409)
    expect(test.rpc.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false)
  })

  it('serializes a stale legacy write behind a concurrent ownership change', async () => {
    const test = await fixture()
    const originalRpc = test.rpc.getMockImplementation()!
    let finish!: (value: Awaited<ReturnType<typeof originalRpc>>) => void
    test.rpc.mockImplementation(async (method, params) => method === 'thread/queue/list' ? new Promise(resolve => { finish = resolve }) as ReturnType<typeof originalRpc> : originalRpc(method, params))
    const switching = test.mode('native')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const staleWrite = test.legacy('stale tab')
    finish({ data: [], nextCursor: null })
    expect((await switching).status).toBe(200)
    expect((await staleWrite).status).toBe(409)
  })

  it('does not start a second native turn while the thread is busy', async () => {
    const test = await fixture()
    expect((await test.mode('native')).status).toBe(200)
    test.setBusy(true)
    const response = await test.request('/codex-api/rpc', 'POST', { method: 'thread/queue/start', params: { threadId: 'thread', queuedSubmissionId: 'pending' } })
    expect(response.status).toBe(409)
    expect(test.rpc.mock.calls.some(([method]) => method === 'thread/queue/start')).toBe(false)
  })
})
