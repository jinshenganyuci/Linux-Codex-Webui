import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getArchivedThreadsPage,
  getOlderThreadHistoryPage,
  getThreadHistoryDetail,
  getThreadTurnItemsPage,
  listThreadItems,
} from './codexGateway'

type RpcRequest = { method: string; params: Record<string, unknown> }

function readRpcRequest(init?: RequestInit): RpcRequest {
  return typeof init?.body === 'string'
    ? JSON.parse(init.body) as RpcRequest
    : { method: '', params: {} }
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function userItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: 'userMessage',
    content: [{ type: 'text', text, text_elements: [] }],
  }
}

function turn(
  id: string,
  text: string | null,
  options: { status?: string; itemsView?: string; itemId?: string; duplicateItem?: boolean } = {},
): Record<string, unknown> {
  const item = text === null ? null : userItem(options.itemId ?? `item-${id}`, text)
  return {
    id,
    status: options.status ?? 'completed',
    error: null,
    itemsView: options.itemsView ?? 'full',
    items: item ? options.duplicateItem ? [item, item] : [item] : [],
  }
}

function threadRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thread-1',
    preview: 'preview',
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/tmp/project',
    turns: [],
    ...overrides,
  }
}

describe('native thread history gateway', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('normalizes only the explicit paginated history mode and falls back to legacy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({
      data: [
        threadRecord({ id: 'paginated', historyMode: 'paginated' }),
        threadRecord({ id: 'missing' }),
        threadRecord({ id: 'unknown', historyMode: 'future-mode' }),
      ],
      nextCursor: null,
    })))

    const page = await getArchivedThreadsPage()
    expect(Object.fromEntries(page.threads.map((thread) => [thread.id, thread.historyMode]))).toEqual({
      paginated: 'paginated',
      missing: 'legacy',
      unknown: 'legacy',
    })
  })

  it('keeps legacy history on read-only thread/read and exposes chronological turn ids', async () => {
    const requests: RpcRequest[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = readRpcRequest(init)
      requests.push(request)
      return rpcResponse({
        thread: threadRecord({
          modelProvider: 'myproxy',
          turns: [turn('turn-empty', null), turn('turn-visible', 'legacy message')],
        }),
        threadTurnStartIndex: 4,
      })
    }))

    const detail = await getThreadHistoryDetail('legacy-thread', 'legacy')

    expect(requests).toEqual([{
      method: 'thread/read',
      params: { threadId: 'legacy-thread', includeTurns: true },
    }])
    expect(detail).toMatchObject({
      historyMode: 'legacy',
      modelProvider: 'myproxy',
      turnIds: ['turn-empty', 'turn-visible'],
      olderCursor: 'turn-empty',
      hasMoreOlder: true,
      startTurnIndex: 4,
      turnIndexByTurnId: { 'turn-empty': 4, 'turn-visible': 5 },
      resumed: false,
      materialized: false,
    })
    expect(detail.messages[0]).toMatchObject({ turnId: 'turn-visible', turnIndex: 5 })
  })

  it('coalesces paginated resumes, uses the exact bootstrap request, and restores chronological order', async () => {
    const requests: RpcRequest[] = []
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(readRpcRequest(init))
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    }))

    const first = getThreadHistoryDetail('paginated-bootstrap', 'paginated')
    const second = getThreadHistoryDetail('paginated-bootstrap', 'paginated')
    expect(requests).toEqual([{
      method: 'thread/resume',
      params: {
        threadId: 'paginated-bootstrap',
        excludeTurns: true,
        initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
      },
    }])

    resolveResponse(rpcResponse({
      model: 'gpt-5.6',
      modelProvider: 'openai',
      thread: threadRecord({ id: 'paginated-bootstrap', historyMode: 'paginated' }),
      initialTurnsPage: {
        data: [
          turn('turn-new', 'new', { itemId: 'shared-item' }),
          turn('turn-old', 'summary should be replaced', { itemsView: 'summary' }),
          turn('turn-old', 'old full', { itemsView: 'full', itemId: 'shared-item', duplicateItem: true }),
        ],
        nextCursor: 'older-cursor-1',
      },
    }))

    const [firstDetail, secondDetail] = await Promise.all([first, second])
    expect(secondDetail).toEqual(firstDetail)
    expect(firstDetail).toMatchObject({
      historyMode: 'paginated',
      model: 'gpt-5.6',
      modelProvider: 'openai',
      turnIds: ['turn-old', 'turn-new'],
      olderCursor: 'older-cursor-1',
      hasMoreOlder: true,
      turnIndexByTurnId: {},
      resumed: true,
      materialized: true,
    })
    expect(firstDetail.messages.map((message) => ({
      id: message.id,
      text: message.text,
      turnId: message.turnId,
      turnIndex: message.turnIndex,
    }))).toEqual([
      { id: 'shared-item', text: 'old full', turnId: 'turn-old', turnIndex: undefined },
      { id: 'shared-item', text: 'new', turnId: 'turn-new', turnIndex: undefined },
    ])
  })

  it('keeps a pending paginated resume coalesced past 31 seconds and evicts it only after settle', async () => {
    vi.useFakeTimers()
    const requests: RpcRequest[] = []
    const responders: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(readRpcRequest(init))
      return new Promise<Response>((resolve) => {
        responders.push(resolve)
      })
    }))

    const first = getThreadHistoryDetail('slow-paginated-resume', 'paginated')
    await vi.advanceTimersByTimeAsync(31_000)
    const coalesced = getThreadHistoryDetail('slow-paginated-resume', 'paginated')

    expect(requests).toHaveLength(1)
    responders[0]?.(rpcResponse({
      model: 'gpt-5.6',
      modelProvider: 'openai',
      thread: threadRecord({ id: 'slow-paginated-resume', historyMode: 'paginated' }),
      initialTurnsPage: { data: [], nextCursor: null },
    }))
    await Promise.all([first, coalesced])

    const afterSettle = getThreadHistoryDetail('slow-paginated-resume', 'paginated')
    expect(requests).toHaveLength(2)
    responders[1]?.(rpcResponse({
      model: 'gpt-5.6',
      modelProvider: 'openai',
      thread: threadRecord({ id: 'slow-paginated-resume', historyMode: 'paginated' }),
      initialTurnsPage: { data: [], nextCursor: null },
    }))
    await afterSettle
  })

  it('falls back once to the documented backwards turn cursor when the bootstrap page is absent', async () => {
    const requests: RpcRequest[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = readRpcRequest(init)
      requests.push(request)
      if (request.method === 'thread/resume') {
        return rpcResponse({
          model: 'gpt-5.6',
          modelProvider: 'openai',
          thread: threadRecord({ id: 'paginated-fallback', historyMode: 'paginated' }),
          turnsBackwardsCursor: 'head-turn-cursor',
        })
      }
      return rpcResponse({
        data: [turn('turn-2', 'second'), turn('turn-1', 'first')],
        nextCursor: null,
      })
    }))

    const detail = await getThreadHistoryDetail('paginated-fallback', 'paginated')

    expect(requests[1]).toEqual({
      method: 'thread/turns/list',
      params: {
        threadId: 'paginated-fallback',
        cursor: 'head-turn-cursor',
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    })
    expect(detail.turnIds).toEqual(['turn-1', 'turn-2'])
    expect(detail.hasMoreOlder).toBe(false)
  })

  it('coalesces the fallback turn page until the complete paginated bootstrap settles', async () => {
    const requests: RpcRequest[] = []
    let resolveFallback!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = readRpcRequest(init)
      requests.push(request)
      if (request.method === 'thread/resume') {
        return rpcResponse({
          thread: threadRecord({ id: 'paginated-fallback-coalesced', historyMode: 'paginated' }),
          turnsBackwardsCursor: 'shared-head-cursor',
        })
      }
      return await new Promise<Response>((resolve) => {
        resolveFallback = resolve
      })
    }))

    const first = getThreadHistoryDetail('paginated-fallback-coalesced', 'paginated')
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    const second = getThreadHistoryDetail('paginated-fallback-coalesced', 'paginated')

    expect(requests.map((request) => request.method)).toEqual(['thread/resume', 'thread/turns/list'])
    resolveFallback(rpcResponse({ data: [turn('turn-latest', 'complete')], nextCursor: null }))
    const [firstDetail, secondDetail] = await Promise.all([first, second])

    expect(secondDetail).toEqual(firstDetail)
    expect(requests.map((request) => request.method)).toEqual(['thread/resume', 'thread/turns/list'])
  })

  it('loads cursor-based older pages in descending/full mode and coalesces the same request', async () => {
    const requests: RpcRequest[] = []
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(readRpcRequest(init))
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    }))

    const options = { historyMode: 'paginated' as const, cursor: 'opaque-1', limit: 12 }
    const first = getOlderThreadHistoryPage('paginated-older', options)
    const second = getOlderThreadHistoryPage('paginated-older', options)
    expect(requests).toEqual([{
      method: 'thread/turns/list',
      params: {
        threadId: 'paginated-older',
        cursor: 'opaque-1',
        limit: 12,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    }])

    resolveResponse(rpcResponse({
      data: [turn('turn-4', 'fourth'), turn('turn-3', null)],
      nextCursor: 'opaque-2',
    }))
    const [page, duplicatePage] = await Promise.all([first, second])

    expect(duplicatePage).toEqual(page)
    expect(page).toMatchObject({
      historyMode: 'paginated',
      turnIds: ['turn-3', 'turn-4'],
      olderCursor: 'opaque-2',
      hasMoreOlder: true,
      turnIndexByTurnId: {},
    })
    expect(page.messages[0]).toMatchObject({ turnId: 'turn-4' })
    expect(page.messages[0]?.turnIndex).toBeUndefined()
  })

  it('reuses the legacy older-turn endpoint and accepts the unified cursor as its turn anchor', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({
        result: {
          thread: threadRecord({ turns: [turn('legacy-older-1', 'older legacy')] }),
        },
        hasMoreOlder: false,
        startTurnIndex: 2,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const page = await getOlderThreadHistoryPage('legacy-older', {
      historyMode: 'legacy',
      cursor: 'legacy-before-turn',
      limit: 9,
    })

    expect(urls).toEqual(['/codex-api/thread-turn-page?threadId=legacy-older&beforeTurnId=legacy-before-turn&limit=9'])
    expect(page).toMatchObject({
      historyMode: 'legacy',
      turnIds: ['legacy-older-1'],
      startTurnIndex: 2,
      turnIndexByTurnId: { 'legacy-older-1': 2 },
    })
  })

  it('loads one turn item page in ascending order, preserves turn identity, and coalesces it', async () => {
    const requests: RpcRequest[] = []
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(readRpcRequest(init))
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    }))

    const first = getThreadTurnItemsPage('thread-items', 'turn-a', 'item-cursor-1')
    const second = getThreadTurnItemsPage('thread-items', 'turn-a', 'item-cursor-1')
    expect(requests).toEqual([{
      method: 'thread/items/list',
      params: {
        threadId: 'thread-items',
        turnId: 'turn-a',
        cursor: 'item-cursor-1',
        limit: 100,
        sortDirection: 'asc',
      },
    }])

    resolveResponse(rpcResponse({
      data: [
        { turnId: 'turn-a', item: userItem('same-id', 'first') },
        { turnId: 'turn-a', item: userItem('same-id', 'duplicate') },
        { turnId: 'turn-b', item: userItem('same-id', 'same id, other turn') },
      ],
      nextCursor: 'item-cursor-2',
    }))
    const [page, duplicatePage] = await Promise.all([first, second])

    expect(duplicatePage).toEqual(page)
    expect(page).not.toBeNull()
    if (!page) throw new Error('expected a supported item page')
    expect(page.nextCursor).toBe('item-cursor-2')
    expect(page.messages.map((message) => ({
      id: message.id,
      text: message.text,
      turnId: message.turnId,
      turnIndex: message.turnIndex,
    }))).toEqual([
      { id: 'same-id', text: 'duplicate', turnId: 'turn-a', turnIndex: undefined },
      { id: 'same-id', text: 'same id, other turn', turnId: 'turn-b', turnIndex: undefined },
    ])
  })

  it('treats an unknown detail mode as legacy at runtime', async () => {
    const requests: RpcRequest[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(readRpcRequest(init))
      return rpcResponse({ thread: threadRecord() })
    }))

    const detail = await getThreadHistoryDetail('unknown-mode-thread', 'future' as never)
    expect(detail.historyMode).toBe('legacy')
    expect(requests[0]?.method).toBe('thread/read')
  })

  it('does not permanently cache transient item-list failures as unsupported', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: 'temporary upstream gateway failure' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return rpcResponse({ data: [], nextCursor: null, backwardsCursor: null })
    }))

    await expect(listThreadItems('transient-items-thread', { turnId: 'turn-1' })).rejects.toThrow('temporary upstream gateway failure')
    await expect(listThreadItems('transient-items-thread', { turnId: 'turn-1' })).resolves.toEqual({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    })
    expect(requestCount).toBe(2)
  })

  it('keeps a supported empty item page distinct from an unsupported method', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({
      data: [],
      nextCursor: null,
      backwardsCursor: 'empty-page-anchor',
    })))

    await expect(getThreadTurnItemsPage('empty-items-thread', 'turn-empty')).resolves.toEqual({
      messages: [],
      nextCursor: null,
    })
  })

  it('returns null and caches only an explicit method-not-found item response', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount += 1
      return new Response(JSON.stringify({
        error: { code: -32601, message: 'Method not found: thread/items/list' },
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadTurnItemsPage('unsupported-items-thread', 'turn-1')).resolves.toBeNull()
    await expect(getThreadTurnItemsPage('unsupported-items-thread', 'turn-1')).resolves.toBeNull()
    expect(requestCount).toBe(1)
  })
})
