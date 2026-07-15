import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppServerJsonlTransportEvent,
  AppServerJsonlTransportFactory,
  AppServerJsonlTransportLike,
} from './appServerJsonlTransport'
import {
  AppServerProcess,
  buildProjectlessFolderName,
  callRpcWithArchiveRecovery,
  canonicalizeThreadListResponseForRead,
  canonicalizeWorkspaceRootsStateForRead,
  hasUsableCodexAuth,
  isEmptyThreadReadError,
  isThreadMaterializationPendingError,
  isThreadNotFoundError,
  isUnauthenticatedRateLimitError,
  startThreadAndTurn,
  writeWorkspaceRootsState,
} from './codexAppServerBridge'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

function createAppServerHarness(initialGeneration = 1): {
  appServer: AppServerProcess
  writes: string[]
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  writeJson: ReturnType<typeof vi.fn>
  emitLine: (message: unknown, generation?: number) => void
  emitExit: (generation?: number) => void
  getActiveGeneration: () => number
} {
  let emit: ((event: AppServerJsonlTransportEvent) => void) | null = null
  let running = true
  let activeGeneration = initialGeneration
  let processGeneration = initialGeneration
  const writes: string[] = []
  const start = vi.fn(() => {
    if (running) return activeGeneration
    running = true
    activeGeneration = ++processGeneration
    return activeGeneration
  })
  const writeJson = vi.fn((payload: Record<string, unknown>, generation = activeGeneration) => {
    if (!running || generation === 0 || generation !== activeGeneration) {
      throw new Error('codex app-server is not running')
    }
    writes.push(`${JSON.stringify(payload)}\n`)
  })
  const stop = vi.fn(() => {
    if (!running) return 0
    const generation = activeGeneration
    running = false
    activeGeneration = 0
    return generation
  })
  const transport: AppServerJsonlTransportLike = {
    get running() {
      return running
    },
    get activeGeneration() {
      return activeGeneration
    },
    start,
    writeJson,
    stop,
  }
  const factory: AppServerJsonlTransportFactory = (listener) => {
    emit = listener
    return transport
  }
  const appServer = new AppServerProcess(null, undefined, factory)
  const emitLine = (message: unknown, generation = activeGeneration) => {
    if (!running || generation === 0 || generation !== activeGeneration) return
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    emit?.({ type: 'line', generation, line })
  }
  const emitExit = (generation = activeGeneration) => {
    if (!running || generation === 0 || generation !== activeGeneration) return
    emit?.({ type: 'exit', generation })
    if (running && activeGeneration === generation) {
      running = false
      activeGeneration = 0
    }
  }
  return {
    appServer,
    writes,
    start,
    stop,
    writeJson,
    emitLine,
    emitExit,
    getActiveGeneration: () => activeGeneration,
  }
}

describe('callRpcWithArchiveRecovery', () => {
  it('sets a fallback name and retries archive when Codex has not materialized a rollout', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let archiveCalls = 0
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/archive') {
          archiveCalls += 1
          if (archiveCalls === 1) {
            throw new Error('no rollout found for thread test-thread')
          }
          return { ok: true }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'test-thread',
              preview: 'Preview title',
              path: '/home/user/.codex/sessions/rollout-test-thread.jsonl',
            },
          }
        }
        return { ok: true }
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'test-thread' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      { method: 'thread/archive', params: { threadId: 'test-thread' } },
      { method: 'thread/read', params: { threadId: 'test-thread', includeTurns: false } },
      { method: 'thread/name/set', params: { threadId: 'test-thread', name: 'Preview title' } },
      { method: 'thread/archive', params: { threadId: 'test-thread' } },
    ])
  })

  it('treats no-rollout archive of an already archived thread as successful', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/archive') {
          throw new Error('no rollout found for thread archived-thread')
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'archived-thread',
              path: '/home/user/.codex/archived_sessions/rollout-archived-thread.jsonl',
            },
          }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'archived-thread' })).resolves.toBeNull()
    expect(calls).toEqual([
      { method: 'thread/archive', params: { threadId: 'archived-thread' } },
      { method: 'thread/read', params: { threadId: 'archived-thread', includeTurns: false } },
    ])
  })

  it('does not recover unrelated RPC failures', async () => {
    const appServer = {
      async rpc(): Promise<unknown> {
        throw new Error('network failed')
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'test-thread' })).rejects.toThrow('network failed')
    await expect(callRpcWithArchiveRecovery(appServer, 'thread/read', { threadId: 'test-thread' })).rejects.toThrow('network failed')
  })

  it('resumes and retries turn/start when a restarted app-server has not materialized the thread', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let startCalls = 0
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'turn/start') {
          startCalls += 1
          if (startCalls === 1) {
            throw new Error('thread not found: test-thread')
          }
          return { turn: { id: 'turn-2' } }
        }
        if (method === 'thread/resume') {
          return { thread: { id: 'test-thread', turns: [] } }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'turn/start', {
      threadId: 'test-thread',
      input: [{ type: 'text', text: 'hi' }],
    })).resolves.toEqual({ turn: { id: 'turn-2' } })
    expect(calls).toEqual([
      {
        method: 'turn/start',
        params: { threadId: 'test-thread', input: [{ type: 'text', text: 'hi' }] },
      },
      { method: 'thread/resume', params: { threadId: 'test-thread' } },
      {
        method: 'turn/start',
        params: { threadId: 'test-thread', input: [{ type: 'text', text: 'hi' }] },
      },
    ])
  })
})

