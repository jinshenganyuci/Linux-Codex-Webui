import type { ThreadGroupsPage, WorkspaceRootsState } from '../../api/codexGateway'
import type { UiProjectGroup, UiThread } from '../../types/codex'

export const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 150
export const THREAD_ROOTS_WAIT_MS = 1_500
export const RECENT_THREAD_LIST_LOAD_REUSE_MS = 2_000

export interface ThreadListLoaderEnvironment {
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(timerId: number): void
}

export interface ThreadListLoaderOptions {
  fetchPage(cursor?: string | null, limit?: number): Promise<ThreadGroupsPage>
  getBackgroundPageLimit(): number
  loadRootsState(): Promise<WorkspaceRootsState | null>
  loadTitleCache(options: { force?: boolean }): Promise<void>
  hydrateRootsState(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): Promise<void>
  applyPendingGroups?(groups: UiProjectGroup[]): void
  setRootsPending?(pending: boolean): void
  applyGroups(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): void
  hasLoadedThreads(): boolean
  setThreadsLoading(loading: boolean): void
  markThreadsLoaded(): void
  hasActiveThreads(): boolean
  afterPrimaryPageApplied(): void
  now?: () => number
  resolveEnvironment?: () => ThreadListLoaderEnvironment | null
}

export interface ThreadListLoader {
  load(options?: { force?: boolean; restartPagination?: boolean }): Promise<void>
  scheduleRemaining(rootsState?: WorkspaceRootsState | null): void
  removeThread(threadId: string): void
  mergeThreads(threads: UiThread[]): void
  loadMore(): void
  hasRemaining(): boolean
  stop(): void
}

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

export function removeThreadFromGroups(groups: UiProjectGroup[], threadId: string): UiProjectGroup[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return groups

  let changed = false
  const nextGroups: UiProjectGroup[] = []

  for (const group of groups) {
    const nextThreads = group.threads.filter((thread) => thread.id !== normalizedThreadId)
    const removedFromGroup = nextThreads.length !== group.threads.length
    if (removedFromGroup) {
      changed = true
    }
    if (nextThreads.length > 0) {
      nextGroups.push(removedFromGroup ? { ...group, threads: nextThreads } : group)
    } else if (group.threads.length === 0) {
      nextGroups.push(group)
    }
  }

  return changed ? nextGroups : groups
}

export function mergeThreadGroupPages(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  if (previous.length === 0) return incoming
  if (incoming.length === 0) return previous

  const threadById = new Map<string, UiThread>()
  for (const thread of flattenThreads(previous)) {
    threadById.set(thread.id, thread)
  }
  for (const thread of flattenThreads(incoming)) {
    threadById.set(thread.id, thread)
  }
  const groupsByProject = new Map<string, UiThread[]>()
  for (const thread of threadById.values()) {
    const existing = groupsByProject.get(thread.projectName)
    if (existing) existing.push(thread)
    else groupsByProject.set(thread.projectName, [thread])
  }

  return Array.from(groupsByProject.entries())
    .map(([projectName, threads]) => ({
      projectName,
      threads: threads.sort(
        (first, second) => new Date(second.updatedAtIso).getTime() - new Date(first.updatedAtIso).getTime(),
      ),
    }))
    .sort((first, second) => {
      const firstUpdated = new Date(first.threads[0]?.updatedAtIso ?? 0).getTime()
      const secondUpdated = new Date(second.threads[0]?.updatedAtIso ?? 0).getTime()
      return secondUpdated - firstUpdated
    })
}

function resolveBrowserEnvironment(): ThreadListLoaderEnvironment | null {
  if (typeof window === 'undefined') return null
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  }
}

