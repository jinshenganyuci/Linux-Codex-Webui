import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { AppServerJsonlTransportLike } from './appServerJsonlTransport'
import {
  AppServerProcess,
  BackendQueueProcessor,
  createCodexBridgeMiddleware,
  mergeStreamTurnErrorsIntoThreadResult,
  readFullThreadCommandOutput,
} from './codexAppServerBridge'
import {
  THREAD_COMMAND_OUTPUT_MAX_BYTES,
  THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
} from './threadPayloadLimits'

function createInternalReadHarness(
  rpcImplementation: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): { appServer: AppServerProcess; rpc: ReturnType<typeof vi.fn> } {
  let running = true
  const transport: AppServerJsonlTransportLike = {
    get running() {
      return running
    },
    get activeGeneration() {
      return running ? 1 : 0
    },
    start: () => 1,
    writeJson: () => undefined,
    stop: () => {
      running = false
      return 1
    },
  }
  const appServer = new AppServerProcess(null, undefined, () => transport)
  const rpc = vi.fn(rpcImplementation)
  vi.spyOn(appServer, 'rpc').mockImplementation((method, params) => rpc(method, params as Record<string, unknown>))
  ;(appServer as unknown as { ensureAgentModelDetails: () => Promise<boolean> }).ensureAgentModelDetails = vi
    .fn()
    .mockResolvedValue(false)
  return { appServer, rpc }
}

function paginatedThreadSummary(
  threadId: string,
  parentThreadId = '',
  depth = 0,
): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      historyMode: 'paginated',
      status: { type: 'idle' },
      ...(parentThreadId
        ? {
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: parentThreadId,
                  depth,
                  agent_path: `/${threadId}`,
                },
              },
            },
          }
        : {}),
    },
  }
}

function streamErrorHarness(turnId: string, message: string): AppServerProcess {
  return {
    getStreamEvents: vi.fn(() => [{
      method: 'turn/completed',
      params: {
        turn: {
          id: turnId,
          status: 'failed',
          error: { message },
        },
      },
    }]),
  } as unknown as AppServerProcess
}

describe('paginated thread history stream error recovery', () => {
  it('merges buffered errors into thread/turns/list data without changing cursors or untouched turns', () => {
    const failedTurn = { id: 'turn-failed', status: 'completed', items: [] }
    const untouchedTurn = { id: 'turn-ok', status: 'completed', items: [] }
    const source = {
      data: [failedTurn, untouchedTurn],
      nextCursor: 'older-cursor',
      backwardsCursor: 'newer-cursor',
      metadata: { same: true },
    }

    const result = mergeStreamTurnErrorsIntoThreadResult(
      streamErrorHarness('turn-failed', 'native page failed'),
      source,
      'thread/turns/list',
      'thread-1',
    ) as typeof source

    expect(result).not.toBe(source)
    expect(result.data).toHaveLength(2)
    expect(result.data[0]).toMatchObject({
      id: 'turn-failed',
      status: 'failed',
      error: { message: 'native page failed' },
    })
    expect(result.data[1]).toBe(untouchedTurn)
    expect(result.nextCursor).toBe('older-cursor')
    expect(result.backwardsCursor).toBe('newer-cursor')
    expect(result.metadata).toBe(source.metadata)
    expect(failedTurn.status).toBe('completed')
  })

  it('merges buffered errors into thread/resume initialTurnsPage even when legacy turns are empty', () => {
    const initialTurn = { id: 'turn-initial-failed', status: 'inProgress', items: [] }
    const source = {
      thread: { id: 'thread-1', turns: [] },
      initialTurnsPage: {
        data: [initialTurn],
        nextCursor: null,
        backwardsCursor: 'newer-cursor',
      },
    }

    const result = mergeStreamTurnErrorsIntoThreadResult(
      streamErrorHarness('turn-initial-failed', 'initial page failed'),
      source,
      'thread/resume',
    ) as typeof source

    expect(result.thread).toBe(source.thread)
    expect(result.initialTurnsPage.data[0]).toMatchObject({
      id: 'turn-initial-failed',
      status: 'failed',
      error: { message: 'initial page failed' },
    })
    expect(result.initialTurnsPage.nextCursor).toBeNull()
    expect(result.initialTurnsPage.backwardsCursor).toBe('newer-cursor')
    expect(initialTurn.status).toBe('inProgress')
  })

  it('keeps official thread/items/list entries unchanged because live notifications own turn status', () => {
    const source = {
      data: [{
        turnId: 'turn-failed',
        item: { id: 'item-1', type: 'agentMessage', text: 'partial item page' },
      }],
      nextCursor: null,
      backwardsCursor: null,
    }

    const result = mergeStreamTurnErrorsIntoThreadResult(
      streamErrorHarness('turn-failed', 'kept in notification stream'),
      source,
      'thread/items/list',
      'thread-1',
    )

    expect(result).toBe(source)
  })
})

