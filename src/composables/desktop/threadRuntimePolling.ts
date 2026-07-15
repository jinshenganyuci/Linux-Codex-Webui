import type { ThreadRuntimeState } from '../../api/codexGateway'

export const ACTIVE_RUNTIME_STATE_POLL_INTERVAL_MS = 2_000
export const IDLE_RUNTIME_STATE_POLL_INTERVAL_MS = 15_000
export const BUSY_RUNTIME_STATE_POLL_RETRY_MS = 250

const OPTIMISTIC_RUNTIME_STATE_GRACE_MS = 60_000
const RUNTIME_STARTED_AT_TOLERANCE_MS = 1_000

export interface ThreadRuntimePollingEnvironment {
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(timerId: number): void
  onWindowEvent(event: 'focus' | 'online', callback: () => void): () => void
  onVisibilityChange(callback: () => void): () => void
  isDocumentVisible(): boolean
}

export interface ThreadRuntimePollingOptions {
  collectThreadIds(): string[]
  hasActiveThreads(): boolean
  fetchStates(threadIds: string[]): Promise<ThreadRuntimeState[]>
  applyStates(states: ThreadRuntimeState[]): void
  resolveEnvironment?: () => ThreadRuntimePollingEnvironment | null
}

export interface ThreadRuntimePollingController {
  start(): void
  requestImmediate(): void
  stop(): void
  reconcile(threadId: string): Promise<ThreadRuntimeState | null>
}

export function collectThreadRuntimeStateIds(
  threads: ReadonlyArray<{ id: string }>,
  runtimeStateByThreadId: Readonly<Record<string, boolean>>,
  selectedThreadId: string,
): string[] {
  const threadIds = new Set<string>()
  for (const thread of threads) threadIds.add(thread.id)
  for (const threadId of Object.keys(runtimeStateByThreadId)) threadIds.add(threadId)
  const selected = selectedThreadId.trim()
  if (selected) threadIds.add(selected)
  return Array.from(threadIds)
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

export function shouldIgnoreOlderTerminalRuntimeState(options: {
  state: ThreadRuntimeState
  optimisticStartedAtMs: number | undefined
  currentTurnId: string
  nowMs: number
}): boolean {
  const { state, optimisticStartedAtMs, currentTurnId, nowMs } = options
  if (optimisticStartedAtMs) {
    const runtimeStartedAtMs = state.startedAtIso ? Date.parse(state.startedAtIso) : NaN
    if (!Number.isFinite(runtimeStartedAtMs)) {
      return nowMs - optimisticStartedAtMs < OPTIMISTIC_RUNTIME_STATE_GRACE_MS
    }
    if (runtimeStartedAtMs + RUNTIME_STARTED_AT_TOLERANCE_MS < optimisticStartedAtMs) return true
  }

  const normalizedCurrentTurnId = currentTurnId.trim()
  if (!normalizedCurrentTurnId || !state.turnId || normalizedCurrentTurnId === state.turnId) return false
  if (!isUuidV7(normalizedCurrentTurnId) || !isUuidV7(state.turnId)) return false
  return normalizedCurrentTurnId.localeCompare(state.turnId) > 0
}

function resolveBrowserEnvironment(): ThreadRuntimePollingEnvironment | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
    onWindowEvent: (event, callback) => {
      window.addEventListener(event, callback)
      return () => window.removeEventListener(event, callback)
    },
    onVisibilityChange: (callback) => {
      document.addEventListener('visibilitychange', callback)
      return () => document.removeEventListener('visibilitychange', callback)
    },
    isDocumentVisible: () => document.visibilityState === 'visible',
  }
}

export function createThreadRuntimePollingController(
  options: ThreadRuntimePollingOptions,
): ThreadRuntimePollingController {
  const resolveEnvironment = options.resolveEnvironment ?? resolveBrowserEnvironment
  let environment: ThreadRuntimePollingEnvironment | null = null
  let timerId: number | null = null
  let requestInFlight = false
  let generation = 0
  let started = false
  let removeLifecycleListeners: (() => void) | null = null

  function clearScheduledPoll(): void {
    if (timerId === null || !environment) return
    environment.clearTimeout(timerId)
    timerId = null
  }

  function schedule(delayMs: number, replaceExisting = false): void {
    if (!started || !environment) return
    if (timerId !== null) {
      if (!replaceExisting) return
      clearScheduledPoll()
    }
    const scheduledGeneration = generation
    timerId = environment.setTimeout(() => {
      timerId = null
      void poll(scheduledGeneration)
    }, Math.max(0, delayMs))
  }

  async function poll(scheduledGeneration: number): Promise<void> {
    if (!started || scheduledGeneration !== generation) return
    if (requestInFlight) {
      schedule(BUSY_RUNTIME_STATE_POLL_RETRY_MS, true)
      return
    }

    const threadIds = options.collectThreadIds()
    if (threadIds.length === 0) {
      schedule(IDLE_RUNTIME_STATE_POLL_INTERVAL_MS)
      return
    }

    requestInFlight = true
    let anyRunning = options.hasActiveThreads()
    try {
      const states = await options.fetchStates(threadIds)
      if (!started || scheduledGeneration !== generation) return
      options.applyStates(states)
      anyRunning = states.some((state) => state.isRunning) || options.hasActiveThreads()
    } catch {
      anyRunning = options.hasActiveThreads()
    } finally {
      requestInFlight = false
      if (started && scheduledGeneration === generation) {
        schedule(
          anyRunning ? ACTIVE_RUNTIME_STATE_POLL_INTERVAL_MS : IDLE_RUNTIME_STATE_POLL_INTERVAL_MS,
        )
      }
    }
  }

  function installLifecycleListeners(): void {
    if (!environment || removeLifecycleListeners) return
    const requestImmediate = () => schedule(0, true)
    const handleVisibilityChange = () => {
      if (environment?.isDocumentVisible()) requestImmediate()
    }
    const removeFocusListener = environment.onWindowEvent('focus', requestImmediate)
    const removeOnlineListener = environment.onWindowEvent('online', requestImmediate)
    const removeVisibilityListener = environment.onVisibilityChange(handleVisibilityChange)
    removeLifecycleListeners = () => {
      removeFocusListener()
      removeOnlineListener()
      removeVisibilityListener()
      removeLifecycleListeners = null
    }
  }

  return {
    start() {
      if (started) return
      environment = resolveEnvironment()
      if (!environment) return
      started = true
      generation += 1
      installLifecycleListeners()
      schedule(0, true)
    },
    requestImmediate() {
      schedule(0, true)
    },
    stop() {
      generation += 1
      started = false
      clearScheduledPoll()
      removeLifecycleListeners?.()
      environment = null
    },
    async reconcile(threadId: string) {
      try {
        const state = (await options.fetchStates([threadId]))[0] ?? null
        if (state) options.applyStates([state])
        return state
      } catch {
        return null
      }
    },
  }
}
