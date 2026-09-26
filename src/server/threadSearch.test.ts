import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThreadSearchService, extractSearchableThreadText } from './threadSearch'

const row = (id: string, name: string, updatedAt = 1) => ({ id, name, path: `/test-rollouts/${id}.jsonl`, preview: '', cwd: '/projects/example', updatedAt, createdAt: 1, turns: [{ secret: 'must never leak' }] })
const body = (text: string) => ({ thread: { turns: [{ items: [{ type: 'agentMessage', text }] }] } })
afterEach(() => vi.useRealTimers())

describe('server conversation search', () => {
  it('finds an older unloaded thread, hydrates its summary, and never reads bodies for title search', async () => {
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe('thread/list')
      expect(params.useStateDbOnly).toBe(true)
      return params.cursor ? { data: [row('older', 'Unique old question')], nextCursor: null } : { data: [row('new', 'recent')], nextCursor: 'next' }
    })
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({ older: 'My renamed question' }) })
    const found = await service.search('renamed')
    expect(found.threadIds).toEqual(['older'])
    expect(found.threads[0]).toMatchObject({ id: 'older', name: 'My renamed question', cwd: '/projects/example' })
    expect(found.threads[0]).not.toHaveProperty('turns')
    await service.search('recent')
    expect(rpc).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('returns metadata before explicitly requested body search finishes, sharing bounded background work', async () => {
    vi.useFakeTimers()
    let resolveRead!: (value: unknown) => void
    const rpc = vi.fn((method: string) => method === 'thread/list'
      ? Promise.resolve({ data: [row('first', 'title', 3), row('second', 'title', 2), row('third', 'title', 1)] })
      : new Promise(resolve => { resolveRead = resolve }))
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}), contentThreadLimit: 1 })
    const first = await service.search('body only', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(first.threadIds).toEqual([])
    expect(first.contentSearchState).toBe('loading')
    expect((await service.search('other', 100, { includeContent: true })).contentSearchState).toBe('loading')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    resolveRead(body('body only phrase'))
    await vi.advanceTimersByTimeAsync(30)
    const completed = await service.search('body only', 100, { includeContent: true })
    expect(completed.threadIds).toEqual(['first'])
    expect(completed.contentSearchState).toBe('ready')
    expect(completed.searchedContentCount).toBe(1)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    service.dispose()
  })

  it('invalidates renamed, deleted, and newly imported summaries without a permanent search snapshot', async () => {
    let time = 100
    let rows = [row('original', 'old name')]
    const rpc = vi.fn(async () => ({ data: rows }))
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}), now: () => time, metadataTtlMs: 10 })
    expect((await service.search('old')).threadIds).toEqual(['original'])
    rows = [row('original', 'new name')]
    service.invalidate('original')
    expect((await service.search('old')).threadIds).toEqual([])
    expect((await service.search('new')).threadIds).toEqual(['original'])
    rows = [row('imported', 'recovered')]
    time += 11
    expect((await service.search('recovered')).threadIds).toEqual(['imported'])
    expect((await service.search('new')).threadIds).toEqual([])
    service.dispose()
  })

  it('does not accept an invalidated in-flight snapshot as fresh', async () => {
    let resolveFirst!: (value: unknown) => void
    let calls = 0
    const rpc = vi.fn(async () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve }) : { data: [row('live', 'new')] })
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}) })
    const pending = service.search('old')
    service.invalidate('deleted')
    resolveFirst({ data: [row('deleted', 'old')] })
    expect((await pending).threadIds).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('reports bounded content coverage and retries only when explicitly requested', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn(async (method: string) => method === 'thread/list' ? { data: [row('one', 'title')] } : body('abcdefghi'))
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}), contentCharacterLimit: 3 })
    await service.search('abc', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(30)
    const partial = await service.search('abc', 100, { includeContent: true })
    expect(partial.contentSearchState).toBe('partial')
    expect(partial.threadIds).toEqual(['one'])
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    service.dispose()
  })

  it('expires partial content snapshots instead of keeping truncated stale results forever', async () => {
    vi.useFakeTimers()
    let time = 0
    let text = 'abcdef'
    const rpc = vi.fn(async (method: string) => method === 'thread/list' ? { data: [row('one', 'title')] } : body(text))
    const service = createThreadSearchService({ rpc, readTitles: async () => ({}), readRolloutFileSize: async () => 100, now: () => time, contentTtlMs: 50, contentCharacterLimit: 3 })
    await service.search('abc', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(30)
    expect((await service.search('abc', 100, { includeContent: true })).threadIds).toEqual(['one'])
    time = 60
    text = 'xyzuvw'
    const refreshing = await service.search('abc', 100, { includeContent: true })
    expect(refreshing.threadIds).toEqual([])
    await vi.advanceTimersByTimeAsync(30)
    expect((await service.search('xyz', 100, { includeContent: true })).threadIds).toEqual(['one'])
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2)
    service.dispose()
  })

  it('surfaces failed content search while keeping title matches and avoiding repeated failing reads', async () => {
    vi.useFakeTimers()
    let fail = true
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/list') return { data: [row('one', 'matching title')] }
      if (fail) throw new Error('temporary read error')
      return body('body match')
    })
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}) })
    await service.search('matching', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(30)
    const failed = await service.search('matching', 100, { includeContent: true })
    expect(failed.contentSearchState).toBe('error')
    expect(failed.threadIds).toEqual(['one'])
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    fail = false
    await service.search('body', 100, { includeContent: true, retryContent: true })
    await vi.advanceTimersByTimeAsync(30)
    expect((await service.search('body', 100, { includeContent: true })).threadIds).toEqual(['one'])
    service.dispose()
  })

  it('stops inactive background searches after the requester leaves', async () => {
    vi.useFakeTimers()
    let time = 0
    const rpc = vi.fn(async (method: string) => method === 'thread/list' ? { data: [row('one', 'title', 2), row('two', 'title', 1)] } : body('content'))
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}), now: () => time })
    await service.search('content', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(0)
    time = 6000
    await vi.advanceTimersByTimeAsync(30)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    service.dispose()
  })

  it('does not fan out native reads when a timed-out search is retried before its RPC settles', async () => {
    vi.useFakeTimers()
    let finishRead!: (value: unknown) => void
    const rpc = vi.fn((method: string) => method === 'thread/list'
      ? Promise.resolve({ data: [row('one', 'title')] })
      : new Promise(resolve => { finishRead = resolve }))
    const service = createThreadSearchService({ readRolloutFileSize: async () => 100, rpc, readTitles: async () => ({}), contentReadTimeoutMs: 100 })
    await service.search('title', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(101)
    expect((await service.search('title', 100, { includeContent: true, retryContent: true })).contentSearchState).toBe('error')
    service.invalidate('one')
    await service.search('title', 100, { includeContent: true, retryContent: true })
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    finishRead(body('late body'))
    await vi.advanceTimersByTimeAsync(1)
    await service.search('title', 100, { includeContent: true, retryContent: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2)
    finishRead(body('current body'))
    await vi.advanceTimersByTimeAsync(30)
    service.dispose()
  })

  it('checks real rollout size before RPC, skips large and unknown inputs, and reports partial coverage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thread-search-guard-'))
    try {
      const smallPath = join(directory, 'small.jsonl')
      const largePath = join(directory, 'large.jsonl')
      await writeFile(smallPath, 'small transcript')
      await writeFile(largePath, 'x'.repeat(1024))
      const rpc = vi.fn(async (method: string) => method === 'thread/list' ? { data: [
        { ...row('large', 'large title', 4), path: largePath },
        { ...row('unknown', 'unknown title', 3), path: null },
        { ...row('missing', 'missing title', 2), path: join(directory, 'absent.jsonl') },
        { ...row('small', 'small title', 1), path: smallPath },
      ] } : body('needle'))
      const service = createThreadSearchService({ rpc, readTitles: async () => ({}), contentRolloutByteLimit: 64 })
      await service.search('needle', 100, { includeContent: true })
      await vi.waitFor(async () => expect((await service.search('needle', 100, { includeContent: true })).contentSearchState).toBe('partial'))
      const result = await service.search('needle', 100, { includeContent: true })
      expect(result).toMatchObject({ threadIds: ['small'], searchedContentCount: 1, skippedContentCount: 3 })
      expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
      service.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces the whole-search byte budget before issuing the next native read', async () => {
    vi.useFakeTimers()
    const inspected = vi.fn(async () => 100)
    const rpc = vi.fn(async (method: string) => method === 'thread/list' ? { data: [row('one', 'title', 3), row('two', 'title', 2), row('three', 'title', 1)] } : body('needle'))
    const service = createThreadSearchService({ rpc, readTitles: async () => ({}), readRolloutFileSize: inspected, contentReadByteBudget: 150 })
    await service.search('needle', 100, { includeContent: true })
    await vi.advanceTimersByTimeAsync(100)
    const result = await service.search('needle', 100, { includeContent: true })
    expect(result).toMatchObject({ contentSearchState: 'partial', searchedContentCount: 1, skippedContentCount: 2 })
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    service.dispose()
  })

  it('keeps the existing user, assistant, and command exact-phrase semantics', () => {
    const value = { thread: { turns: [{ items: [
      { type: 'agentMessage', text: 'Assistant Text' },
      { type: 'userMessage', content: [{ type: 'text', text: 'User Phrase' }, { type: 'image', url: 'not searchable' }] },
      { type: 'commandExecution', command: 'echo test', aggregatedOutput: 'Output Phrase' },
    ] }] } }
    const result = extractSearchableThreadText(value, 1000)
    expect(result.text).toBe('assistant text\nuser phrase\necho test\noutput phrase')
    expect(result.partial).toBe(false)
  })
})
