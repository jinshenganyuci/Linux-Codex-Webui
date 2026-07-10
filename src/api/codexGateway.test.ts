import { afterEach, describe, expect, it, vi } from 'vitest'
import { getArchivedThreadsPage, getAvailableModelIds, getAvailableModels, getThreadDetail, getThreadModelPreferences, listDirectoryComposioConnectors, permanentlyDeleteThread, persistThreadModelPreference, resumeThread, startThread, startThreadTurn, startThreadWithTurn, unarchiveThread } from './codexGateway'

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: body.method === 'thread/start'
        ? {
            thread: {
              id: `thread-${requests.length}`,
            },
          }
        : {
            turn: {
              id: `turn-${requests.length}`,
            },
          },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })

  it('sends service tiers explicitly on thread and turn start', async () => {
    const { requests } = mockRpcFetch()

    await startThread('/repo', 'gpt-5.5', 'fast')
    await startThreadTurn('thread-1', 'fast turn', [], 'gpt-5.5', 'medium', undefined, [], 'default', 'fast')
    await startThreadTurn('thread-1', 'standard turn', [], 'gpt-5.5', 'medium', undefined, [], 'default', null)

    expect(requests).toHaveLength(3)
    expect(requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/repo',
        model: 'gpt-5.5',
        serviceTier: 'fast',
      },
    })
    expect(requests[1].params.serviceTier).toBe('fast')
    expect(requests[2].params.serviceTier).toBeNull()
  })

  it('passes max and ultra reasoning efforts through unchanged', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'hard task', [], 'gpt-5.6-sol', 'max', undefined, [], 'default')
    await startThreadTurn('thread-1', 'delegate task', [], 'gpt-5.6-sol', 'ultra', undefined, [], 'default')

    expect(requests.map((request) => request.params.collaborationMode)).toEqual([
      {
        mode: 'default',
        settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: 'max',
          developer_instructions: null,
        },
      },
      {
        mode: 'default',
        settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: 'ultra',
          developer_instructions: null,
        },
      },
    ])
  })

  it('starts a new thread and first turn through one backend request', async () => {
    const requests: Array<{ url: string, body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
      })
      return new Response(JSON.stringify({
        data: {
          thread: { id: 'thread-atomic' },
          model: 'gpt-5.5',
          modelProvider: 'openai',
          turn: { id: 'turn-atomic' },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const started = await startThreadWithTurn('/repo', 'hello', [], 'gpt-5.5', 'medium', undefined, [], 'default', 'fast')

    expect(started).toEqual({
      threadId: 'thread-atomic',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      turnId: 'turn-atomic',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/codex-api/thread/start-turn')
    expect(requests[0].body).toMatchObject({
      thread: {
        cwd: '/repo',
        model: 'gpt-5.5',
        serviceTier: 'fast',
      },
      turn: {
        model: 'gpt-5.5',
        effort: 'medium',
        serviceTier: 'fast',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.5',
            reasoning_effort: 'medium',
            developer_instructions: null,
          },
        },
      },
    })
  })
})

describe('thread model preferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads normalized per-thread preferences from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        'thread-a': { model: 'gpt-5.5', reasoningEffort: 'high' },
        'thread-b': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
        broken: { model: '', reasoningEffort: 'impossible' },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadModelPreferences()).resolves.toEqual({
      'thread-a': { model: 'gpt-5.5', reasoningEffort: 'high' },
      'thread-b': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    })
  })

  it('persists a complete model and reasoning preference', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({
        data: { threadId: 'thread-a', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(persistThreadModelPreference('thread-a', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    })).resolves.toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/codex-api/thread-model-preferences')
    expect(requests[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      threadId: 'thread-a',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    })
  })

  it('rejects unsuccessful preference writes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'disk full' }), {
      status: 507,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(persistThreadModelPreference('thread-a', {
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    })).rejects.toThrow('disk full')
  })
})

