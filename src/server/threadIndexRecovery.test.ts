import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRolloutHeader, ThreadIndexRecovery } from './threadIndexRecovery'

const homes: string[] = []
const services: ThreadIndexRecovery[] = []
const id = '019a0000-1111-2222-3333-444444444444'
const existingId = '019a0000-1111-2222-3333-555555555555'
const stamp = '2026-09-26T01:02:03.000Z'
const rollout = (threadId = id) => `rollout-2026-09-26T01-02-03-${threadId}.jsonl`
const body = (threadId = id) => `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, timestamp: stamp } })}\n${'sensitive history body'.repeat(1000)}`
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'webui-index-test-'))
  homes.push(home)
  await mkdir(join(home, 'sessions'), { recursive: true })
  return home
}
function recovery(home: string, options: { persist?: boolean; busy?: () => boolean; active?: () => boolean; supported?: boolean; rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const indexed = new Set([existingId])
  const onRecovered = vi.fn()
  const rpc = vi.fn(options.rpc ?? (async (method, params) => {
    if (method === 'thread/read') {
      if (options.persist !== false) indexed.add(String(params.threadId))
      return { thread: { id: params.threadId, turns: [] } }
    }
    return { data: params.archived ? [] : [...indexed].map(id => ({ id })), nextCursor: null }
  }))
  const service = new ThreadIndexRecovery({ home: () => home, rpc, isBusy: options.busy ?? (() => false),
    supportsFastList: async () => options.supported !== false, hasActiveTurns: options.active, onRecovered, pauseMs: 2 })
  services.push(service)
  return { service, rpc, onRecovered }
}
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('native thread index recovery', () => {
  it('repairs only absent IDs, uses metadata reads and verifies native persistence', async () => {
    const home = await setup()
    await writeFile(join(home, 'sessions', rollout()), body())
    // An existing indexed file needs no content reads, even with a malformed body.
    await writeFile(join(home, 'sessions', rollout(existingId)), 'not a readable JSON header')
    const { service, rpc, onRecovered } = recovery(home)
    await service.check()
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toEqual([['thread/read', { threadId: id, includeTurns: false }]])
    for (const [method, params] of rpc.mock.calls) if (method === 'thread/list') expect(params.useStateDbOnly).toBe(true)
    expect(service.getStatus()).toMatchObject({ state: 'ready', scannedFiles: 2, missingThreads: 1, repairedThreads: 1, failedThreads: 0 })
    expect(onRecovered).toHaveBeenCalledTimes(1)
    await service.check()
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
  })

  it('does not mistake a successful read for persisted indexing', async () => {
    const home = await setup()
    await writeFile(join(home, 'sessions', rollout()), body())
    const { service, onRecovered } = recovery(home, { persist: false })
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'partial', repairedThreads: 0, failedThreads: 1 })
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it('includes archived and every native source kind without unarchiving or writing SQL', async () => {
    const home = await setup()
    await mkdir(join(home, 'archived_sessions'))
    await writeFile(join(home, 'archived_sessions', rollout()), body())
    const { service, rpc } = recovery(home)
    await service.check()
    expect(rpc.mock.calls.some(([method, params]) => method === 'thread/list' && params.archived === true && (params.sourceKinds as string[]).includes('subAgentThreadSpawn'))).toBe(true)
    expect(rpc.mock.calls.every(([method]) => method === 'thread/list' || method === 'thread/read')).toBe(true)
  })

  it('coalesces simultaneous repair requests and defers maintenance during active chat', async () => {
    const home = await setup()
    await writeFile(join(home, 'sessions', rollout()), body())
    let busy = true
    const { service, rpc } = recovery(home, { busy: () => busy })
    const first = service.check()
    expect(service.check()).toBe(first)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(service.getStatus().state).toBe('paused')
    expect(rpc).not.toHaveBeenCalled()
    busy = false
    await first
    expect(service.getStatus().state).toBe('ready')
  })

  it('paces recovery during an active model turn without waiting for the turn to finish', async () => {
    const home = await setup()
    await writeFile(join(home, 'sessions', rollout()), body())
    const { service, rpc } = recovery(home, { busy: () => false, active: () => true })
    const start = Date.now()
    await service.check()
    expect(Date.now() - start).toBeGreaterThanOrEqual(240)
    expect(service.getStatus().state).toBe('ready')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
  })

  it('cancels paused work on disposal and never sends a deferred RPC', async () => {
    const home = await setup()
    const { service, rpc } = recovery(home, { busy: () => true })
    const pending = service.check()
    await new Promise(resolve => setTimeout(resolve, 5))
    service.dispose()
    await pending
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reports unsupported CLI without launching legacy full history maintenance', async () => {
    const home = await setup()
    const { service, rpc } = recovery(home, { supported: false })
    await service.check()
    expect(service.getStatus().state).toBe('unsupported')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reports malformed and oversized headers without reading conversation bodies', async () => {
    const home = await setup()
    const file = join(home, 'sessions', rollout())
    await writeFile(file, `${' '.repeat(1024 * 1024 + 1)}\n${body()}`)
    expect(await readRolloutHeader(file)).toBeNull()
    const { service, rpc } = recovery(home)
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'partial', failedThreads: 1 })
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(0)
  })

  it('accepts real session metadata with more than 22 KiB of base instructions', async () => {
    const home = await setup()
    const file = join(home, 'sessions', rollout())
    const header = { type: 'session_meta', payload: { id, timestamp: stamp, base_instructions: { text: 'x'.repeat(24_000) } } }
    await writeFile(file, JSON.stringify(header) + '\n' + 'history'.repeat(100_000))
    expect(await readRolloutHeader(file)).toEqual({ id, timestamp: stamp })
    const { service } = recovery(home)
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'ready', repairedThreads: 1 })
  })

  it('migrates only an unindexed legacy WebUI import without changing bytes', async () => {
    const home = await setup()
    const directory = join(home, 'sessions', 'imported')
    await mkdir(directory)
    const original = join(directory, `000001-${id}.jsonl`)
    await writeFile(original, body())
    const { service } = recovery(home)
    await service.check()
    expect(await readFile(join(directory, rollout()), 'utf8')).toBe(body())
    await expect(readFile(original)).rejects.toThrow()
    expect(service.getStatus().state).toBe('ready')
  })

  it('never overwrites an existing target while migrating a legacy import', async () => {
    const home = await setup()
    const directory = join(home, 'sessions', 'imported')
    await mkdir(directory)
    const original = join(directory, `000001-${id}.jsonl`)
    const target = join(directory, rollout())
    await writeFile(original, body())
    await writeFile(target, 'untouched')
    const { service } = recovery(home)
    await service.check()
    expect(await readFile(original, 'utf8')).toBe(body())
    expect(await readFile(target, 'utf8')).toBe('untouched')
    expect(service.getStatus().state).toBe('partial')
  })

  it('stops repeated pagination cursors and reports partial rather than looping or repairing', async () => {
    const home = await setup()
    const { service, rpc } = recovery(home, { rpc: async () => ({ data: [], nextCursor: 'same' }) })
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'partial', truncated: true })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})

