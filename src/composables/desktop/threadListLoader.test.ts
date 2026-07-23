import { describe, expect, it, vi } from 'vitest'
import type { ThreadGroupsPage, WorkspaceRootsState } from '../../api/codexGateway'
import type { UiProjectGroup, UiThread } from '../../types/codex'
import {
  BACKGROUND_THREAD_PAGINATION_DELAY_MS,
  RECENT_THREAD_LIST_LOAD_REUSE_MS,
  createThreadListLoader,
  mergeThreadGroupPages,
  removeThreadFromGroups,
  type ThreadListLoaderEnvironment,
  type ThreadListLoaderOptions,
} from './threadListLoader'

function thread(id: string, projectName: string, updatedAtIso: string): UiThread {
  return {
    id,
    title: id,
    projectName,
    cwd: `/tmp/${projectName}`,
    hasWorktree: false,
    createdAtIso: updatedAtIso,
    updatedAtIso,
    preview: '',
    unread: false,
    inProgress: false,
    historyMode: 'legacy',
  }
}

function page(groups: UiProjectGroup[], nextCursor: string | null): ThreadGroupsPage {
  return { groups, nextCursor }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function createTimerEnvironment() {
  let nextTimerId = 1
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const environment: ThreadListLoaderEnvironment = {
    setTimeout: vi.fn((callback, delayMs) => {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { callback, delayMs })
      return timerId
    }),
    clearTimeout: vi.fn((timerId) => {
      timers.delete(timerId)
    }),
  }

  function nextTimer(): [number, { callback: () => void; delayMs: number }] {
    const entry = timers.entries().next().value
    if (!entry) throw new Error('Expected a scheduled background thread-list load')
    return entry
  }

  function runNextTimer(): void {
    const [timerId, timer] = nextTimer()
    timers.delete(timerId)
    timer.callback()
  }

  return { environment, timers, nextTimer, runNextTimer }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createOptions(
  overrides: Partial<ThreadListLoaderOptions> = {},
): ThreadListLoaderOptions {
  let loaded = false
  return {
    fetchPage: vi.fn(async () => page([], null)),
    getBackgroundPageLimit: vi.fn(() => 100),
    loadRootsState: vi.fn(async () => null),
    loadTitleCache: vi.fn(async () => undefined),
    hydrateRootsState: vi.fn(async () => undefined),
    applyGroups: vi.fn(),
    hasLoadedThreads: vi.fn(() => loaded),
    setThreadsLoading: vi.fn(),
    markThreadsLoaded: vi.fn(() => {
      loaded = true
    }),
    hasActiveThreads: vi.fn(() => false),
    afterPrimaryPageApplied: vi.fn(),
    resolveEnvironment: () => null,
    ...overrides,
  }
}

describe('thread list collection helpers', () => {
  it('merges pages by thread id and sorts threads and projects by recency', () => {
    const previous: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [
          thread('alpha-old', 'alpha', '2026-07-10T00:00:00.000Z'),
          thread('shared', 'alpha', '2026-07-11T00:00:00.000Z'),
        ],
      },
    ]
    const replacement = {
      ...thread('shared', 'alpha', '2026-07-15T00:00:00.000Z'),
      title: 'updated shared thread',
    }
    const incoming: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [replacement],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-new', 'beta', '2026-07-14T00:00:00.000Z')],
      },
    ]

    const merged = mergeThreadGroupPages(previous, incoming)

    expect(merged.map((group) => [group.projectName, group.threads.map((item) => item.id)])).toEqual([
      ['alpha', ['shared', 'alpha-old']],
      ['beta', ['beta-new']],
    ])
    expect(merged[0]?.threads[0]).toBe(replacement)
  })

  it('removes a thread without dropping pre-existing empty project placeholders', () => {
    const groups: UiProjectGroup[] = [
      { projectName: 'alpha', threads: [thread('remove-me', 'alpha', '2026-07-15T00:00:00.000Z')] },
      { projectName: 'empty-root', threads: [] },
    ]

    expect(removeThreadFromGroups(groups, ' remove-me ')).toEqual([
      { projectName: 'empty-root', threads: [] },
    ])
    expect(removeThreadFromGroups(groups, 'missing')).toBe(groups)
  })
})