describe('paginated RPC proxy command-output limits', () => {
  it('passes descending page order into the shared 512 KiB command-output budget', async () => {
    const commandEntry = (name: string, fill: string) => ({
      turnId: `turn-${name}`,
      item: {
        id: `command-${name}`,
        type: 'commandExecution',
        aggregatedOutput: `${name}-prefix\n${fill.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 32)}\n${name}-tail`,
      },
    })
    const rpc = vi.fn(async (method: string) => {
      if (method !== 'thread/items/list') throw new Error(`unexpected method ${method}`)
      return {
        data: [
          commandEntry('newest', 'n'),
          commandEntry('middle', 'm'),
          commandEntry('oldest', 'o'),
        ],
        nextCursor: 'older-page',
      }
    })
    const noOp = () => undefined
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    const previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v4-agent-progress',
      appServer: {
        rpc,
        onNotification: () => noOp,
        dispose: noOp,
        disposeWhenIdle: async () => undefined,
      },
      terminalManager: { subscribe: () => noOp, dispose: noOp },
      methodCatalog: {},
      telegramBridge: {
        configureAllowedUserIds: noOp,
        configureToken: noOp,
        start: noOp,
        stop: noOp,
      },
      backendQueueProcessor: { dispose: noOp },
      threadRuntimeState: { dispose: async () => undefined },
    }

    const middleware = createCodexBridgeMiddleware()
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')

      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/items/list',
          params: {
            threadId: 'thread-1',
            cursor: null,
            limit: 3,
            sortDirection: 'desc',
          },
        }),
      })
      const payload = await response.json() as {
        result: { data: Array<{ item: { aggregatedOutput: string } }> }
      }
      const outputs = payload.result.data.map((entry) => entry.item.aggregatedOutput)

      expect(response.status).toBe(200)
      expect(outputs[0]).toContain('newest-tail')
      expect(outputs[1]).toContain('middle-tail')
      expect(outputs[2]).toBe('')
      expect(outputs.reduce((total, output) => total + Buffer.byteLength(output, 'utf8'), 0)).toBe(
        THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
      )
      expect(rpc).toHaveBeenCalledWith('thread/items/list', expect.objectContaining({ sortDirection: 'desc' }))
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      middleware.dispose()
      if (previousSharedBridge === undefined) delete globalScope[sharedBridgeKey]
      else globalScope[sharedBridgeKey] = previousSharedBridge
    }
  })
})