export function createThreadListLoader(options: ThreadListLoaderOptions): ThreadListLoader {
  const now = options.now ?? (() => Date.now())
  const resolveEnvironment = options.resolveEnvironment ?? resolveBrowserEnvironment
  let loadPromise: Promise<void> | null = null
  let lastLoadAt = 0
  let nextCursor: string | null = null
  let backgroundTimerId: number | null = null
  let backgroundTimerEnvironment: ThreadListLoaderEnvironment | null = null
  let backgroundPromise: Promise<void> | null = null
  let hasStartedPagination = false
  let generation = 0
  let stopped = false
  let loadedGroups: UiProjectGroup[] = []
  let loadedRootsState: WorkspaceRootsState | null = null
  let rootsReady = false
  let lastAppliedGroups: UiProjectGroup[] | null = null
  let lastAppliedRoots: WorkspaceRootsState | null | undefined
  let metadataPromise: Promise<void> | null = null
  const removedThreadIds = new Set<string>()
  const visitedCursors = new Set<string>()

  function withoutRemoved(groups: UiProjectGroup[]): UiProjectGroup[] {
    return groups.map(group => ({
      ...group,
      threads: group.threads.filter(thread => !removedThreadIds.has(thread.id)),
    })).filter(group => group.threads.length > 0)
  }

  function applyLoadedGroups(): void {
    if (stopped || (!hasStartedPagination && loadedGroups.length === 0)) return
    if (rootsReady) {
      if (lastAppliedGroups === loadedGroups && lastAppliedRoots === loadedRootsState) return
      lastAppliedGroups = loadedGroups
      lastAppliedRoots = loadedRootsState
      options.applyGroups(loadedGroups, loadedRootsState)
    } else options.applyPendingGroups?.(loadedGroups)
  }

  function clearBackgroundTimer(): void {
    if (backgroundTimerId === null || !backgroundTimerEnvironment) return
    backgroundTimerEnvironment.clearTimeout(backgroundTimerId)
    backgroundTimerId = null
    backgroundTimerEnvironment = null
  }

  async function loadRemainingPages(): Promise<void> {
    if (backgroundPromise || !nextCursor || stopped) return
    const requestGeneration = generation
    const cursor = nextCursor
    const request = (async () => {
      try {
        const page = await options.fetchPage(cursor, options.getBackgroundPageLimit())
        if (stopped || requestGeneration !== generation) return
        visitedCursors.add(cursor)
        // A repeated server cursor must not turn pagination into an endless request loop.
        nextCursor = page.nextCursor && !visitedCursors.has(page.nextCursor) ? page.nextCursor : null
        loadedGroups = mergeThreadGroupPages(loadedGroups, withoutRemoved(page.groups))
        applyLoadedGroups()
      } catch {
        // Retry only after an explicit refresh; a broken cursor must not poll forever.
        return
      }
      if (requestGeneration === generation && nextCursor) scheduleRemaining()
    })().finally(() => {
      if (backgroundPromise === request) backgroundPromise = null
    })
    backgroundPromise = request
    await request
    // Scheduling while the request was pending was intentionally ignored.
    if (requestGeneration === generation && nextCursor && visitedCursors.has(cursor)) scheduleRemaining()
  }

  function scheduleRemaining(rootsState: WorkspaceRootsState | null = loadedRootsState): void {
    if (!nextCursor || backgroundPromise || backgroundTimerId !== null || stopped) return
    loadedRootsState = rootsState
    const environment = resolveEnvironment()
    if (!environment) {
      void loadRemainingPages()
      return
    }
    backgroundTimerEnvironment = environment
    backgroundTimerId = environment.setTimeout(() => {
      backgroundTimerId = null
      backgroundTimerEnvironment = null
      void loadRemainingPages()
    }, BACKGROUND_THREAD_PAGINATION_DELAY_MS)
  }

  function loadMetadata(force: boolean, requestGeneration: number): Promise<void> {
    if (metadataPromise) return metadataPromise
    const request = (async () => {
      let rootsState: WorkspaceRootsState | null
      try {
        rootsState = await options.loadRootsState()
      } catch {
        if (!stopped && requestGeneration === generation) options.setRootsPending?.(true)
        return
      }
      if (stopped || requestGeneration !== generation) return
      loadedRootsState = rootsState
      rootsReady = true
      options.setRootsPending?.(false)
      // Hydration only updates labels/order and must not hold the list response hostage.
      void options.hydrateRootsState(loadedGroups, rootsState).catch(() => {})
      applyLoadedGroups()
    })().finally(() => {
      if (metadataPromise === request) metadataPromise = null
    })
    metadataPromise = request
    void options.loadTitleCache({ force }).catch(() => {})
    return request
  }

  async function waitForRoots(metadata: Promise<void>): Promise<void> {
    const environment = resolveEnvironment()
    if (!environment) return await metadata
    let timerId: number | undefined
    await Promise.race([
      metadata,
      new Promise<void>(resolve => {
        timerId = environment.setTimeout(resolve, THREAD_ROOTS_WAIT_MS)
      }),
    ]).finally(() => {
      if (timerId !== undefined) environment.clearTimeout(timerId)
    })
    if (!rootsReady && !stopped) options.setRootsPending?.(true)
  }

  return {
    async load(loadOptions: { force?: boolean; restartPagination?: boolean } = {}) {
      if (loadPromise) {
        await loadPromise
        if (loadOptions.restartPagination === true) return await this.load(loadOptions)
        return
      }
      if (loadOptions.force !== true && options.hasLoadedThreads()
        && now() - lastLoadAt < RECENT_THREAD_LIST_LOAD_REUSE_MS) return
      stopped = false
      const requestGeneration = generation
      const metadata = loadMetadata(loadOptions.force === true, requestGeneration)
      const request = (async () => {
        if (!options.hasLoadedThreads()) options.setThreadsLoading(true)
        try {
          if (loadOptions.restartPagination === true && backgroundPromise) await backgroundPromise
          const page = await options.fetchPage()
          if (stopped || requestGeneration !== generation) return
          loadedGroups = mergeThreadGroupPages(loadedGroups, withoutRemoved(page.groups))
          // Refreshing the first page never rewinds an active pagination traversal.
          if (!hasStartedPagination || loadOptions.restartPagination === true) {
            visitedCursors.clear()
            hasStartedPagination = true
            nextCursor = page.nextCursor
          }
          // Roots determine which projects can be shown. They are independent of the
          // expensive list read; subsequent refreshes can use the last known roots.
          if (!rootsReady) await waitForRoots(metadata)
          if (stopped || requestGeneration !== generation) return
          applyLoadedGroups()
          options.markThreadsLoaded()
          lastLoadAt = now()
          scheduleRemaining()
          options.afterPrimaryPageApplied()
        } finally {
          if (requestGeneration === generation) options.setThreadsLoading(false)
        }
      })().finally(() => {
        if (loadPromise === request) loadPromise = null
      })
      loadPromise = request
      await request
    },
    scheduleRemaining,
    removeThread(threadId: string) {
      const normalized = threadId.trim()
      if (!normalized) return
      removedThreadIds.add(normalized)
      loadedGroups = removeThreadFromGroups(loadedGroups, normalized)
    },
    loadMore() {
      clearBackgroundTimer()
      void loadRemainingPages()
    },
    mergeThreads(threads: UiThread[]) {
      const groups = threads.map(thread => ({ projectName: thread.projectName, threads: [thread] }))
      loadedGroups = mergeThreadGroupPages(loadedGroups, withoutRemoved(groups))
      applyLoadedGroups()
    },
    hasRemaining() {
      return Boolean(nextCursor)
    },
    stop() {
      stopped = true
      generation += 1
      clearBackgroundTimer()
      loadPromise = null
      metadataPromise = null
      backgroundPromise = null
      options.setThreadsLoading(false)
    },
  }
}
