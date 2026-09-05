import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeThreadController } from './nativeThreadController'
import type { NativeGoal } from '../../nativeThreadControls'

const api = vi.hoisted(() => ({
  addNativeQueueInput: vi.fn(), clearNativeGoal: vi.fn(), deleteNativeQueueInput: vi.fn(),
  getNativeCapabilities: vi.fn(), getNativeGoal: vi.fn(), getNativePermissionProfiles: vi.fn(),
  getNativeQueue: vi.fn(), getNativeThreadState: vi.fn(), invalidateNativeCapabilities: vi.fn(),
  reorderNativeQueue: vi.fn(), setNativeGoal: vi.fn(), setNativeQueueMode: vi.fn(),
  startNativeQueueInput: vi.fn(), updateNativeQueueInput: vi.fn(), updateNativeSettings: vi.fn(),
}))
vi.mock('../../api/nativeThreadGateway', () => api)

const controllers: Array<ReturnType<typeof createNativeThreadController>> = []
const goal = (threadId: string, tokensUsed = 10): NativeGoal => ({ threadId, objective: 'finish', status: 'paused', tokenBudget: 100, tokensUsed, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 })
const submission = { id: 'native-1', clientUserMessageId: 'client-1', input: [{ type: 'text', text: 'before' }, { type: 'localImage', path: '/tmp/image.png' }, { type: 'skill', name: 'audit', path: '/tmp/skill' }] }
const create = () => { const controller = createNativeThreadController(); controllers.push(controller); return controller }
const event = (method: string, params: unknown) => ({ method, params, atIso: new Date().toISOString() })

beforeEach(() => {
  vi.resetAllMocks()
  api.getNativeCapabilities.mockResolvedValue({ steer: true, turnSettings: true, threadSettings: true, goals: true, queue: true, permissions: true })
  api.getNativeThreadState.mockResolvedValue({ mode: 'legacy', settings: null })
  api.getNativeGoal.mockImplementation(async (threadId: string) => goal(threadId))
  api.getNativePermissionProfiles.mockResolvedValue([{ id: ':workspace', allowed: true, description: '' }])
  api.getNativeQueue.mockResolvedValue([])
  api.updateNativeSettings.mockResolvedValue('saved')
})
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers() })

