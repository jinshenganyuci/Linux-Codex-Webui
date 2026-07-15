import { describe, expect, it, vi } from 'vitest'
import type { ThreadRuntimeState } from '../../api/codexGateway'
import {
  ACTIVE_RUNTIME_STATE_POLL_INTERVAL_MS,
  BUSY_RUNTIME_STATE_POLL_RETRY_MS,
  IDLE_RUNTIME_STATE_POLL_INTERVAL_MS,
  collectThreadRuntimeStateIds,
  createThreadRuntimePollingController,
  shouldIgnoreOlderTerminalRuntimeState,
  type ThreadRuntimePollingEnvironment,
} from './threadRuntimePolling'

function runtimeState(overrides: Partial<ThreadRuntimeState> = {}): ThreadRuntimeState {
  return {
    threadId: 'thread-a',
    turnId: '019f6200-0000-7000-8000-000000000001',
    state: 'running',
    isRunning: true,
    source: 'local',
    startedAtIso: '2026-07-15T00:00:00.000Z',
    completedAtIso: null,
    owner: null,
    ...overrides,
  }
}

function createPollingEnvironment() {
  let nextTimerId = 1
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const windowListeners = new Map<'focus' | 'online', Set<() => void>>([
    ['focus', new Set()],
    ['online', new Set()],
  ])
  const visibilityListeners = new Set<() => void>()
  let documentVisible = true

  const environment: ThreadRuntimePollingEnvironment = {
    setTimeout: vi.fn((callback, delayMs) => {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { callback, delayMs })
      return timerId
    }),
    clearTimeout: vi.fn((timerId) => {
      timers.delete(timerId)
    }),
    onWindowEvent: vi.fn((event, callback) => {
      windowListeners.get(event)?.add(callback)
      return () => windowListeners.get(event)?.delete(callback)
    }),
    onVisibilityChange: vi.fn((callback) => {
      visibilityListeners.add(callback)
      return () => visibilityListeners.delete(callback)
    }),
    isDocumentVisible: vi.fn(() => documentVisible),
  }

  function nextScheduledTimer(): [number, { callback: () => void; delayMs: number }] {
    const entry = timers.entries().next().value
    if (!entry) throw new Error('Expected a scheduled runtime-state poll')
    return entry
  }

  function runNextTimer(): void {
    const [timerId, timer] = nextScheduledTimer()
    timers.delete(timerId)
    timer.callback()
  }

  return {
    environment,
    timers,
    windowListeners,
    visibilityListeners,
    nextScheduledTimer,
    runNextTimer,
    setDocumentVisible(value: boolean) {
      documentVisible = value
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('thread runtime polling helpers', () => {
  it('collects known, optimistic, and selected thread ids once in stable order', () => {
    expect(collectThreadRuntimeStateIds(
      [{ id: 'thread-a' }, { id: 'thread-b' }, { id: 'thread-a' }],
      { 'thread-b': true, 'thread-c': false },
      '  thread-d  ',
    )).toEqual(['thread-a', 'thread-b', 'thread-c', 'thread-d'])
  })

  it('keeps an optimistic turn when a terminal runtime snapshot lacks a recent start time', () => {
    const nowMs = Date.parse('2026-07-15T00:01:00.000Z')
    const state = runtimeState({ state: 'completed', isRunning: false, startedAtIso: null })

    expect(shouldIgnoreOlderTerminalRuntimeState({
      state,
      optimisticStartedAtMs: nowMs - 59_999,
      currentTurnId: '',
      nowMs,
    })).toBe(true)
    expect(shouldIgnoreOlderTerminalRuntimeState({
      state,
      optimisticStartedAtMs: nowMs - 60_000,
      currentTurnId: '',
      nowMs,
    })).toBe(false)
  })

  it('rejects terminal snapshots from an older start or UUIDv7 turn', () => {
    const optimisticStartedAtMs = Date.parse('2026-07-15T00:00:03.000Z')
    expect(shouldIgnoreOlderTerminalRuntimeState({
      state: runtimeState({
        state: 'completed',
        isRunning: false,
        startedAtIso: '2026-07-15T00:00:01.000Z',
      }),
      optimisticStartedAtMs,
      currentTurnId: '',
      nowMs: optimisticStartedAtMs,
    })).toBe(true)

    expect(shouldIgnoreOlderTerminalRuntimeState({
      state: runtimeState({
        state: 'completed',
        isRunning: false,
        turnId: '019f6200-0000-7000-8000-000000000001',
      }),
      optimisticStartedAtMs: undefined,
      currentTurnId: '019f6200-0000-7000-8000-000000000002',
      nowMs: optimisticStartedAtMs,
    })).toBe(true)
  })
})

describe('createThreadRuntimePollingController', () => {
  it('starts once, applies running states, and keeps the active interval', async () => {
    const harness = createPollingEnvironment()
    const states = [runtimeState()]
    const fetchStates = vi.fn(async () => states)
    const applyStates = vi.fn()
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => ['thread-a'],
      hasActiveThreads: () => false,
      fetchStates,
      applyStates,
      resolveEnvironment: () => harness.environment,
    })

    controller.start()
    controller.start()

    expect(harness.nextScheduledTimer()[1].delayMs).toBe(0)
    expect(harness.windowListeners.get('focus')).toHaveLength(1)
    expect(harness.windowListeners.get('online')).toHaveLength(1)
    expect(harness.visibilityListeners).toHaveLength(1)

    harness.runNextTimer()
    await flushMicrotasks()

    expect(fetchStates).toHaveBeenCalledTimes(1)
    expect(fetchStates).toHaveBeenCalledWith(['thread-a'])
    expect(applyStates).toHaveBeenCalledWith(states)
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(ACTIVE_RUNTIME_STATE_POLL_INTERVAL_MS)
  })

  it('uses the idle interval without issuing an empty request', async () => {
    const harness = createPollingEnvironment()
    const fetchStates = vi.fn(async () => [])
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => [],
      hasActiveThreads: () => false,
      fetchStates,
      applyStates: vi.fn(),
      resolveEnvironment: () => harness.environment,
    })

    controller.start()
    harness.runNextTimer()
    await flushMicrotasks()

    expect(fetchStates).not.toHaveBeenCalled()
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(IDLE_RUNTIME_STATE_POLL_INTERVAL_MS)
  })

  it('throttles overlaps, rejects prior-generation results, and cleans up stop state', async () => {
    const harness = createPollingEnvironment()
    const pendingFetch = deferred<ThreadRuntimeState[]>()
    const fetchStates = vi.fn(() => pendingFetch.promise)
    const applyStates = vi.fn()
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => ['thread-a'],
      hasActiveThreads: () => false,
      fetchStates,
      applyStates,
      resolveEnvironment: () => harness.environment,
    })

    controller.start()
    harness.runNextTimer()
    controller.requestImmediate()
    harness.runNextTimer()

    expect(fetchStates).toHaveBeenCalledTimes(1)
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(BUSY_RUNTIME_STATE_POLL_RETRY_MS)

    controller.stop()
    controller.start()
    pendingFetch.resolve([runtimeState()])
    await flushMicrotasks()

    expect(applyStates).not.toHaveBeenCalled()
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(0)

    harness.runNextTimer()
    await flushMicrotasks()

    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(applyStates).toHaveBeenCalledTimes(1)

    controller.stop()
    expect(harness.timers).toHaveLength(0)
    expect(harness.windowListeners.get('focus')).toHaveLength(0)
    expect(harness.windowListeners.get('online')).toHaveLength(0)
    expect(harness.visibilityListeners).toHaveLength(0)
  })

  it('releases the in-flight gate after a failed request', async () => {
    const harness = createPollingEnvironment()
    const fetchStates = vi.fn()
      .mockRejectedValueOnce(new Error('temporary bridge outage'))
      .mockResolvedValueOnce([])
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => ['thread-a'],
      hasActiveThreads: () => false,
      fetchStates,
      applyStates: vi.fn(),
      resolveEnvironment: () => harness.environment,
    })

    controller.start()
    harness.runNextTimer()
    await flushMicrotasks()
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(IDLE_RUNTIME_STATE_POLL_INTERVAL_MS)

    harness.runNextTimer()
    await flushMicrotasks()

    expect(fetchStates).toHaveBeenCalledTimes(2)
  })

  it('replaces an idle timer when focus or visible-page activity requests an immediate poll', async () => {
    const harness = createPollingEnvironment()
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => [],
      hasActiveThreads: () => false,
      fetchStates: vi.fn(async () => []),
      applyStates: vi.fn(),
      resolveEnvironment: () => harness.environment,
    })

    controller.start()
    harness.runNextTimer()
    await flushMicrotasks()
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(IDLE_RUNTIME_STATE_POLL_INTERVAL_MS)

    harness.windowListeners.get('focus')?.forEach((listener) => listener())
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(0)

    harness.runNextTimer()
    await flushMicrotasks()
    harness.setDocumentVisible(false)
    harness.visibilityListeners.forEach((listener) => listener())
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(IDLE_RUNTIME_STATE_POLL_INTERVAL_MS)

    harness.setDocumentVisible(true)
    harness.visibilityListeners.forEach((listener) => listener())
    expect(harness.nextScheduledTimer()[1].delayMs).toBe(0)
  })

  it('reconciles one thread without requiring the polling lifecycle to be started', async () => {
    const state = runtimeState({ threadId: 'thread-reconcile' })
    const fetchStates = vi.fn(async () => [state])
    const applyStates = vi.fn()
    const controller = createThreadRuntimePollingController({
      collectThreadIds: () => [],
      hasActiveThreads: () => false,
      fetchStates,
      applyStates,
      resolveEnvironment: () => null,
    })

    await expect(controller.reconcile('thread-reconcile')).resolves.toEqual(state)
    expect(fetchStates).toHaveBeenCalledWith(['thread-reconcile'])
    expect(applyStates).toHaveBeenCalledWith([state])
  })
})
