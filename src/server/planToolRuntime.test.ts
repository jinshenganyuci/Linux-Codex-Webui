import { describe, expect, it, vi } from 'vitest'
import { PLAN_PROGRESS_GUIDANCE, PlanToolRuntimePolicy } from './planToolRuntime'

function layer(enabled?: boolean, extra: Record<string, unknown> = {}) {
  return { config: enabled === undefined ? {} : { tools: { update_plan: { enabled } } }, ...extra }
}

function setup(layers: unknown[] = [layer()], config: Record<string, unknown> = {}) {
  const notify = vi.fn()
  const policy = new PlanToolRuntimePolicy(notify)
  const call = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === 'config/read') return { config, layers }
    if (method === 'thread/read') return { thread: { id: 'old', cwd: '/project' } }
    return { thread: { id: 'created' } }
  })
  return { policy, call, notify }
}

describe('plan tool runtime policy', () => {
  it('enables native progress for new threads without replacing user instructions or other config', async () => {
    const { policy, call } = setup([layer()], { developer_instructions: 'Keep existing workspace instructions.' })
    const params = { cwd: '/project', config: { model_verbosity: 'low', tools: { web_search: { enabled: false } } } }
    await policy.call('thread/start', params, '0.154.0', call)
    expect(call).toHaveBeenNthCalledWith(1, 'config/read', { cwd: '/project', includeLayers: true })
    expect(call).toHaveBeenLastCalledWith('thread/start', {
      ...params,
      config: { ...params.config, 'tools.update_plan.enabled': true },
      developerInstructions: `Keep existing workspace instructions.\n\n${PLAN_PROGRESS_GUIDANCE}`,
    })
    expect(params.config).not.toHaveProperty('tools.update_plan.enabled')
    expect(PLAN_PROGRESS_GUIDANCE).toContain('Skip plans for simple questions')
    expect(PLAN_PROGRESS_GUIDANCE).toContain('does not change the selected collaboration mode')
  })

  it.each([
    { 'tools.update_plan.enabled': false },
    { 'tools.update_plan': { enabled: false } },
    { tools: { update_plan: { enabled: false } } },
  ])('preserves an explicit request disable without extra native requests: %j', async config => {
    const { policy, call } = setup()
    const params = { config }
    await policy.call('thread/start', params, '0.154.0', call)
    expect(call).toHaveBeenCalledExactlyOnceWith('thread/start', params)
  })

  it('respects project/profile precedence and ignores disabled untrusted project layers', async () => {
    for (const layers of [
      [layer(false, { name: { type: 'project' } }), layer(true)],
      [layer(false, { name: { type: 'user', profile: 'restricted' } }), layer(true)],
    ]) {
      const { policy, call } = setup(layers)
      await policy.call('thread/start', { cwd: '/project' }, '0.154.0', call)
      expect(call).toHaveBeenLastCalledWith('thread/start', { cwd: '/project' })
    }
    const { policy, call } = setup([layer(false, { disabledReason: 'untrusted' }), layer(true)])
    await policy.call('thread/start', {}, '0.154.0', call)
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ config: { 'tools.update_plan.enabled': true } })
  })

  it('honors explicit request enable over lower layers and preserves custom developer guidance once', async () => {
    const { policy, call } = setup([layer(false)], { developer_instructions: 'Lower priority' })
    const developerInstructions = `Custom instructions.\n\n${PLAN_PROGRESS_GUIDANCE}`
    const params = { config: { 'tools.update_plan.enabled': true }, developerInstructions }
    await policy.call('thread/start', params, '0.154.0', call)
    expect(call).toHaveBeenLastCalledWith('thread/start', params)
  })

  it('resolves an old thread workspace and leaves its persisted developer instructions untouched', async () => {
    const { policy, call } = setup([], { developer_instructions: 'New global instructions' })
    await policy.call('thread/resume', { threadId: 'old', excludeTurns: true }, '0.154.0', call)
    expect(call).toHaveBeenNthCalledWith(1, 'thread/read', { threadId: 'old', includeTurns: false })
    expect(call).toHaveBeenNthCalledWith(2, 'config/read', { cwd: '/project', includeLayers: true })
    expect(call).toHaveBeenLastCalledWith('thread/resume', {
      threadId: 'old', excludeTurns: true, config: { 'tools.update_plan.enabled': true },
    })
  })

  it('does not force-enable ambiguous path resumes or unreadable project settings', async () => {
    const { policy, call, notify } = setup()
    const params = { threadId: 'old', path: '/other/rollout.jsonl' }
    await policy.call('thread/resume', params, '0.154.0', call)
    expect(call).toHaveBeenCalledExactlyOnceWith('thread/resume', params)
    expect(notify).toHaveBeenCalledTimes(1)
    call.mockClear()
    call.mockImplementation(async method => {
      if (method === 'config/read') throw new Error('config contains confidential data that must not be exposed')
      return {}
    })
    await policy.call('thread/start', {}, '0.154.0', call)
    expect(call).toHaveBeenLastCalledWith('thread/start', {})
    expect(JSON.stringify(notify.mock.calls)).not.toContain('confidential')
    expect(policy.compatibilityNotice).toContain('未强制启用')
  })

  it('fails closed if native config/read does not include raw parsed layers', async () => {
    const { policy, call } = setup()
    call.mockImplementation(async method => method === 'config/read' ? { config: { tools: { web_search: null } } } : {})
    await policy.call('thread/start', {}, '0.154.0', call)
    expect(call).toHaveBeenLastCalledWith('thread/start', {})
  })

  it('coalesces simultaneous config reads for one cwd while keeping different projects isolated', async () => {
    const { policy, call } = setup()
    const resolvers = new Map<string, (value: unknown) => void>()
    call.mockImplementation(async (method, value) => {
      if (method !== 'config/read') return {}
      const cwd = (value as { cwd: string }).cwd
      return new Promise(resolve => resolvers.set(cwd, resolve))
    })
    const requests = [
      policy.call('thread/start', { cwd: '/one' }, '0.154.0', call),
      policy.call('thread/start', { cwd: '/one' }, '0.154.0', call),
      policy.call('thread/start', { cwd: '/two' }, '0.154.0', call),
    ]
    expect(call).toHaveBeenCalledTimes(2)
    resolvers.get('/one')!({ config: {}, layers: [layer(false)] })
    resolvers.get('/two')!({ config: {}, layers: [] })
    await Promise.all(requests)
    const starts = call.mock.calls.filter(([method]) => method === 'thread/start').map(([, params]) => params)
    expect(starts.filter(params => (params as { cwd: string }).cwd === '/one')).toEqual([{ cwd: '/one' }, { cwd: '/one' }])
    expect(starts.find(params => (params as { cwd: string }).cwd === '/two')).toMatchObject({ config: { 'tools.update_plan.enabled': true } })
  })

  it('re-reads settings on later thread operations so external disables are not hidden by a stale cache', async () => {
    const { policy, call } = setup()
    await policy.call('thread/start', { cwd: '/project' }, '0.154.0', call)
    call.mockImplementation(async method => method === 'config/read' ? { config: {}, layers: [layer(false)] } : {})
    await policy.call('thread/start', { cwd: '/project' }, '0.154.0', call)
    expect(call.mock.calls.filter(([method]) => method === 'config/read')).toHaveLength(2)
    expect(call).toHaveBeenLastCalledWith('thread/start', { cwd: '/project' })
  })

  it('reports unsupported runtime versions once and leaves native behavior intact', async () => {
    const { policy, call, notify } = setup()
    await policy.call('thread/start', {}, '0.151.0', call)
    await policy.call('thread/start', {}, null, call)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(call.mock.calls).toEqual([['thread/start', {}], ['thread/start', {}]])
  })

  it('retries only an unknown injected setting once, then keeps compatibility fallback until restart', async () => {
    const { policy, call, notify } = setup()
    call.mockImplementation(async (method, params) => {
      if (method === 'config/read') return { config: {}, layers: [] }
      if ((params as { config?: unknown }).config) throw new Error('unknown field tools.update_plan.enabled')
      return { thread: { id: 'created' } }
    })
    await expect(policy.call('thread/start', {}, '0.154.0', call)).resolves.toEqual({ thread: { id: 'created' } })
    expect(call.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(2)
    expect(notify).toHaveBeenCalledTimes(1)
    call.mockClear()
    await policy.call('thread/start', {}, '0.154.0', call)
    expect(call).toHaveBeenCalledExactlyOnceWith('thread/start', {})
    policy.reset()
    expect(policy.compatibilityNotice).toBeNull()
  })

  it('never repeats a thread creation after an ordinary transport failure', async () => {
    const { policy, call } = setup()
    call.mockImplementation(async method => {
      if (method === 'config/read') return { config: {}, layers: [] }
      throw new Error('connection closed')
    })
    await expect(policy.call('thread/start', {}, '0.154.0', call)).rejects.toThrow('connection closed')
    expect(call.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
  })
})