describe('paginated internal agent history reads', () => {
  it('hydrates root, child, and nested progress with bounded native pages and no full thread/read', async () => {
    const turnsByThreadId: Record<string, unknown[]> = {
      root: [{
        id: 'root-turn',
        status: 'inProgress',
        startedAtMs: 1_000,
        items: [{
          id: 'spawn-child',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'child',
          agentPath: '/child',
        }],
      }],
      child: [{
        id: 'child-turn',
        status: 'inProgress',
        startedAtMs: 1_100,
        items: [{
          id: 'spawn-nested',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'nested',
          agentPath: '/child/nested',
        }],
      }],
      nested: [{
        id: 'nested-turn',
        status: 'completed',
        startedAtMs: 1_200,
        completedAtMs: 1_300,
        items: [{ id: 'nested-result', type: 'agentMessage', text: 'nested done' }],
      }],
    }
    const summaries: Record<string, unknown> = {
      root: paginatedThreadSummary('root'),
      child: paginatedThreadSummary('child', 'root', 1),
      nested: paginatedThreadSummary('nested', 'child', 2),
    }
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const { appServer } = createInternalReadHarness(async (method, params) => {
      calls.push({ method, params })
      const threadId = String(params.threadId)
      if (method === 'thread/read' && params.includeTurns === false) return summaries[threadId]
      if (method === 'thread/read' && params.includeTurns === true) {
        throw new Error('paginated recovery must not request full thread history')
      }
      if (method === 'thread/turns/list') return { data: turnsByThreadId[threadId] ?? [], nextCursor: null }
      throw new Error(`unexpected method ${method}`)
    })

    try {
      const snapshot = await (appServer as unknown as {
        hydrateAgentProgressSnapshot: (threadId: string, generation: number) => Promise<unknown>
      }).hydrateAgentProgressSnapshot('root', 1) as {
        agents: Array<{ threadId: string; parentThreadId: string; resultAvailable: boolean }>
      }

      expect(snapshot.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: 'child', parentThreadId: 'root' }),
        expect.objectContaining({ threadId: 'nested', parentThreadId: 'child', resultAvailable: true }),
      ]))
      expect(calls.filter((call) => call.method === 'thread/read')).toHaveLength(3)
      expect(calls.filter((call) => call.method === 'thread/turns/list')).toHaveLength(3)
      expect(calls.some((call) => call.method === 'thread/read' && call.params.includeTurns === true)).toBe(false)
      expect(calls.filter((call) => call.method === 'thread/turns/list').every((call) => (
        call.params.limit === 10
        && call.params.sortDirection === 'desc'
        && call.params.itemsView === 'full'
      ))).toBe(true)
    } finally {
      appServer.dispose()
    }
  })

  it('loads the newest paginated child assistant result from a bounded native item page', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const { appServer } = createInternalReadHarness(async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/read' && params.includeTurns === false) {
        return paginatedThreadSummary('child')
      }
      if (method === 'thread/read' && params.includeTurns === true) {
        throw new Error('paginated result loading must not request full thread history')
      }
      if (method === 'thread/items/list') {
        return {
          data: [
            { turnId: 'turn-new', item: { id: 'new-result', type: 'agentMessage', text: 'newest result' } },
            { turnId: 'turn-old', item: { id: 'old-result', type: 'agentMessage', text: 'older result' } },
          ],
          nextCursor: 'older-items',
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    try {
      await expect(appServer.readAgentResult('child')).resolves.toEqual({
        threadId: 'child',
        text: 'newest result',
        truncated: false,
      })
      expect(calls).toEqual([
        { method: 'thread/read', params: { threadId: 'child', includeTurns: false } },
        {
          method: 'thread/items/list',
          params: {
            threadId: 'child',
            cursor: null,
            limit: 50,
            sortDirection: 'desc',
          },
        },
      ])
    } finally {
      appServer.dispose()
    }
  })

  it('checks a bounded latest paginated turn when summary status is unavailable before draining queue', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const appServer = {
      onNotification: () => () => undefined,
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/read' && params.includeTurns === false) {
          return { thread: { id: 'queued-thread', historyMode: 'paginated' } }
        }
        if (method === 'thread/read' && params.includeTurns === true) {
          throw new Error('paginated queue check must not request full thread history')
        }
        if (method === 'thread/turns/list') {
          return { data: [{ id: 'latest-turn', status: 'completed' }], nextCursor: 'older' }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    const processor = new BackendQueueProcessor(appServer as never)

    try {
      const canStart = await (processor as unknown as {
        canStartQueuedTurn: (threadId: string) => Promise<boolean>
      }).canStartQueuedTurn('queued-thread')
      expect(canStart).toBe(true)
      expect(calls).toEqual([
        { method: 'thread/read', params: { threadId: 'queued-thread', includeTurns: false } },
        {
          method: 'thread/turns/list',
          params: {
            threadId: 'queued-thread',
            cursor: null,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'summary',
          },
        },
      ])
    } finally {
      processor.dispose()
    }
  })

  it('keeps legacy queue checks on full thread/read after safe summary detection', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const appServer = {
      onNotification: () => () => undefined,
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/read' && params.includeTurns === false) {
          return { thread: { id: 'legacy-thread', historyMode: 'legacy' } }
        }
        if (method === 'thread/read' && params.includeTurns === true) {
          return { thread: { id: 'legacy-thread', turns: [{ id: 'turn-1', status: 'inProgress' }] } }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    const processor = new BackendQueueProcessor(appServer as never)

    try {
      const canStart = await (processor as unknown as {
        canStartQueuedTurn: (threadId: string) => Promise<boolean>
      }).canStartQueuedTurn('legacy-thread')
      expect(canStart).toBe(false)
      expect(calls).toEqual([
        { method: 'thread/read', params: { threadId: 'legacy-thread', includeTurns: false } },
        { method: 'thread/read', params: { threadId: 'legacy-thread', includeTurns: true } },
      ])
    } finally {
      processor.dispose()
    }
  })
})

