import type { ThreadGroupsPage, WorkspaceRootsState } from '../../api/codexGateway'
import type { UiProjectGroup, UiThread } from '../../types/codex'

export const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 10_000
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
  load(options?: { force?: boolean }): Promise<void>
  scheduleRemaining(rootsState?: WorkspaceRootsState | null): void
  removeThread(threadId: string): void
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
  let isLoadingRemainingPages = false
  let hasLoadedAllPages = false
  let loadedGroups: UiProjectGroup[] = []
  let loadedRootsState: WorkspaceRootsState | null = null

  function clearBackgroundTimer(): void {
    if (backgroundTimerId === null || !backgroundTimerEnvironment) return
    backgroundTimerEnvironment.clearTimeout(backgroundTimerId)
    backgroundTimerId = null
    backgroundTimerEnvironment = null
  }

  async function loadRemainingPages(rootsState: WorkspaceRootsState | null): Promise<void> {
    if (isLoadingRemainingPages || !nextCursor || options.hasActiveThreads()) return
    isLoadingRemainingPages = true

    try {
      const page = await options.fetchPage(nextCursor, options.getBackgroundPageLimit())
      nextCursor = page.nextCursor
      hasLoadedAllPages = page.nextCursor === null
      loadedGroups = mergeThreadGroupPages(loadedGroups, page.groups)
      options.applyGroups(loadedGroups, rootsState)
    } catch {
      // Keep the first page usable; a later refresh can retry remaining pages.
    } finally {
      isLoadingRemainingPages = false
      if (nextCursor && !options.hasActiveThreads()) {
        scheduleRemaining(rootsState)
      }
    }
  }

  function scheduleRemaining(rootsState: WorkspaceRootsState | null = loadedRootsState): void {
    if (!nextCursor || isLoadingRemainingPages || options.hasActiveThreads()) return

    loadedRootsState = rootsState
    const environment = resolveEnvironment()
    if (!environment) {
      void loadRemainingPages(rootsState)
      return
    }

    clearBackgroundTimer()
    backgroundTimerEnvironment = environment
    backgroundTimerId = environment.setTimeout(() => {
      backgroundTimerId = null
      backgroundTimerEnvironment = null
      if (!nextCursor || options.hasActiveThreads()) return
      void loadRemainingPages(loadedRootsState)
    }, BACKGROUND_THREAD_PAGINATION_DELAY_MS)
  }

  return {
    async load(loadOptions: { force?: boolean } = {}) {
      if (loadPromise) {
        await loadPromise
        return
      }
      if (
        loadOptions.force !== true
        && options.hasLoadedThreads()
        && now() - lastLoadAt < RECENT_THREAD_LIST_LOAD_REUSE_MS
      ) {
        return
      }

      loadPromise = (async () => {
        if (!options.hasLoadedThreads()) {
          options.setThreadsLoading(true)
        }

        try {
          const [page, rootsState] = await Promise.all([
            options.fetchPage(),
            options.loadRootsState(),
            options.loadTitleCache({ force: loadOptions.force === true }),
          ])
          loadedRootsState = rootsState
          const groups = page.groups
          loadedGroups = options.hasLoadedThreads()
            ? mergeThreadGroupPages(loadedGroups, groups)
            : groups
          nextCursor = options.hasLoadedThreads() && !hasLoadedAllPages
            ? nextCursor
            : page.nextCursor
          hasLoadedAllPages = page.nextCursor === null
          await options.hydrateRootsState(groups, rootsState)

          options.applyGroups(loadedGroups, rootsState)
          options.markThreadsLoaded()
          lastLoadAt = now()
          if (!hasLoadedAllPages) {
            scheduleRemaining(rootsState)
          }
          options.afterPrimaryPageApplied()
        } finally {
          options.setThreadsLoading(false)
        }
      })().finally(() => {
        loadPromise = null
      })

      await loadPromise
    },
    scheduleRemaining,
    removeThread(threadId: string) {
      loadedGroups = removeThreadFromGroups(loadedGroups, threadId)
    },
    hasRemaining() {
      return Boolean(nextCursor)
    },
    stop() {
      clearBackgroundTimer()
    },
  }
}
