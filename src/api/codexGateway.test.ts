import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAvailableModelIds, getThreadDetail, listDirectoryComposioConnectors, resumeThread, startThread, startThreadTurn, startThreadWithTurn } from './codexGateway'

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

  it('uses provider models without waiting for model/list when provider models are required', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'deepseek-v4-flash-free'],
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
    })).resolves.toEqual(['big-pickle', 'deepseek-v4-flash-free'])
    expect(requests).toEqual(['/codex-api/provider-models'])
  })

  it('requests models for an explicit thread provider', async () => {
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
    expect(requests).toEqual(['/codex-api/provider-models?provider=opencode-zen'])
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
