import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'
import { readRequestUserInputHistory } from './requestUserInputHistory'
import { isBlockingServerRequest, serverRequestIdentity } from '../serverRequests'

type Harness = { handleLine: (line: string, generation?: number) => void; initialized: boolean; pending: Map<number, unknown> }
const originalHome = process.env.CODEX_HOME
let home = ''
let server: AppServerProcess
let harness: Harness
let writeJson: ReturnType<typeof vi.fn<(payload: Record<string, unknown>, generation?: number) => void>>
let notifications: Array<{ method: string; params: unknown }>

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'webui-native-requests-'))
  process.env.CODEX_HOME = home
  writeJson = vi.fn()
  notifications = []
  server = new AppServerProcess(null, undefined, () => ({ running: true, activeGeneration: 9, start: () => 9, stop: () => 9, writeJson }))
  server.onNotification(notification => notifications.push(notification))
  harness = server as unknown as Harness
  harness.initialized = true
})

afterEach(async () => {
  server.dispose()
  if (originalHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

function question(id: string | number = 901, isBlocking = false): void {
  harness.handleLine(JSON.stringify({ id, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking, questions: [{ id: 'scope', question: 'Next?', header: 'Scope' }] } }), 9)
}

describe('Codex 0.153 request lifecycle', () => {
  it('cleans a native resolution without sending a fake answer or remaining busy', async () => {
    question()
    expect(server.listPendingServerRequests()).toHaveLength(1)
    expect(server.isBusy()).toBe(false)
    harness.handleLine(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 901 } }), 9)
    await vi.waitFor(() => expect(notifications.some(notification => notification.method === 'server/request/resolved')).toBe(true))
    expect(server.listPendingServerRequests()).toHaveLength(0)
    expect(server.isBusy()).toBe(false)
    expect(writeJson).not.toHaveBeenCalled()
    expect((await readRequestUserInputHistory('thread')).thread?.[0]?.status).toBe('unanswered')
    question()
    expect(server.listPendingServerRequests()).toHaveLength(0)
  })

  it('does not let native completion overwrite a manually submitted answer', async () => {
    question('request-901', true)
    expect(server.isBusy()).toBe(true)
    await server.respondToServerRequest({ id: 'request-901', generation: 9, result: { answers: { scope: { answers: ['Keep this answer'] } } } })
    harness.handleLine(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'request-901' } }), 9)
    expect(writeJson).toHaveBeenCalledTimes(1)
    expect((await readRequestUserInputHistory('thread')).thread?.[0]).toMatchObject({ status: 'answered', questions: [{ answers: ['Keep this answer'] }] })
    expect(serverRequestIdentity(1, 9)).not.toBe(serverRequestIdentity('1', 9))
  })

  it('guards generation and thread when resolving requests', () => {
    question()
    harness.handleLine(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 901 } }), 8)
    harness.handleLine(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 901 } }), 9)
    expect(server.listPendingServerRequests()).toHaveLength(1)
  })

  it('does not mistake a server request for a client response with the same numeric id', () => {
    const resolve = vi.fn()
    harness.pending.set(901, { generation: 9, resolve, reject: vi.fn() })
    question()
    expect(resolve).not.toHaveBeenCalled()
    expect(server.listPendingServerRequests()).toHaveLength(1)
    harness.handleLine(JSON.stringify({ id: 901, result: { ok: true } }), 9)
    expect(resolve).toHaveBeenCalledWith({ ok: true })
  })

  it('does not interpret approval requests as nonblocking based on an unrelated field', () => {
    expect(isBlockingServerRequest({ method: 'item/permissions/requestApproval', params: { isBlocking: false } })).toBe(true)
    expect(isBlockingServerRequest({ method: 'request_user_input', params: {} })).toBe(true)
  })
})
