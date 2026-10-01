import { afterEach, describe, expect, it, vi } from 'vitest'
import { forkThread, getThreadHistoryMutationCapabilities, revertThread } from './codexGateway'

function response(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200 })
}

describe('native history mutations', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['legacy', 'paginated'])('forks %s through the canonical turn in one bounded request', async (historyMode) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      thread: { id: 'fork-1', cwd: '/tmp/project', historyMode, turns: [] },
      model: 'test-model', modelProvider: 'test-provider',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const fork = await forkThread('source', undefined, undefined, { lastTurnId: 'turn-1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      method: 'thread/fork',
      params: { threadId: 'source', lastTurnId: 'turn-1', excludeTurns: true, persistExtendedHistory: true },
    })
    expect(fork).toMatchObject({ threadId: 'fork-1', historyMode, messages: [], modelProvider: 'test-provider' })
  })

  it('edits a legacy thread by forking before the target without touching the source history', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return response({ thread: { id: 'edit-fork', historyMode: 'legacy' } })
    }))
    await forkThread('source', '/tmp/workspace', 'test-model', { beforeTurnId: 'turn-2' })
    expect(requests).toEqual([{
      method: 'thread/fork', params: {
        threadId: 'source', beforeTurnId: 'turn-2', cwd: '/tmp/workspace', model: 'test-model',
        excludeTurns: true, persistExtendedHistory: true,
      },
    }])
  })

  it('reads capability changes without retaining an old runtime catalog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: ['thread/rollback', 'thread/revert', 'thread/fork'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: ['thread/revert', 'thread/fork'] })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getThreadHistoryMutationCapabilities()).resolves.toEqual({ rollback: true, revert: true, fork: true })
    await expect(getThreadHistoryMutationCapabilities()).resolves.toEqual({ rollback: false, revert: true, fork: true })
  })

  it('reverts paginated history by ID and leaves page reloading to the state owner', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return response({ thread: { id: 'paginated', turns: [] } })
    }))
    await revertThread('paginated', 'turn-2')
    expect(requests).toEqual([{ method: 'thread/revert', params: { threadId: 'paginated', beforeTurnId: 'turn-2' } }])
  })
})
