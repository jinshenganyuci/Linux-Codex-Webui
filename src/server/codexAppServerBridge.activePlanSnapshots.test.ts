import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { getActivePlanPersistencePath } from './activePlanPersistence'
import { readPlanSummaryHistory } from './planSummaryHistory'

const sharedBridgeKey = '__codexRemoteSharedBridge__'
const scope = globalThis as typeof globalThis & Record<string, unknown>
let previousBridge: unknown, previousHome: string | undefined, codexHome = ''
const middlewares: ReturnType<typeof createCodexBridgeMiddleware>[] = []
const closers: Array<() => Promise<void>> = []
beforeEach(async () => {
  previousBridge = scope[sharedBridgeKey]; previousHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-plan-bridge-')); process.env.CODEX_HOME = codexHome
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const middleware of middlewares.splice(0)) await middleware.disposeGracefully()
  if (previousBridge === undefined) delete scope[sharedBridgeKey]; else scope[sharedBridgeKey] = previousBridge
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome
  await rm(codexHome, { recursive: true, force: true })
})
function harness() {
  let listener: (value: { method: string; params: unknown; generation?: number }) => void = () => {}
  const noOp = () => undefined, rpc = vi.fn(async () => ({}))
  scope[sharedBridgeKey] = {
    version: 'experimental-api-v6-native-extensions',
    appServer: { rpc, onNotification: (next: typeof listener) => { listener = next; return noOp }, dispose: noOp, disposeWhenIdle: async () => undefined },
    terminalManager: { subscribe: () => noOp, dispose: noOp }, methodCatalog: {},
    telegramBridge: { configureAllowedUserIds: noOp, configureToken: noOp, start: noOp, stop: noOp },
    backendQueueProcessor: { dispose: noOp }, threadRuntimeState: { dispose: async () => undefined },
  }
  const middleware = createCodexBridgeMiddleware({ backgroundMaintenance: false, planPersistence: true }); middlewares.push(middleware)
  const frames: Array<{ method: string; params: unknown }> = []; middleware.subscribeNotifications(frame => frames.push(frame))
  return { middleware, rpc, frames, appServer: (scope[sharedBridgeKey] as { appServer: { disposeWhenIdle: () => Promise<void> } }).appServer, emit: (method: string, params: unknown) => listener({ method, params, generation: 7 }) }
}
async function serverFor(middleware: ReturnType<typeof createCodexBridgeMiddleware>) {
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no test address')
  return `http://127.0.0.1:${address.port}`
}
async function ready(url: string) {
  const abort = new AbortController(), response = await fetch(url + '/codex-api/events', { signal: abort.signal })
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let text = ''
  try { while (!text.includes('event: ready\n')) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }) } }
  finally { abort.abort() }
  const event = text.slice(text.indexOf('event: ready\n')).split('\n').find(line => line.startsWith('data: '))
  return JSON.parse(event!.slice(6))
}
const checklist = (status = 'inProgress') => ({ threadId: 'thread-a', turnId: 'turn-a', explanation: 'Ship safely', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Ship', status }] })

describe('authoritative plan bridge recovery', () => {
  it('sends independent authoritative updates and advertises bounded snapshots in SSE ready', async () => {
    const { middleware, emit, frames } = harness()
    emit('turn/plan/updated', checklist())
    emit('item/plan/delta', { threadId: 'thread-a', turnId: 'turn-a', itemId: 'draft-a', delta: 'Proposed document' })
    const updates = frames.filter(frame => frame.method === 'codex-ui/plan-updated')
    expect(updates).toHaveLength(2)
    expect(updates.map(frame => (frame.params as { snapshot: { kind: string } }).snapshot.kind)).toEqual(['checklist', 'proposal'])
    const payload = await ready(await serverFor(middleware))
    expect(payload.planSnapshotsVersion).toBe(1)
    expect(payload.activePlans).toHaveLength(2)
    expect(payload.activePlans[0]).toMatchObject({ kind: 'checklist', messageId: 'turn-a:plan', generation: 7 })
    expect(payload.activePlans[1]).toMatchObject({ kind: 'proposal', itemId: 'draft-a', text: 'Proposed document' })
  })

  it('persists both terminal identities without a browser and never marks an unfinished checklist completed', async () => {
    const { middleware, emit } = harness()
    emit('turn/plan/updated', checklist())
    emit('item/completed', { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'draft-a', type: 'plan', text: 'Final proposed plan' } })
    emit('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } })
    await middleware.disposeGracefully(); middlewares.splice(middlewares.indexOf(middleware), 1)
    const summaries = (await readPlanSummaryHistory('thread-a'))['thread-a']
    expect(summaries).toHaveLength(2)
    expect(summaries.find(row => row.kind === 'checklist')).toMatchObject({ lifecycle: 'incomplete' })
    expect(summaries.find(row => row.kind === 'proposal')).toMatchObject({ lifecycle: 'completed', itemId: 'draft-a' })
    const stored = JSON.parse(await readFile(getActivePlanPersistencePath(), 'utf8'))
    expect(JSON.stringify(stored)).toContain('Final proposed plan')
    expect(JSON.stringify(stored)).toContain('incomplete')
  })

  it('restores a running plan as unconfirmed after server restart and continues its persisted revision', async () => {
    const first = harness(); first.emit('turn/plan/updated', checklist())
    await first.middleware.disposeGracefully(); middlewares.splice(middlewares.indexOf(first.middleware), 1)
    const second = harness()
    await vi.waitFor(() => expect(second.middleware.getActivePlanSnapshots()[0]).toMatchObject({ lifecycle: 'unconfirmed', revision: 2, generation: 7 }))
    second.emit('turn/plan/updated', checklist('completed'))
    expect(second.middleware.getActivePlanSnapshots()[0]).toMatchObject({ lifecycle: 'live', revision: 3 })
    second.emit('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } })
    expect(second.middleware.getActivePlanSnapshots()[0]).toMatchObject({ lifecycle: 'completed', revision: 4 })
  })

  it('clears saved plans before a successful delete response and ignores late updates', async () => {
    const { middleware, emit } = harness(); emit('turn/plan/updated', checklist())
    const url = await serverFor(middleware)
    const response = await fetch(url + '/codex-api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'thread/delete', params: { threadId: 'thread-a' } }) })
    expect(response.status).toBe(200)
    expect(middleware.getActivePlanSnapshots()).toEqual([])
    emit('turn/plan/updated', { ...checklist(), turnId: 'late-turn' })
    expect(middleware.getActivePlanSnapshots()).toEqual([])
    expect(await readPlanSummaryHistory('thread-a')).toEqual({})
    expect(JSON.parse(await readFile(getActivePlanPersistencePath(), 'utf8')).snapshots).toEqual([])
  })

  it('keeps terminal notification persistence alive while graceful shutdown waits for a running turn', async () => {
    const { middleware, emit, appServer } = harness()
    emit('turn/plan/updated', checklist())
    let finish!: () => void
    const idle = new Promise<void>(resolve => { finish = resolve })
    appServer.disposeWhenIdle = () => idle
    const closing = middleware.disposeGracefully()
    await new Promise(resolve => setTimeout(resolve, 10))
    emit('turn/plan/updated', checklist('completed'))
    emit('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } })
    finish(); await closing; middlewares.splice(middlewares.indexOf(middleware), 1)
    expect((await readPlanSummaryHistory('thread-a'))['thread-a'][0]).toMatchObject({ lifecycle: 'completed', revision: 3 })
    const persisted = await readFile(getActivePlanPersistencePath(), 'utf8')
    expect(persisted).toContain('"lifecycle":"completed"')
  })

  it('marks a live plan unconfirmed after native runtime loss without inventing completion', () => {
    const { middleware, emit } = harness(); emit('turn/plan/updated', checklist())
    emit('codex-ui/runtime-stopped', {})
    expect(middleware.getActivePlanSnapshots()[0]).toMatchObject({ lifecycle: 'unconfirmed', revision: 2 })
    emit('codex-ui/runtime-stopped', {})
    expect(middleware.getActivePlanSnapshots()[0]?.revision).toBe(2)
  })
})