describe('native thread controller', () => {
  it('restores goals on selection, loads permissions lazily, and does not reload on the initial ready', async () => {
    const controller = create()
    await controller.select('thread')
    expect(controller.state.goal?.status).toBe('paused')
    expect(api.getNativeGoal).toHaveBeenCalledTimes(1)
    expect(api.getNativePermissionProfiles).not.toHaveBeenCalled()
    controller.observe(event('ready', { streamId: 'first' }))
    await controller.expand()
    expect(api.getNativeGoal).toHaveBeenCalledTimes(1)
    expect(api.getNativePermissionProfiles).toHaveBeenCalledTimes(1)
  })

  it('discards late reads from a different selected thread', async () => {
    let finish!: (value: unknown) => void
    api.getNativeThreadState.mockImplementation((threadId: string) => threadId === 'old' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ mode: 'legacy', settings: { model: 'new-model' } }))
    const controller = create()
    const oldRead = controller.select('old')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await controller.select('new')
    finish({ mode: 'native', settings: { model: 'old-model' } })
    await oldRead
    expect(controller.state.threadId).toBe('new')
    expect(controller.state.settings?.model).toBe('new-model')
    expect(controller.state.goal?.threadId).toBe('new')
  })

  it('does not let a late goal read overwrite a newer native notification', async () => {
    let finish!: (value: NativeGoal) => void
    api.getNativeGoal.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = create()
    const reading = controller.select('thread')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    controller.observe(event('thread/goal/updated', { threadId: 'thread', goal: goal('thread', 70) }))
    finish(goal('thread', 10))
    await reading
    expect(controller.state.goal?.tokensUsed).toBe(70)
    controller.observe(event('thread/goal/cleared', { threadId: 'other' }))
    expect(controller.state.goal).not.toBeNull()
    controller.observe(event('thread/goal/cleared', { threadId: 'thread' }))
    expect(controller.state.goal).toBeNull()
  })

  it('distinguishes unavailable running settings without changing thread defaults', async () => {
    api.updateNativeSettings.mockResolvedValue('targetUnavailable')
    const controller = create()
    await controller.select('thread')
    api.getNativeThreadState.mockClear()
    await controller.applySettings({ model: 'gpt-6-astra' }, 'finished-turn')
    expect(controller.state.message).toContain('没有生效')
    expect(api.updateNativeSettings).toHaveBeenCalledExactlyOnceWith('thread', { model: 'gpt-6-astra' }, 'finished-turn')
    expect(api.getNativeThreadState).not.toHaveBeenCalled()
  })

  it('keeps native ownership when a downgraded CLI cannot provide queue methods', async () => {
    api.getNativeCapabilities.mockResolvedValue({ steer: false, turnSettings: false, threadSettings: false, goals: false, queue: false, permissions: false })
    api.getNativeThreadState.mockResolvedValue({ mode: 'native', settings: null })
    const controller = create()
    await controller.select('thread')
    expect(controller.state.mode).toBe('native')
    expect(controller.state.error).toContain('不会切回旧队列')
    expect(api.getNativeQueue).not.toHaveBeenCalled()
  })

  it('coalesces queue notifications and retains non-text input when editing', async () => {
    vi.useFakeTimers()
    api.getNativeThreadState.mockResolvedValue({ mode: 'native', settings: null })
    api.getNativeQueue.mockResolvedValue([submission])
    const controller = create()
    await controller.select('thread')
    api.getNativeQueue.mockClear()
    for (let index = 0; index < 30; index += 1) controller.observe(event('thread/queue/changed', { threadId: 'thread' }))
    await vi.advanceTimersByTimeAsync(125)
    expect(api.getNativeQueue).toHaveBeenCalledTimes(1)
    await controller.changeQueue('edit', 'native-1', 'changed')
    expect(api.updateNativeQueueInput).toHaveBeenCalledWith('thread', 'native-1', [{ type: 'text', text: 'changed' }, ...submission.input.slice(1)])
    await controller.changeQueue('start', 'native-1')
    expect(api.startNativeQueueInput).toHaveBeenCalledWith('thread', 'native-1')
  })

  it('refreshes again when a change arrives during a queue read', async () => {
    vi.useFakeTimers()
    api.getNativeThreadState.mockResolvedValue({ mode: 'native', settings: null })
    const controller = create()
    await controller.select('thread')
    let finish!: (value: unknown[]) => void
    api.getNativeQueue.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue([submission])
    const reading = controller.refreshQueue()
    controller.observe(event('thread/queue/changed', { threadId: 'thread' }))
    finish([])
    await reading
    await vi.advanceTimersByTimeAsync(125)
    expect(controller.state.queue).toHaveLength(1)
  })

  it('keeps failed queue input unacknowledged and never retries the add', async () => {
    api.getNativeThreadState.mockResolvedValue({ mode: 'native', settings: null })
    api.addNativeQueueInput.mockRejectedValue(new Error('unknown outcome'))
    const controller = create()
    await controller.select('thread')
    await expect(controller.enqueue([{ type: 'text', text: 'keep this draft' }])).rejects.toThrow('unknown outcome')
    expect(api.addNativeQueueInput).toHaveBeenCalledTimes(1)
    expect(controller.state.busy).toBe(false)
    expect(controller.state.error).toContain('unknown outcome')
  })

  it('reconciles a start that raced CLI automatic delivery without replaying it', async () => {
    api.getNativeThreadState.mockResolvedValue({ mode: 'native', settings: null })
    api.getNativeQueue.mockResolvedValueOnce([submission]).mockResolvedValue([])
    api.startNativeQueueInput.mockRejectedValue(new Error('queued submission not found'))
    const controller = create()
    await controller.select('thread')
    await controller.changeQueue('start', submission.id)
    expect(controller.state.queue).toEqual([])
    expect(api.startNativeQueueInput).toHaveBeenCalledTimes(1)
    expect(controller.state.error).toContain('not found')
  })
})