describe('createThreadListLoader', () => {
  it('coalesces concurrent loads, reuses a recent result, and preserves forced refresh', async () => {
    const pendingPage = deferred<ThreadGroupsPage>()
    const fetchPage = vi.fn(() => pendingPage.promise)
    const loadingStates: boolean[] = []
    let loaded = false
    let nowMs = 10_000
    const applyGroups = vi.fn()
    const afterPrimaryPageApplied = vi.fn()
    const options = createOptions({
      fetchPage,
      hasLoadedThreads: () => loaded,
      setThreadsLoading: (loading) => loadingStates.push(loading),
      markThreadsLoaded: () => {
        loaded = true
      },
      applyGroups,
      afterPrimaryPageApplied,
      now: () => nowMs,
    })
    const loader = createThreadListLoader(options)

    const firstLoad = loader.load()
    const coalescedLoad = loader.load()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    pendingPage.resolve(page([
      { projectName: 'alpha', threads: [thread('thread-a', 'alpha', '2026-07-15T00:00:00.000Z')] },
    ], null))
    await Promise.all([firstLoad, coalescedLoad])

    expect(loadingStates).toEqual([true, false])
    expect(applyGroups).toHaveBeenCalledTimes(1)
    expect(afterPrimaryPageApplied).toHaveBeenCalledTimes(1)

    nowMs += RECENT_THREAD_LIST_LOAD_REUSE_MS - 1
    await loader.load()
    expect(fetchPage).toHaveBeenCalledTimes(1)

    await loader.load({ force: true })
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(options.loadTitleCache).toHaveBeenLastCalledWith({ force: true })
    expect(loadingStates).toEqual([true, false, false])
  })

  it('loads remaining pages with the same cursor and limit, then applies the merged list', async () => {
    const timerHarness = createTimerEnvironment()
    const firstGroups: UiProjectGroup[] = [
      { projectName: 'alpha', threads: [thread('thread-a', 'alpha', '2026-07-13T00:00:00.000Z')] },
    ]
    const remainingGroups: UiProjectGroup[] = [
      { projectName: 'beta', threads: [thread('thread-b', 'beta', '2026-07-15T00:00:00.000Z')] },
    ]
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page(firstGroups, 'cursor-2'))
      .mockResolvedValueOnce(page(remainingGroups, null))
    let loaded = false
    const applyGroups = vi.fn()
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/alpha', '/tmp/beta'],
    }
    const loader = createThreadListLoader(createOptions({
      fetchPage,
      getBackgroundPageLimit: () => 100,
      loadRootsState: async () => rootsState,
      hasLoadedThreads: () => loaded,
      markThreadsLoaded: () => {
        loaded = true
      },
      applyGroups,
      resolveEnvironment: () => timerHarness.environment,
    }))

    await loader.load()

    expect(fetchPage).toHaveBeenNthCalledWith(1)
    expect(timerHarness.nextTimer()[1].delayMs).toBe(BACKGROUND_THREAD_PAGINATION_DELAY_MS)

    timerHarness.runNextTimer()
    await flushMicrotasks()

    expect(fetchPage).toHaveBeenNthCalledWith(2, 'cursor-2', 100)
    expect(applyGroups).toHaveBeenLastCalledWith([
      { projectName: 'beta', threads: remainingGroups[0]?.threads },
      { projectName: 'alpha', threads: firstGroups[0]?.threads },
    ], rootsState)
    expect(timerHarness.timers).toHaveLength(0)
    expect(loader.hasRemaining()).toBe(false)
  })

  it('pauses background pagination for active turns and stop clears the pending timer', async () => {
    const timerHarness = createTimerEnvironment()
    let loaded = false
    let active = true
    const loader = createThreadListLoader(createOptions({
      fetchPage: vi.fn(async () => page([], 'cursor-2')),
      hasLoadedThreads: () => loaded,
      markThreadsLoaded: () => {
        loaded = true
      },
      hasActiveThreads: () => active,
      resolveEnvironment: () => timerHarness.environment,
    }))

    await loader.load()
    expect(loader.hasRemaining()).toBe(true)
    expect(timerHarness.timers).toHaveLength(0)

    active = false
    loader.scheduleRemaining()
    expect(timerHarness.nextTimer()[1].delayMs).toBe(BACKGROUND_THREAD_PAGINATION_DELAY_MS)

    loader.stop()
    expect(timerHarness.timers).toHaveLength(0)
    expect(timerHarness.environment.clearTimeout).toHaveBeenCalledTimes(1)
  })

  it('releases the load gate and loading state after a failed primary request', async () => {
    const fetchPage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary thread/list failure'))
      .mockResolvedValueOnce(page([], null))
    const loadingStates: boolean[] = []
    let loaded = false
    const loader = createThreadListLoader(createOptions({
      fetchPage,
      hasLoadedThreads: () => loaded,
      setThreadsLoading: (loading) => loadingStates.push(loading),
      markThreadsLoaded: () => {
        loaded = true
      },
    }))

    await expect(loader.load()).rejects.toThrow('temporary thread/list failure')
    await expect(loader.load()).resolves.toBeUndefined()

    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(loadingStates).toEqual([true, false, true, false])
  })
})