describe('archived thread management', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists archived threads and uses the official restore and delete methods', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)

      const result = body.method === 'thread/list'
        ? {
            data: [{
              id: 'archived-thread',
              preview: 'Archived conversation',
              modelProvider: 'openai',
              createdAt: 1_783_650_000,
              updatedAt: 1_783_651_000,
              path: '/root/.codex/archived_sessions/archived-thread.jsonl',
              cwd: '/tmp/archive-project',
              cliVersion: '0.144.0',
              source: 'vscode',
              gitInfo: null,
              turns: [],
            }],
            nextCursor: 'next-page',
          }
        : {}
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const page = await getArchivedThreadsPage('cursor-1', 25)
    await unarchiveThread('archived-thread')
    await permanentlyDeleteThread('archived-thread')

    expect(page).toMatchObject({
      threads: [{ id: 'archived-thread', title: 'Archived conversation', projectName: 'archive-project' }],
      nextCursor: 'next-page',
    })
    expect(requests).toEqual([
      {
        method: 'thread/list',
        params: {
          archived: true,
          limit: 25,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: 'cursor-1',
        },
      },
      { method: 'thread/unarchive', params: { threadId: 'archived-thread' } },
      { method: 'thread/delete', params: { threadId: 'archived-thread' } },
    ])
  })
})

describe('listDirectoryComposioConnectors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends search queries as query params expected by the server', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: [],
        nextCursor: null,
        total: 0,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    await listDirectoryComposioConnectors('instagram', '50', 25)

    expect(requests).toEqual(['/codex-api/composio/connectors?query=instagram&cursor=50&limit=25'])
  })
})

describe('getAvailableModelIds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('restricts required provider models while enriching matching Codex capabilities', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({
          data: ['gpt-5.6-sol', 'provider-custom'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string }
        : { method: '' }
      expect(body.method).toBe('model/list')
      return new Response(JSON.stringify({
        result: {
          data: [
            {
              id: 'gpt-5.6-sol',
              displayName: 'GPT-5.6-Sol',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'ultra' },
              ],
              defaultReasoningEffort: 'low',
            },
            { id: 'codex-only' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getAvailableModels({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        supportedReasoningEfforts: ['low', 'ultra'],
        defaultReasoningEffort: 'low',
      },
      {
        id: 'provider-custom',
        displayName: 'provider-custom',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
    ])
    expect(requests).toEqual(['/codex-api/provider-models', '/codex-api/rpc'])
  })

  it('keeps explicit provider models when capability lookup fails', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models?provider=opencode-zen') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'ring-2.6-1t-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })).resolves.toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(requests).toEqual(['/codex-api/provider-models?provider=opencode-zen', '/codex-api/rpc'])
  })

  it('falls back to model/list when provider models are optional and unavailable', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string }
        : { method: '' }
      expect(body.method).toBe('model/list')
      return new Response(JSON.stringify({
        result: {
          data: [
            { id: 'gpt-5.5' },
            { model: 'gpt-5.4-mini' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
    })).resolves.toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(requests).toEqual(['/codex-api/provider-models', '/codex-api/rpc'])
  })

  it('preserves the official reasoning capabilities returned by model/list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        data: [{
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
            { reasoningEffort: 'ultra' },
          ],
          defaultReasoningEffort: 'low',
        }],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getAvailableModels({ includeProviderModels: false })).resolves.toEqual([{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'low',
    }])
  })
})

describe('getThreadDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads modelProvider from nested thread payloads returned by thread/read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      expect(body.method).toBe('thread/read')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: body.params.threadId,
            modelProvider: 'opencode_zen',
            turns: [],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadDetail('legacy-thread')).resolves.toMatchObject({
      modelProvider: 'opencode_zen',
    })
  })
})

describe('resumeThread', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces repeated resume failures for the same thread', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({ error: 'no rollout found for thread id missing-thread' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const results = await Promise.allSettled([
      resumeThread('missing-thread'),
      resumeThread('missing-thread'),
    ])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'missing-thread' } },
    ])
  })

  it('evicts a stalled resume so later resume attempts are not pinned forever', async () => {
    vi.useFakeTimers()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Promise<Response>(() => undefined)
    }))

    const first = resumeThread('stalled-thread')
    void resumeThread('stalled-thread')
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)

    const retried = resumeThread('stalled-thread')
    expect(retried).not.toBe(first)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
    ])
  })
})