describe('native list visibility is not complete index membership', () => {
  it('classifies verified empty hidden records and does not reread unchanged rollouts every pass', async () => {
    const home = await setup()
    const file = join(home, 'sessions', rollout())
    await writeFile(file, body())
    const { service, rpc } = recovery(home, { rpc: async (method) => method === 'thread/list'
      ? { data: [], nextCursor: null }
      : { thread: { id, preview: '', name: null, path: file } } })
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'ready', hiddenThreads: 1, missingThreads: 0, failedThreads: 0, repairedThreads: 0 })
    await service.check()
    expect(service.getStatus()).toMatchObject({ state: 'ready', hiddenThreads: 1, missingThreads: 0, failedThreads: 0 })
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
  })

  it('rechecks changed hidden files and explicit manual retries', async () => {
    const home = await setup()
    const file = join(home, 'sessions', rollout())
    await writeFile(file, body())
    let populated = false, indexed = false
    const { service, rpc, onRecovered } = recovery(home, { rpc: async method => {
      if (method === 'thread/list') return { data: indexed ? [{ id }] : [], nextCursor: null }
      if (populated) indexed = true
      return { thread: { id, preview: populated ? 'new user message' : '', name: null, path: file } }
    } })
    await service.check()
    await service.check(false, true)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2)
    populated = true
    await writeFile(file, body() + '\nnew event\n')
    await service.check()
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(3)
    expect(service.getStatus()).toMatchObject({ state: 'ready', hiddenThreads: 0, repairedThreads: 1, failedThreads: 0 })
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('does not reuse an empty-record fingerprint for the same ID at another path', async () => {
    const home = await setup()
    let file = join(home, 'sessions', rollout())
    await writeFile(file, body())
    const { service, rpc } = recovery(home, { rpc: async method => method === 'thread/list'
      ? { data: [], nextCursor: null }
      : { thread: { id, preview: '', name: null, path: file } } })
    await service.check()
    const previousPath = file
    await mkdir(join(home, 'archived_sessions'))
    file = join(home, 'archived_sessions', rollout())
    await rename(previousPath, file)
    await service.check()
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2)
    expect(service.getStatus()).toMatchObject({ state: 'ready', hiddenThreads: 1 })
  })

  it('does not hide unverified, non-empty, named or wrong-path failed recoveries', async () => {
    for (const summary of [
      { id, path: '', preview: '' },
      { id, preview: 'has conversation', name: null },
      { id, preview: '', name: 'named conversation' },
      { id },
    ]) {
      const home = await setup()
      const file = join(home, 'sessions', rollout())
      await writeFile(file, body())
      const { service } = recovery(home, { rpc: async method => method === 'thread/list'
        ? { data: [], nextCursor: null }
        : { thread: { path: file, ...summary } } })
      await service.check()
      expect(service.getStatus()).toMatchObject({ state: 'partial', hiddenThreads: 0, failedThreads: 1 })
    }
  })
})