describe('full command output history reads', () => {
  it('returns complete legacy command output without applying the first-paint byte cap', async () => {
    const completeOutput = `old-prefix\n${'x'.repeat(300 * 1024)}\nlatest-output`
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'legacy-thread', historyMode: 'legacy' } }
      }
      if (method === 'thread/read' && params.includeTurns === true) {
        return {
          thread: {
            id: 'legacy-thread',
            turns: [{
              id: 'turn-1',
              items: [{
                id: 'command-1',
                type: 'commandExecution',
                aggregatedOutput: completeOutput,
              }],
            }],
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(readFullThreadCommandOutput(
      { rpc: (method, params) => rpc(method, params as Record<string, unknown>) },
      'legacy-thread',
      'turn-1',
      'command-1',
    )).resolves.toBe(completeOutput)
    expect(calls).toEqual([
      { method: 'thread/read', params: { threadId: 'legacy-thread', includeTurns: false } },
      { method: 'thread/read', params: { threadId: 'legacy-thread', includeTurns: true } },
    ])
  })

  it('follows bounded paginated item cursors and returns the exact command output', async () => {
    const completeOutput = `page-one\n${'p'.repeat(300 * 1024)}\npage-latest`
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'thread/read') return paginatedThreadSummary('paginated-thread')
      if (method === 'thread/items/list' && params.cursor === null) {
        return {
          data: [{
            turnId: 'turn-1',
            item: { id: 'other-command', type: 'commandExecution', aggregatedOutput: 'other' },
          }],
          nextCursor: 'cursor-2',
        }
      }
      if (method === 'thread/items/list' && params.cursor === 'cursor-2') {
        return {
          data: [{
            turnId: 'turn-1',
            item: { id: 'command-1', type: 'commandExecution', aggregatedOutput: completeOutput },
          }],
          nextCursor: null,
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(readFullThreadCommandOutput(
      { rpc: (method, params) => rpc(method, params as Record<string, unknown>) },
      'paginated-thread',
      'turn-1',
      'command-1',
    )).resolves.toBe(completeOutput)
    expect(calls.some((call) => call.method === 'thread/read' && call.params.includeTurns === true)).toBe(false)
    expect(calls.filter((call) => call.method === 'thread/items/list')).toEqual([
      {
        method: 'thread/items/list',
        params: {
          threadId: 'paginated-thread',
          turnId: 'turn-1',
          cursor: null,
          limit: 100,
          sortDirection: 'asc',
        },
      },
      {
        method: 'thread/items/list',
        params: {
          threadId: 'paginated-thread',
          turnId: 'turn-1',
          cursor: 'cursor-2',
          limit: 100,
          sortDirection: 'asc',
        },
      },
    ])
  })

  it('returns not found for a mismatched item or non-command item', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return paginatedThreadSummary('paginated-thread')
      if (method === 'thread/items/list') {
        return {
          data: [{
            turnId: 'turn-1',
            item: { id: 'command-1', type: 'agentMessage', text: 'not command output' },
          }],
          nextCursor: null,
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(readFullThreadCommandOutput(
      { rpc },
      'paginated-thread',
      'turn-1',
      'command-1',
    )).resolves.toBeNull()
  })

  it('stops paginated command lookup after sixteen unique pages', async () => {
    let pageCalls = 0
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return paginatedThreadSummary('paginated-thread')
      if (method === 'thread/items/list') {
        pageCalls += 1
        return { data: [], nextCursor: `cursor-${pageCalls}` }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(readFullThreadCommandOutput(
      { rpc },
      'paginated-thread',
      'turn-1',
      'missing-command',
    )).resolves.toBeNull()
    expect(pageCalls).toBe(16)
  })
})