describe('startThreadAndTurn', () => {
  it('creates a thread and starts the first turn on the server side', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return {
            thread: { id: 'thread-atomic' },
            model: 'gpt-5.5',
            modelProvider: 'openai',
          }
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn-atomic' } }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(startThreadAndTurn(appServer, {
      thread: {
        cwd: '/repo',
        model: 'gpt-5.5',
        serviceTier: 'fast',
      },
      turn: {
        input: [{ type: 'text', text: 'hi' }],
        model: 'gpt-5.5',
        serviceTier: 'fast',
        threadId: 'client-supplied-thread-id',
      },
    })).resolves.toEqual({
      thread: { id: 'thread-atomic' },
      model: 'gpt-5.5',
      modelProvider: 'openai',
      turn: { id: 'turn-atomic' },
    })

    expect(calls).toEqual([
      {
        method: 'thread/start',
        params: {
          cwd: '/repo',
          model: 'gpt-5.5',
          serviceTier: 'fast',
        },
      },
      {
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'hi' }],
          model: 'gpt-5.5',
          serviceTier: 'fast',
          threadId: 'thread-atomic',
        },
      },
    ])
  })

  it('deletes an empty thread if the first turn fails to start', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-empty' } }
        }
        if (method === 'turn/start') {
          throw new Error('model is not supported')
        }
        if (method === 'thread/read') {
          return { thread: { id: 'thread-empty', turns: [] } }
        }
        if (method === 'thread/delete') {
          return { ok: true }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(startThreadAndTurn(appServer, {
      thread: {
        cwd: '/repo',
        model: 'gpt-5.5',
      },
      turn: {
        input: [{ type: 'text', text: 'hi' }],
        model: 'gpt-5.5',
      },
    })).rejects.toThrow('model is not supported')

    expect(calls).toEqual([
      {
        method: 'thread/start',
        params: {
          cwd: '/repo',
          model: 'gpt-5.5',
        },
      },
      {
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'hi' }],
          model: 'gpt-5.5',
          threadId: 'thread-empty',
        },
      },
      {
        method: 'thread/read',
        params: {
          threadId: 'thread-empty',
          includeTurns: true,
        },
      },
      {
        method: 'thread/delete',
        params: {
          threadId: 'thread-empty',
        },
      },
    ])
  })

  it('keeps the started thread if turn/start failed after a turn was recorded', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-with-turn' } }
        }
        if (method === 'turn/start') {
          throw new Error('codex app-server exited unexpectedly')
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-with-turn',
              turns: [{ id: 'turn-started', status: 'inProgress' }],
            },
          }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(startThreadAndTurn(appServer, {
      thread: {
        cwd: '/repo',
        model: 'gpt-5.5',
      },
      turn: {
        input: [{ type: 'text', text: 'hi' }],
        model: 'gpt-5.5',
      },
    })).rejects.toThrow('codex app-server exited unexpectedly')

    expect(calls).toEqual([
      {
        method: 'thread/start',
        params: {
          cwd: '/repo',
          model: 'gpt-5.5',
        },
      },
      {
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'hi' }],
          model: 'gpt-5.5',
          threadId: 'thread-with-turn',
        },
      },
      {
        method: 'thread/read',
        params: {
          threadId: 'thread-with-turn',
          includeTurns: true,
        },
      },
    ])
  })
})

describe('AppServerProcess runtime config restart', () => {
  it('defers restarting the app-server until the active turn completes', () => {
    const { appServer, stop } = createAppServerHarness()

    ;(appServer as unknown as { emitNotification: (notification: { method: string; params: unknown }) => void })
      .emitNotification({
        method: 'turn/started',
        params: {
          threadId: 'thread-active',
          turn: { id: 'turn-active' },
        },
      })

    expect(appServer.requestConfigRestartWhenIdle()).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    ;(appServer as unknown as { emitNotification: (notification: { method: string; params: unknown }) => void })
      .emitNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-active',
          turn: { id: 'turn-active' },
        },
      })

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('waits for an active turn before graceful shutdown disposes the app-server', async () => {
    const { appServer, stop } = createAppServerHarness()

    ;(appServer as unknown as { emitNotification: (notification: { method: string; params: unknown }) => void })
      .emitNotification({
        method: 'turn/started',
        params: {
          threadId: 'thread-active',
          turn: { id: 'turn-active' },
        },
      })

    let disposed = false
    const disposePromise = appServer.disposeWhenIdle().then(() => {
      disposed = true
    })
    await Promise.resolve()

    expect(disposed).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    ;(appServer as unknown as { emitNotification: (notification: { method: string; params: unknown }) => void })
      .emitNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-active',
          turn: { id: 'turn-active' },
        },
      })

    await disposePromise

    expect(disposed).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful turn/start busy until the matching turn completes', async () => {
    const { appServer, emitLine, stop } = createAppServerHarness()

    const turnPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('turn/start', {
      threadId: 'thread-active',
      input: [{ type: 'text', text: 'hi' }],
    })
    emitLine({
      jsonrpc: '2.0',
      id: 1,
      result: { turn: { id: 'turn-active' } },
    })

    await expect(turnPromise).resolves.toEqual({ turn: { id: 'turn-active' } })
    expect(appServer.isBusy()).toBe(true)

    let disposed = false
    const disposePromise = appServer.disposeWhenIdle().then(() => {
      disposed = true
    })
    await Promise.resolve()

    expect(disposed).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    ;(appServer as unknown as { emitNotification: (notification: { method: string; params: unknown }) => void })
      .emitNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-active',
          turn: { id: 'turn-active' },
        },
      })

    await disposePromise

    expect(disposed).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('ignores responses from an older app-server generation', async () => {
    const { appServer } = createAppServerHarness(2)

    const callPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('thread/list', {})
    ;(appServer as unknown as { handleLine: (line: string, generation: number) => void })
      .handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { source: 'old' } }), 1)

    const settled = vi.fn()
    void callPromise.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    ;(appServer as unknown as { handleLine: (line: string, generation: number) => void })
      .handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { source: 'current' } }), 2)
    await expect(callPromise).resolves.toEqual({ source: 'current' })
    appServer.dispose()
  })

  it('rejects an approval reply from an older app-server generation', async () => {
    const { appServer, writeJson } = createAppServerHarness(2)
    ;(appServer as unknown as { initialized: boolean }).initialized = true
    ;(appServer as unknown as { handleServerRequest: (generation: number, id: number, method: string, params: unknown) => void })
      .handleServerRequest(2, 7, 'item/commandExecution/requestApproval', { threadId: 'thread-1' })

    await expect(appServer.respondToServerRequest({ id: 7, generation: 1, result: { decision: 'accept' } }))
      .rejects.toThrow('No pending server request')
    expect(writeJson).not.toHaveBeenCalled()
    appServer.dispose()
  })

  it('shares one initialize handshake across concurrent initialization callers', async () => {
    const { appServer, writes, emitLine } = createAppServerHarness()

    const ensureInitialized = (appServer as unknown as {
      ensureInitialized: () => Promise<void>
    }).ensureInitialized.bind(appServer)
    const first = ensureInitialized()
    const second = ensureInitialized()

    expect(writes).toEqual([`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'linux-codex-webui', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })}\n`])

    emitLine({ jsonrpc: '2.0', id: 1, result: {} })
    await Promise.all([first, second])

    expect(writes).toEqual([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'linux-codex-webui', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`,
    ])
    expect((appServer as unknown as { initialized: boolean }).initialized).toBe(true)
    appServer.dispose()
  })

  it('defers a config restart for an ordinary pending RPC and disposes after its response', async () => {
    const { appServer, emitLine, stop } = createAppServerHarness()

    const callPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('thread/list', { limit: 20 })

    expect(appServer.requestConfigRestartWhenIdle()).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    emitLine({ jsonrpc: '2.0', id: 1, result: { data: [] } })

    await expect(callPromise).resolves.toEqual({ data: [] })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('keeps a manual server request busy until its reply is written', async () => {
    const { appServer, writes, stop } = createAppServerHarness()
    ;(appServer as unknown as { initialized: boolean }).initialized = true
    ;(appServer as unknown as {
      handleServerRequest: (generation: number, id: number, method: string, params: unknown) => void
    }).handleServerRequest(1, 7, 'item/commandExecution/requestApproval', { threadId: 'thread-1' })

    expect(appServer.requestConfigRestartWhenIdle()).toBe(false)
    await appServer.respondToServerRequest({ id: 7, generation: 1, result: { decision: 'accept' } })

    expect(writes).toContain(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      result: { decision: 'accept' },
    })}\n`)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('rejects pending RPCs as stopped and ignores their late responses after explicit disposal', async () => {
    const { appServer, stop } = createAppServerHarness()

    const callPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('thread/list', {})
    appServer.dispose()

    await expect(callPromise).rejects.toThrow('codex app-server stopped')
    ;(appServer as unknown as { handleLine: (line: string, generation: number) => void })
      .handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { source: 'late' } }), 1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(appServer.isBusy()).toBe(false)
  })

  it('rejects pending work, invalidates server requests, and reinitializes after an unexpected exit', async () => {
    const { appServer, writes, start, emitLine, emitExit, getActiveGeneration } = createAppServerHarness()
    const notifications: Array<{ method: string; params: unknown }> = []
    appServer.onNotification((notification) => notifications.push(notification))
    const callPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('thread/list', {})
    ;(appServer as unknown as {
      handleServerRequest: (generation: number, id: number, method: string, params: unknown) => void
    }).handleServerRequest(1, 7, 'item/commandExecution/requestApproval', { threadId: 'thread-1' })

    emitExit()

    await expect(callPromise).rejects.toThrow('codex app-server exited unexpectedly')
    expect(appServer.listPendingServerRequests()).toEqual([])
    expect(appServer.isBusy()).toBe(false)
    expect(notifications).toContainEqual({
      method: 'server/requests/invalidated',
      params: {
        generation: 1,
        requestIds: [7],
        reason: 'codex app-server exited unexpectedly',
      },
      generation: 1,
    })

    const ensureInitialized = (appServer as unknown as {
      ensureInitialized: () => Promise<void>
    }).ensureInitialized.bind(appServer)
    const initializePromise = ensureInitialized()
    expect(start).toHaveBeenCalledTimes(1)
    expect(getActiveGeneration()).toBe(2)
    expect(writes.at(-1)).toBe(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        clientInfo: { name: 'linux-codex-webui', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })}\n`)
    emitLine({ jsonrpc: '2.0', id: 2, result: {} }, 2)
    await initializePromise
    expect(writes.at(-1)).toBe(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
    appServer.dispose()
  })

  it('resolves every idle waiter once after the last pending RPC settles', async () => {
    const { appServer, emitLine } = createAppServerHarness()
    const callPromise = (appServer as unknown as {
      call: (method: string, params: unknown) => Promise<unknown>
    }).call('thread/list', {})
    const firstIdle = vi.fn()
    const secondIdle = vi.fn()
    const firstWait = appServer.waitUntilIdle().then(firstIdle)
    const secondWait = appServer.waitUntilIdle().then(secondIdle)

    await Promise.resolve()
    expect(firstIdle).not.toHaveBeenCalled()
    expect(secondIdle).not.toHaveBeenCalled()

    emitLine({ jsonrpc: '2.0', id: 1, result: { data: [] } })
    await expect(callPromise).resolves.toEqual({ data: [] })
    await Promise.all([firstWait, secondWait])
    expect(firstIdle).toHaveBeenCalledTimes(1)
    expect(secondIdle).toHaveBeenCalledTimes(1)
    appServer.dispose()
  })
})

describe('buildProjectlessFolderName', () => {
  it('falls back to unique suffixes after the readable collision range', () => {
    expect(buildProjectlessFolderName('hi', 0, 'ignored')).toBe('hi')
    expect(buildProjectlessFolderName('hi', 1, 'ignored')).toBe('hi-2')
    expect(buildProjectlessFolderName('hi', 19, 'ignored')).toBe('hi-20')
    expect(buildProjectlessFolderName('hi', 20, 'mabc1234-deadbeef')).toBe('hi-mabc1234-deadbeef')
  })

  it('keeps long unique fallback names within the slug length limit', () => {
    const slug = 'a'.repeat(80)
    const folderName = buildProjectlessFolderName(slug, 20, 'mabc1234-deadbeef')
    expect(folderName).toHaveLength(80)
    expect(folderName).toMatch(/-mabc1234-deadbeef$/)
  })
})

describe('canonicalizeWorkspaceRootsStateForRead', () => {
  it('realpaths existing local roots so symlink cwd sessions remain visible', async () => {
    const state = await canonicalizeWorkspaceRootsStateForRead({
      order: ['/workspace-link/projects/demo', 'remote-project-id'],
      labels: {
        '/storage/projects/demo': 'Canonical Demo',
        '/workspace-link/projects/demo': 'Symlink Demo',
        'remote-project-id': 'Remote Demo',
      },
      active: ['/workspace-link/projects/demo'],
      projectOrder: ['remote-project-id', '/workspace-link/projects/demo'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:host',
        remotePath: '/remote/projects/demo',
        label: 'remote-demo',
      }],
    }, async (value) => value.replace('/workspace-link/', '/storage/'))

    expect(state.order).toEqual([
      '/storage/projects/demo',
      'remote-project-id',
    ])
    expect(state.active).toEqual(['/storage/projects/demo'])
    expect(state.projectOrder).toEqual([
      'remote-project-id',
      '/storage/projects/demo',
    ])
    expect(state.labels).toEqual({
      '/storage/projects/demo': 'Canonical Demo',
      'remote-project-id': 'Remote Demo',
    })
    expect(state.remoteProjects[0]?.id).toBe('remote-project-id')
  })
})

describe('writeWorkspaceRootsState', () => {
  it('persists workspace roots in canonical form', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-workspace-roots-'))
    const canonicalRoot = join(codexHome, 'storage', 'projects', 'demo')
    const symlinkParent = join(codexHome, 'workspace-link', 'projects')
    const symlinkRoot = join(symlinkParent, 'demo')
    process.env.CODEX_HOME = codexHome

    try {
      await mkdir(canonicalRoot, { recursive: true })
      await mkdir(symlinkParent, { recursive: true })
      await symlink(canonicalRoot, symlinkRoot)
      await writeWorkspaceRootsState({
        order: [symlinkRoot, 'remote-project-id', canonicalRoot],
        labels: {
          [canonicalRoot]: 'Canonical Demo',
          [symlinkRoot]: 'Symlink Demo',
          'remote-project-id': 'Remote Demo',
        },
        active: [symlinkRoot, canonicalRoot],
        projectOrder: ['remote-project-id', symlinkRoot, canonicalRoot],
        remoteProjects: [{
          id: 'remote-project-id',
          hostId: 'remote-ssh-discovered:host',
          remotePath: '/remote/projects/demo',
          label: 'remote-demo',
        }],
      })

      const rawState = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>
      expect(rawState['electron-saved-workspace-roots']).toEqual([
        canonicalRoot,
        'remote-project-id',
      ])
      expect(rawState['active-workspace-roots']).toEqual([canonicalRoot])
      expect(rawState['project-order']).toEqual([
        'remote-project-id',
        canonicalRoot,
      ])
      expect(rawState['electron-workspace-root-labels']).toEqual({
        [canonicalRoot]: 'Canonical Demo',
        'remote-project-id': 'Remote Demo',
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('canonicalizeThreadListResponseForRead', () => {
  it('realpaths thread cwd values to match canonicalized workspace roots', async () => {
    const payload = await canonicalizeThreadListResponseForRead({
      data: [
        { id: 'symlink-cwd-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    }, async (value) => value.replace('/workspace-link/', '/storage/'))

    expect(payload).toEqual({
      data: [
        { id: 'symlink-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    })
  })

  it('reuses cwd realpath results within one thread list response', async () => {
    const calls: string[] = []
    const payload = await canonicalizeThreadListResponseForRead({
      data: [
        { id: 'first-symlink-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'second-symlink-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    }, async (value) => {
      calls.push(value)
      return value.replace('/workspace-link/', '/storage/')
    })

    expect(payload).toEqual({
      data: [
        { id: 'first-symlink-thread', cwd: '/storage/projects/demo' },
        { id: 'second-symlink-thread', cwd: '/storage/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    })
    expect(calls).toEqual([
      '/workspace-link/projects/demo',
      '/storage/projects/demo',
    ])
  })
})

describe('isUnauthenticatedRateLimitError', () => {
  it('matches unauthenticated rate-limit failures from a fresh Codex home', () => {
    expect(isUnauthenticatedRateLimitError(new Error('codex account authentication required to read rate limits'))).toBe(true)
  })

  it('matches direct message fields from Codex stream errors', () => {
    expect(isUnauthenticatedRateLimitError({
      message: 'codex account authentication required to read rate limits',
      codexErrorInfo: 'other',
      additionalDetails: null,
    })).toBe(true)
  })

  it('does not match unrelated authentication failures', () => {
    expect(isUnauthenticatedRateLimitError(new Error('codex account authentication required to send messages'))).toBe(false)
    expect(isUnauthenticatedRateLimitError(new Error('failed to read rate limits'))).toBe(false)
  })
})

describe('isEmptyThreadReadError', () => {
  it('matches Codex empty rollout read failures during immediate thread startup', () => {
    expect(isEmptyThreadReadError(new Error(
      'failed to read thread: thread-store internal error: failed to read thread /tmp/codex-home/sessions/rollout-test.jsonl: rollout at /tmp/codex-home/sessions/rollout-test.jsonl is empty',
    ))).toBe(true)
  })

  it('does not match unrelated thread read failures', () => {
    expect(isEmptyThreadReadError(new Error('failed to read thread: permission denied'))).toBe(false)
    expect(isEmptyThreadReadError(new Error('rollout is empty'))).toBe(false)
  })
})

describe('isThreadMaterializationPendingError', () => {
  it('matches Codex live-state reads before the first message is materialized', () => {
    expect(isThreadMaterializationPendingError(new Error(
      'thread 019e1f04-dca4-7823-8b9a-554b9bd22f57 is not materialized yet; includeTurns is unavailable before first user message',
    ))).toBe(true)
  })

  it('does not match unrelated thread read failures', () => {
    expect(isThreadMaterializationPendingError(new Error('thread read failed: permission denied'))).toBe(false)
    expect(isThreadMaterializationPendingError(new Error('not materialized yet'))).toBe(false)
  })
})

describe('isThreadNotFoundError', () => {
  it('matches app-server thread lookup failures after restart', () => {
    expect(isThreadNotFoundError(new Error('thread not found: 019e2180-6ad7'))).toBe(true)
    expect(isThreadNotFoundError(new Error('no rollout found for thread id 019e2180-6ad7'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isThreadNotFoundError(new Error('network failed'))).toBe(false)
    expect(isThreadNotFoundError(new Error('thread read failed: permission denied'))).toBe(false)
  })
})

describe('hasUsableCodexAuth', () => {
  it('returns false when auth.json is missing or does not contain usable tokens', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-no-token-'))
    process.env.CODEX_HOME = codexHome
    try {
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: {} }))
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('returns true when auth.json contains an access token or refresh token', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-with-token-'))
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))
      await expect(hasUsableCodexAuth()).resolves.toBe(true)
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'refresh-token' } }))
      await expect(hasUsableCodexAuth()).resolves.toBe(true)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('warns when auth.json exists but cannot be parsed', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-invalid-auth-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), '{')
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
      expect(warn).toHaveBeenCalledWith(
        '[codex-auth] Unable to read Codex auth state',
        expect.objectContaining({ path: join(codexHome, 'auth.json') }),
      )
    } finally {
      warn.mockRestore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
