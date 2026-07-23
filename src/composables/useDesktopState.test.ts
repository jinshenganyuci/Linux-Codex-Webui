import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  capUtf8Tail,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  removeThreadFromGroups,
  isThreadUnreadByLastRead,
  useDesktopState,
} from './useDesktopState'
import type { ReasoningEffort, UiModelCapability, UiProjectGroup, UiTurnProgress } from '../types/codex'
import type { WorkspaceRootsState } from '../api/codexGateway'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  permanentlyDeleteThread: vi.fn(),
  forkThread: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAgentProgress: vi.fn(),
  getAgentResult: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModels: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadSummary: vi.fn(),
  getThreadHistoryDetail: vi.fn(),
  getOlderThreadHistoryPage: vi.fn(),
  getThreadTurnItemsPage: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getOlderThreadMessages: vi.fn(),
  getThreadModelPreferences: vi.fn(),
  getThreadRuntimeStates: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  normalizeAgentProgressSnapshot: vi.fn((value) => value),
  persistThreadTitle: vi.fn(),
  persistThreadModelPreference: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  setThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadWithTurn: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

function thread(
  id: string,
  cwd: string,
  options: { hasWorktree?: boolean; inProgress?: boolean; historyMode?: 'legacy' | 'paginated' } = {},
) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: options.inProgress ?? false,
    historyMode: options.historyMode ?? 'legacy',
  }
}

function modelCapabilities(
  ...entries: Array<string | {
    id: string
    supportedReasoningEfforts?: ReasoningEffort[]
    defaultReasoningEffort?: ReasoningEffort | null
    supportsFastMode?: boolean
  }>
): UiModelCapability[] {
  return entries.map((entry) => {
    const normalized = typeof entry === 'string' ? { id: entry } : entry
    return {
      id: normalized.id,
      displayName: normalized.id,
      supportedReasoningEfforts: normalized.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: normalized.defaultReasoningEffort ?? null,
      supportsFastMode: normalized.supportsFastMode ?? false,
    }
  })
}

function progressSnapshot(input: {
  threadId?: string
  turnId: string
  status: 'running' | 'completed' | 'interrupted'
  updatedAtMs: number
  childStatus?: 'running' | 'completed' | 'interrupted'
}): UiTurnProgress {
  const threadId = input.threadId ?? 'thread-a'
  const childStatus = input.childStatus ?? 'completed'
  return {
    rootThreadId: threadId,
    turnId: input.turnId,
    status: input.status,
    phase: input.status === 'running' ? 'reasoning' : input.status,
    startedAtMs: input.updatedAtMs - 2_000,
    lastActivityAtMs: input.updatedAtMs,
    mainLastActivityAtMs: input.updatedAtMs,
    updatedAtMs: input.updatedAtMs,
    agents: [{
      threadId: 'child-a',
      parentThreadId: threadId,
      path: '/root/child-a',
      nickname: '',
      depth: 1,
      taskSummary: '',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      status: childStatus,
      startedAtMs: input.updatedAtMs - 1_500,
      lastActivityAtMs: input.updatedAtMs,
      completedAtMs: childStatus === 'running' ? null : input.updatedAtMs,
      currentActivity: childStatus === 'running' ? 'working' : '',
      resultAvailable: childStatus === 'completed',
    }],
    events: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installTestWindow(initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.archiveThread.mockResolvedValue(undefined)
  gatewayMocks.permanentlyDeleteThread.mockResolvedValue(undefined)
  gatewayMocks.getThreadDetail.mockResolvedValue({
    model: '',
    modelProvider: '',
    messages: [],
    inProgress: false,
    activeTurnId: '',
    hasMoreOlder: false,
    turnIndexByTurnId: {},
  })
  gatewayMocks.getThreadSummary.mockImplementation(async (threadId: string) => thread(threadId, ''))
  gatewayMocks.getThreadHistoryDetail.mockImplementation(async (threadId: string, historyMode: 'legacy' | 'paginated') => {
    const detail = await gatewayMocks.getThreadDetail(threadId)
    return {
      ...detail,
      historyMode,
      turnIds: [],
      olderCursor: null,
      resumed: historyMode === 'paginated',
      materialized: historyMode === 'paginated',
    }
  })
  gatewayMocks.getOlderThreadHistoryPage.mockImplementation(async (
    threadId: string,
    options: { historyMode: 'legacy' | 'paginated'; beforeTurnId?: string; cursor?: string | null; limit?: number },
  ) => {
    const page = await gatewayMocks.getOlderThreadMessages(
      threadId,
      options.beforeTurnId ?? options.cursor ?? '',
      options.limit,
    )
    return {
      ...page,
      historyMode: options.historyMode,
      turnIds: [],
      olderCursor: null,
    }
  })
  gatewayMocks.getThreadTurnItemsPage.mockResolvedValue({ messages: [], nextCursor: null })
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadModelPreferences.mockResolvedValue({})
  gatewayMocks.getThreadRuntimeStates.mockResolvedValue([])
  gatewayMocks.getAgentProgress.mockResolvedValue(null)
  gatewayMocks.getAgentResult.mockResolvedValue({ threadId: '', text: '', truncated: false })
  gatewayMocks.normalizeAgentProgressSnapshot.mockImplementation((value) => value)
  gatewayMocks.persistThreadModelPreference.mockImplementation(async (_threadId, preference) => preference)
  gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('filterGroupsByWorkspaceRoots', () => {
  it('keeps projectless chats visible when workspace roots are configured', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Projectless',
        threads: [thread('projectless-chat', '')],
      },
      {
        projectName: 'allowed-project',
        threads: [thread('allowed-chat', '/tmp/allowed-project')],
      },
      {
        projectName: 'other-project',
        threads: [thread('other-chat', '/tmp/other-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/allowed-project'],
      labels: {},
      active: ['/tmp/allowed-project'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'Projectless',
      'allowed-project',
    ])
  })

  it('keeps workspace roots with the same folder name as separate projects', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'api',
        threads: [
          thread('first-api-chat', '/tmp/first/api'),
          thread('second-api-chat', '/tmp/second/api'),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {},
      active: ['/tmp/first/api', '/tmp/second/api'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      '/tmp/first/api',
      '/tmp/second/api',
    ])
  })

  it('uses Codex project-order when workspace roots are hydrated', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('alpha-chat', '/tmp/alpha')],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-chat', '/tmp/beta')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/beta', '/tmp/alpha'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'beta',
      'alpha',
    ])
  })

  it('keeps empty duplicate workspace roots visible in Codex project order', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'TestChat',
        threads: [thread('testchat-chat', '/Users/igor/temp/TestChat')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      labels: {},
      active: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      projectOrder: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['/Users/igor/Documents/New project 2/TestChat', 0],
      ['/Users/igor/temp/TestChat', 1],
    ])
  })

  it('keeps remote projects from Codex project order visible as empty project rows', () => {
    const groups: UiProjectGroup[] = []
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['remote-project-id', 0],
      ['local-project', 0],
    ])
  })

  it('keeps managed worktree threads under the matching workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['codex-web-local', ['main-chat', 'worktree-chat']],
    ])
  })

  it('keeps unregistered managed worktrees under the main root when another managed worktree root is registered', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('registered-worktree-chat', '/Users/igor/.codex/worktrees/a77f/codex-web-local', { hasWorktree: true }),
          thread('unregistered-worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: [
        '/Users/igor/Git-projects/codex-web-local',
        '/Users/igor/.codex/worktrees/a77f/codex-web-local',
      ],
      labels: {
        '/Users/igor/.codex/worktrees/a77f/codex-web-local': 'codex-web-local2',
      },
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat', 'unregistered-worktree-chat']],
      ['/Users/igor/.codex/worktrees/a77f/codex-web-local', ['registered-worktree-chat']],
    ])
  })

  it('does not group unrelated git worktrees under a same-leaf workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('other-git-worktree-chat', '/tmp/other/.git/worktrees/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat']],
    ])
  })
})

describe('removeThreadFromGroups', () => {
  it('removes an archived thread and drops the now-empty project group', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
      {
        projectName: 'archived-project',
        threads: [thread('archive-me', '/tmp/archived-project')],
      },
      {
        projectName: 'beta',
        threads: [thread('keep-beta', '/tmp/beta')],
      },
      {
        projectName: 'empty-workspace-root',
        threads: [],
      },
    ]

    expect(removeThreadFromGroups(groups, 'archive-me').map((group) => [
      group.projectName,
      group.threads.map((row) => row.id),
    ])).toEqual([
      ['alpha', ['keep-alpha']],
      ['beta', ['keep-beta']],
      ['empty-workspace-root', []],
    ])
  })

  it('preserves referential identity when the thread is absent', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
    ]

    expect(removeThreadFromGroups(groups, 'missing-thread')).toBe(groups)
  })
})

describe('workspace roots project persistence helpers', () => {
  it('collects duplicate-path project roots by full path when removing a project', () => {
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {
        '/tmp/first/api': 'First API',
        '/tmp/second/api': 'Second API',
      },
      active: ['/tmp/first/api'],
      projectOrder: ['/tmp/first/api', '/tmp/second/api'],
    }

    expect([...collectWorkspaceRootPathsForProjectRemoval(rootsState, '/tmp/first/api')]).toEqual([
      '/tmp/first/api',
    ])
  })

  it('preserves remote project ids in explicit project order when persisting workspace roots', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'local-project',
        threads: [thread('local-chat', '/tmp/local-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(buildWorkspaceRootsProjectOrderState(rootsState, ['remote-project-id', 'local-project'], groups)).toEqual({
      order: ['/tmp/local-project'],
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
    })
  })
})

describe('thread unread state helpers', () => {
  const cutoffIso = '2026-05-01T12:00:00.000Z'

  it('uses the initialization cutoff when a thread has no read state', () => {
    expect(isThreadUnreadByLastRead('2026-05-01T11:59:59.000Z', undefined, cutoffIso)).toBe(false)
    expect(isThreadUnreadByLastRead('2026-05-01T12:00:01.000Z', undefined, cutoffIso)).toBe(true)
  })

  it('uses per-thread read state instead of the global cutoff after a thread is read', () => {
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:30:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(false)
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:50:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(true)
  })
})

describe('collaboration mode selection', () => {
  it('can prime an empty selected thread without clearing persisted selection', () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
    })

    const state = useDesktopState()

    expect(state.selectedThreadId.value).toBe('thread-a')

    state.primeSelectedThread('', { persist: false })

    expect(state.selectedThreadId.value).toBe('')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('thread-a')
  })

  it('does not carry plan mode from new chats into existing threads', () => {
    installTestWindow({
      'codex-web-local.collaboration-mode.v1': 'plan',
    })

    const state = useDesktopState()

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')

    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(window.localStorage.getItem('codex-web-local.collaboration-mode-by-context.v1')).toBe(null)

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')
    state.primeSelectedThread('thread-b')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('plan')
  })
})

describe('immediate sent-message rendering', () => {
  it('reads a thread without resuming it and resumes only when the user sends', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-5.5', modelProvider: 'openai' })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-after-read')

    const state = useDesktopState()
    state.primeSelectedThread('thread-read-only')

    await state.loadMessages('thread-read-only')

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-read-only')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()

    await state.sendMessageToSelectedThread('start only now')

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-read-only')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.resumeThread.mock.invocationCallOrder[0]).toBeLessThan(
      gatewayMocks.startThreadTurn.mock.invocationCallOrder[0],
    )
  })

  it('shows an existing-thread user message and thinking state before start-turn resolves', async () => {
    installTestWindow()
    const startedTurn = deferred<string>()
    gatewayMocks.resumeThread.mockResolvedValue({ model: '', modelProvider: '' })
    gatewayMocks.startThreadTurn.mockReturnValue(startedTurn.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-immediate')
    const sendPromise = state.sendMessageToSelectedThread('show this now')

    await vi.waitFor(() => {
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    })
    expect(state.messages.value).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'show this now',
        messageType: 'userMessage.optimistic',
      }),
    ])
    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking activity',
      errorText: '',
    })

    startedTurn.resolve('turn-immediate')
    await sendPromise
  })

  it('reveals an optimistic message immediately while the selected thread is still loading', async () => {
    installTestWindow()
    const threadDetail = deferred<{
      messages: Array<{ id: string; role: 'assistant'; text: string; messageType: string }>
      inProgress: boolean
      activeTurnId: string
      turnIndexByTurnId: Record<string, number>
      hasMoreOlder: boolean
      model: string
      modelProvider: string
    }>()
    gatewayMocks.getThreadDetail.mockReturnValue(threadDetail.promise)
    gatewayMocks.resumeThread.mockResolvedValue({ model: '', modelProvider: '' })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-after-load')

    const state = useDesktopState()
    state.primeSelectedThread('thread-loading')
    const loadPromise = state.loadMessages('thread-loading')
    expect(state.isLoadingMessages.value).toBe(true)

    const sendPromise = state.sendMessageToSelectedThread('visible during load')
    await vi.waitFor(() => {
      expect(state.messages.value.some((message) => message.text === 'visible during load')).toBe(true)
    })
    expect(state.isLoadingMessages.value).toBe(false)
    expect(state.selectedLiveOverlay.value).toMatchObject({ activityLabel: 'Thinking activity' })

    threadDetail.resolve({
      messages: [{ id: 'assistant-old', role: 'assistant', text: 'Previous response', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    await Promise.all([loadPromise, sendPromise])
    expect(state.messages.value.filter((message) => message.text === 'visible during load')).toHaveLength(1)
  })

  it('replaces stale completed progress with a fresh thinking state on send', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'assistant-old', role: 'assistant', text: 'Previous response', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-5.5', modelProvider: 'openai' })
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      threadId: 'thread-completed-progress',
      turnId: 'turn-completed',
      status: 'completed',
      updatedAtMs: 1_000,
    }))
    const startedTurn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValue(startedTurn.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-completed-progress')
    await state.loadMessages('thread-completed-progress')
    await vi.waitFor(() => {
      expect(state.selectedLiveOverlay.value?.turnProgress?.status).toBe('completed')
    })

    const sendPromise = state.sendMessageToSelectedThread('start fresh')
    await vi.waitFor(() => {
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    })
    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking activity',
      turnProgress: null,
    })

    startedTurn.resolve('turn-fresh')
    await sendPromise
  })

  it('shows an in-progress steer message before the steer request resolves', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({ model: '', modelProvider: '' })
    const startedTurn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValue(startedTurn.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-steer')
    state.startPolling()
    notificationHandler({
      method: 'turn/started',
      params: { threadId: 'thread-steer', turn: { id: 'turn-running' } },
    })

    await state.sendMessageToSelectedThread('steer immediately', [], [], 'steer')

    expect(state.messages.value).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'steer immediately',
        messageType: 'userMessage.optimistic',
      }),
    ])
    startedTurn.resolve('turn-steer')
  })

  it('keeps queue-mode messages in the queue instead of the conversation', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-queue', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('thread-queue')
    await state.sendMessageToSelectedThread('queue only', [], [], 'queue')

    expect(state.messages.value).toEqual([])
    expect(state.selectedThreadQueuedMessages.value).toEqual([
      expect.objectContaining({ text: 'queue only' }),
    ])
  })

  it('shows a new-thread preview before thread creation resolves and transfers it once created', async () => {
    installTestWindow()
    const startedThread = deferred<{ threadId: string; model: string; modelProvider: string; turnId: string }>()
    gatewayMocks.startThreadWithTurn.mockReturnValue(startedThread.promise)

    const state = useDesktopState()
    const sendPromise = state.sendMessageToNewThread('new thread now', '/tmp/project')

    expect(state.pendingNewThreadMessages.value).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'new thread now',
        messageType: 'userMessage.optimistic',
      }),
    ])
    expect(state.pendingNewThreadLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking activity',
      errorText: '',
    })
    expect(state.selectedThreadId.value).toBe('')

    startedThread.resolve({
      threadId: 'created-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      turnId: 'turn-created',
    })
    await expect(sendPromise).resolves.toBe('created-thread')
    expect(state.selectedThreadId.value).toBe('created-thread')
    expect(state.messages.value.filter((message) => message.text === 'new thread now')).toHaveLength(1)

    state.clearPendingNewThreadPreview()
    expect(state.pendingNewThreadMessages.value).toEqual([])
    expect(state.pendingNewThreadLiveOverlay.value).toBeNull()
  })

  it('keeps the new-thread message visible with an error when creation fails', async () => {
    installTestWindow()
    gatewayMocks.startThreadWithTurn.mockRejectedValue(new Error('Thread creation failed'))

    const state = useDesktopState()
    await expect(state.sendMessageToNewThread('do not lose this', '/tmp/project')).rejects.toThrow('Thread creation failed')

    expect(state.pendingNewThreadMessages.value[0]).toMatchObject({ text: 'do not lose this' })
    expect(state.pendingNewThreadLiveOverlay.value).toMatchObject({ errorText: 'Thread creation failed' })
  })
})

describe('thread history loading races', () => {
  it('keeps the newest thread loading state and messages when an older load resolves first', async () => {
    installTestWindow()
    const firstDetail = deferred<{
      model: string
      modelProvider: string
      messages: Array<{ id: string; role: 'assistant'; text: string; messageType: string; turnId: string; turnIndex: number }>
      inProgress: boolean
      activeTurnId: string
      hasMoreOlder: boolean
      turnIndexByTurnId: Record<string, number>
    }>()
    const secondDetail = deferred<{
      model: string
      modelProvider: string
      messages: Array<{ id: string; role: 'assistant'; text: string; messageType: string; turnId: string; turnIndex: number }>
      inProgress: boolean
      activeTurnId: string
      hasMoreOlder: boolean
      turnIndexByTurnId: Record<string, number>
    }>()
    gatewayMocks.getThreadDetail.mockImplementation((threadId: string) => (
      threadId === 'thread-a' ? firstDetail.promise : secondDetail.promise
    ))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    const firstLoad = state.loadMessages('thread-a')
    state.primeSelectedThread('thread-b')
    const secondLoad = state.loadMessages('thread-b')

    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.isLoadingMessages.value).toBe(true)

    firstDetail.resolve({
      model: '',
      modelProvider: '',
      messages: [{
        id: 'assistant-a',
        role: 'assistant',
        text: 'older selection',
        messageType: 'agentMessage',
        turnId: 'turn-a',
        turnIndex: 0,
      }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-a': 0 },
    })
    await firstLoad

    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.messages.value).toEqual([])
    expect(state.isLoadingMessages.value).toBe(true)

    secondDetail.resolve({
      model: '',
      modelProvider: '',
      messages: [{
        id: 'assistant-b',
        role: 'assistant',
        text: 'newest selection',
        messageType: 'agentMessage',
        turnId: 'turn-b',
        turnIndex: 0,
      }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-b': 0 },
    })
    await secondLoad

    expect(state.isLoadingMessages.value).toBe(false)
    expect(state.messages.value.map((message) => message.text)).toEqual(['newest selection'])
  })

  it('ignores a stale thread selection failure after a newer thread succeeds', async () => {
    installTestWindow()
    const firstDetail = deferred<never>()
    const secondDetail = deferred<{
      model: string
      modelProvider: string
      messages: Array<{ id: string; role: 'assistant'; text: string; messageType: string; turnId: string; turnIndex: number }>
      inProgress: boolean
      activeTurnId: string
      hasMoreOlder: boolean
      turnIndexByTurnId: Record<string, number>
    }>()
    gatewayMocks.getThreadDetail.mockImplementation((threadId: string) => (
      threadId === 'thread-a' ? firstDetail.promise : secondDetail.promise
    ))
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5'))
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)

    const state = useDesktopState()
    const firstSelection = state.selectThread('thread-a')
    const secondSelection = state.selectThread('thread-b')

    secondDetail.resolve({
      model: '',
      modelProvider: '',
      messages: [{
        id: 'assistant-b',
        role: 'assistant',
        text: 'thread b',
        messageType: 'agentMessage',
        turnId: 'turn-b',
        turnIndex: 0,
      }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-b': 0 },
    })
    await expect(secondSelection).resolves.toBe('ok')

    firstDetail.reject(new Error('stale thread failed'))
    await expect(firstSelection).resolves.toBe('ok')

    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.messages.value.map((message) => message.text)).toEqual(['thread b'])
    expect(state.error.value).toBe('')
    expect(state.selectedLiveOverlay.value?.errorText ?? '').not.toContain('stale thread failed')
  })
})

describe('paginated thread history state', () => {
  function paginatedDetail(overrides: Record<string, unknown> = {}) {
    return {
      historyMode: 'paginated' as const,
      model: '',
      modelProvider: '',
      messages: [],
      turnIds: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      olderCursor: null,
      startTurnIndex: null,
      turnIndexByTurnId: {},
      resumed: true,
      materialized: true,
      ...overrides,
    }
  }

  function paginatedPage(overrides: Record<string, unknown> = {}) {
    return {
      historyMode: 'paginated' as const,
      messages: [],
      turnIds: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      olderCursor: null,
      startTurnIndex: null,
      turnIndexByTurnId: {},
      ...overrides,
    }
  }

  it('probes an unlisted direct-url thread without turns before choosing paginated history', async () => {
    installTestWindow()
    gatewayMocks.getThreadSummary.mockResolvedValue(thread('direct-paginated', '/tmp/project', { historyMode: 'paginated' }))
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{
        id: 'answer',
        role: 'assistant',
        text: 'loaded safely',
        messageType: 'agentMessage',
        turnId: 'turn-latest',
      }],
      turnIds: ['turn-latest'],
      hasMoreOlder: true,
      olderCursor: 'opaque:first',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('direct-paginated')
    await Promise.all([
      state.loadMessages('direct-paginated'),
      state.loadMessages('direct-paginated'),
    ])

    expect(gatewayMocks.getThreadSummary).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledWith('direct-paginated', 'paginated')
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(state.messages.value).toEqual([
      expect.objectContaining({ text: 'loaded safely', turnId: 'turn-latest' }),
    ])
    expect(state.hasMoreOlderMessages.value).toBe(true)
  })

  it('passes opaque older cursors once and deduplicates repeated page messages', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-older', '/tmp/project', { historyMode: 'paginated' })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'shared', role: 'assistant', text: 'latest', messageType: 'agentMessage', turnId: 'turn-2' }],
      turnIds: ['turn-2'],
      hasMoreOlder: true,
      olderCursor: 'opaque:/older?one',
    }))
    gatewayMocks.getOlderThreadHistoryPage.mockResolvedValue(paginatedPage({
      messages: [
        { id: 'older', role: 'assistant', text: 'older', messageType: 'agentMessage', turnId: 'turn-1' },
        { id: 'shared', role: 'assistant', text: 'latest', messageType: 'agentMessage', turnId: 'turn-2' },
      ],
      turnIds: ['turn-1', 'turn-2'],
      hasMoreOlder: true,
      olderCursor: 'opaque:/older?two',
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-older')
    await state.loadMessages('paginated-older')
    await Promise.all([
      state.loadOlderMessages('paginated-older'),
      state.loadOlderMessages('paginated-older'),
    ])

    expect(gatewayMocks.getOlderThreadHistoryPage).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getOlderThreadHistoryPage).toHaveBeenCalledWith('paginated-older', {
      historyMode: 'paginated',
      cursor: 'opaque:/older?one',
      beforeTurnId: '',
    })
    expect(state.messages.value.map((message) => `${message.turnId}:${message.id}`)).toEqual([
      'turn-1:older',
      'turn-2:shared',
    ])
  })

  it('does not resume an already materialized paginated thread before sending', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-send', '/tmp/project', { historyMode: 'paginated' })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail())
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-send')
    await state.loadMessages('paginated-send')
    await state.sendMessageToSelectedThread('continue paginated')

    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight paginated bootstrap before sending without a second resume', async () => {
    installTestWindow()
    const pendingDetail = deferred<ReturnType<typeof paginatedDetail>>()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-send-during-load', '/tmp/project', {
        historyMode: 'paginated',
      })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockReturnValue(pendingDetail.promise)
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-after-bootstrap')

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-send-during-load')
    const loadPromise = state.loadMessages('paginated-send-during-load')
    const sendPromise = state.sendMessageToSelectedThread('send while bootstrap is pending')

    await vi.waitFor(() => expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'send while bootstrap is pending', messageType: 'userMessage.optimistic' }),
    ])))
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()

    pendingDetail.resolve(paginatedDetail())
    await Promise.all([loadPromise, sendPromise])

    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('uses a mode-safe latest page to find the active paginated turn for interrupt', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-running', '/tmp/project', {
        historyMode: 'paginated',
        inProgress: true,
      })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({ inProgress: true }))
    gatewayMocks.getOlderThreadHistoryPage.mockResolvedValue(paginatedPage({
      inProgress: true,
      activeTurnId: 'turn-active',
      turnIds: ['turn-active'],
    }))
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-running')
    await state.loadMessages('paginated-running')
    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(gatewayMocks.getOlderThreadHistoryPage).toHaveBeenCalledWith('paginated-running', {
      historyMode: 'paginated',
      cursor: null,
    })
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('paginated-running', 'turn-active')
  })

  it('reconciles a completed turn once, preserves turn metadata, and skips a duplicate latest-page load', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const initialThread = thread('paginated-complete', '/tmp/project', { historyMode: 'paginated', inProgress: true })
    const refreshedThread = { ...initialThread, inProgress: false, updatedAtIso: '2026-04-28T00:00:02.000Z' }
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({ groups: [{ projectName: 'Project', threads: [initialThread] }], nextCursor: null })
      .mockResolvedValueOnce({ groups: [{ projectName: 'Project', threads: [refreshedThread] }], nextCursor: null })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [
        { id: 'old-item', role: 'assistant', text: 'old', messageType: 'agentMessage', turnId: 'turn-done' },
        { id: 'turn-done-error', role: 'system', text: 'keep metadata', messageType: 'turnError', turnId: 'turn-done' },
      ],
      turnIds: ['turn-done'],
      inProgress: true,
      activeTurnId: 'turn-done',
    }))
    gatewayMocks.getThreadTurnItemsPage.mockResolvedValue({
      messages: [{ id: 'final-item', role: 'assistant', text: 'final', messageType: 'agentMessage', turnId: 'turn-done' }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-complete')
    await state.loadMessages('paginated-complete')
    state.startPolling()
    notificationHandler!({
      method: 'turn/completed',
      params: { threadId: 'paginated-complete', turn: { id: 'turn-done', status: 'completed' } },
    })
    const eventSync = timers.find((timer) => timer.delay === 220)
    expect(eventSync).toBeDefined()
    eventSync?.callback()

    await vi.waitFor(() => expect(gatewayMocks.getThreadTurnItemsPage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(state.messages.value
      .filter((message) => message.messageType !== 'worked')
      .map((message) => message.id)).toEqual([
      'final-item',
      'turn-done-error',
    ]))
    expect(gatewayMocks.getOlderThreadHistoryPage).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1)
    state.stopPolling()
  })

  it('keeps the existing turn when thread/items/list is explicitly unsupported', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const initialThread = thread('paginated-unsupported', '/tmp/project', { historyMode: 'paginated', inProgress: true })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [{ ...initialThread, updatedAtIso: '2026-04-28T00:00:02.000Z' }] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'existing', role: 'assistant', text: 'must remain', messageType: 'agentMessage', turnId: 'turn-done' }],
      turnIds: ['turn-done'],
      inProgress: true,
      activeTurnId: 'turn-done',
    }))
    gatewayMocks.getThreadTurnItemsPage.mockResolvedValue(null)
    gatewayMocks.getOlderThreadHistoryPage.mockResolvedValue(paginatedPage({
      messages: [],
      turnIds: ['turn-done'],
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-unsupported')
    await state.loadMessages('paginated-unsupported')
    state.startPolling()
    notificationHandler!({
      method: 'turn/completed',
      params: { threadId: 'paginated-unsupported', turn: { id: 'turn-done', status: 'completed' } },
    })
    timers.find((timer) => timer.delay === 220)?.callback()

    await vi.waitFor(() => expect(gatewayMocks.getThreadTurnItemsPage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(gatewayMocks.getOlderThreadHistoryPage).toHaveBeenCalledTimes(1))
    expect(state.messages.value.filter((message) => message.messageType !== 'worked')).toEqual([
      expect.objectContaining({ id: 'existing', text: 'must remain', turnId: 'turn-done' }),
    ])
    state.stopPolling()
  })

  it('falls back once without applying a partial turn when four item pages still have a cursor', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-four-pages', '/tmp/project', {
        historyMode: 'paginated',
        inProgress: true,
      })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'existing', role: 'assistant', text: 'existing', messageType: 'agentMessage', turnId: 'turn-long' }],
      turnIds: ['turn-long'],
      inProgress: true,
      activeTurnId: 'turn-long',
    }))
    gatewayMocks.getThreadTurnItemsPage.mockImplementation(async (_threadId: string, _turnId: string, cursor: string | null) => {
      const pageIndex = cursor === null ? 1 : Number(cursor.slice(1))
      return {
        messages: Array.from({ length: 100 }, (_, itemIndex) => ({
          id: `partial-${pageIndex}-${itemIndex}`,
          role: 'assistant',
          text: `partial ${pageIndex}/${itemIndex}`,
          messageType: 'agentMessage',
          turnId: 'turn-long',
        })),
        nextCursor: `c${pageIndex + 1}`,
      }
    })
    gatewayMocks.getOlderThreadHistoryPage.mockResolvedValue(paginatedPage({
      messages: [{ id: 'final', role: 'assistant', text: 'final from latest page', messageType: 'agentMessage', turnId: 'turn-long' }],
      turnIds: ['turn-long'],
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-four-pages')
    await state.loadMessages('paginated-four-pages')
    state.startPolling()
    notificationHandler!({
      method: 'turn/completed',
      params: { threadId: 'paginated-four-pages', turn: { id: 'turn-long', status: 'completed' } },
    })
    timers.find((timer) => timer.delay === 220)?.callback()

    await vi.waitFor(() => expect(gatewayMocks.getThreadTurnItemsPage).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(gatewayMocks.getOlderThreadHistoryPage).toHaveBeenCalledTimes(1))
    expect(gatewayMocks.getThreadTurnItemsPage.mock.calls.map((call) => call[2])).toEqual([null, 'c2', 'c3', 'c4'])
    expect(state.messages.value.some((message) => message.id.startsWith('partial-'))).toBe(false)
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'existing' }),
      expect.objectContaining({ id: 'final' }),
    ]))
    state.stopPolling()
  })

  it('does not fetch a duplicate latest page after runtime reconciliation refreshes thread metadata', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const initialThread = thread('paginated-runtime', '/tmp/project', { historyMode: 'paginated', inProgress: true })
    const refreshedThread = { ...initialThread, inProgress: false, updatedAtIso: '2026-04-28T00:00:03.000Z' }
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({ groups: [{ projectName: 'Project', threads: [initialThread] }], nextCursor: null })
      .mockResolvedValueOnce({ groups: [{ projectName: 'Project', threads: [refreshedThread] }], nextCursor: null })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'before', role: 'assistant', text: 'before', messageType: 'agentMessage', turnId: 'turn-runtime' }],
      turnIds: ['turn-runtime'],
      inProgress: true,
      activeTurnId: 'turn-runtime',
    }))
    gatewayMocks.getThreadTurnItemsPage.mockResolvedValue({
      messages: [{ id: 'after', role: 'assistant', text: 'after', messageType: 'agentMessage', turnId: 'turn-runtime' }],
      nextCursor: null,
    })
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'paginated-runtime',
      turnId: 'turn-runtime',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: '2026-04-28T00:00:00.000Z',
      completedAtIso: '2026-04-28T00:00:02.000Z',
      owner: null,
    }])
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])

    const state = useDesktopState()
    try {
      await state.loadThreads()
      state.primeSelectedThread('paginated-runtime')
      await state.loadMessages('paginated-runtime')
      state.startPolling()
      timers.find((timer) => timer.delay === 0)?.callback()

      await vi.waitFor(() => expect(gatewayMocks.getThreadTurnItemsPage).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2))
      now = 4_000
      await state.loadMessages('paginated-runtime', { silent: true })

      expect(gatewayMocks.getThreadTurnItemsPage).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getOlderThreadHistoryPage).not.toHaveBeenCalled()
    } finally {
      state.stopPolling()
      nowSpy.mockRestore()
    }
  })

  it('blocks fork, rollback, and automatic fallback replay for paginated threads', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-actions', '/tmp/project', { historyMode: 'paginated' })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'user', role: 'user', text: 'old', messageType: 'userMessage', turnId: 'turn-old' }],
      turnIds: ['turn-old'],
    }))
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-failed')

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-actions')
    await state.loadMessages('paginated-actions')
    await expect(state.forkThreadById('paginated-actions')).resolves.toBe('')
    await state.rollbackSelectedThread('turn-old')
    await state.sendMessageToSelectedThread('trigger fallback guard')
    state.startPolling()
    notificationHandler!({
      method: 'error',
      params: {
        threadId: 'paginated-actions',
        turnId: 'turn-failed',
        message: 'model is not supported',
        willRetry: false,
      },
    })

    await vi.waitFor(() => expect(state.error.value).toContain('paginated thread'))
    expect(gatewayMocks.forkThread).not.toHaveBeenCalled()
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('retains live messages when another turn persists the same item id', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('paginated-identities', '/tmp/project', { historyMode: 'paginated' })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(paginatedDetail({
      messages: [{ id: 'shared-item', role: 'assistant', text: 'same text', messageType: 'agentMessage', turnId: 'turn-a' }],
      turnIds: ['turn-a'],
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('paginated-identities')
    state.startPolling()
    notificationHandler!({ method: 'turn/started', params: { threadId: 'paginated-identities', turn: { id: 'turn-b' } } })
    notificationHandler!({
      method: 'item/completed',
      params: {
        threadId: 'paginated-identities',
        turnId: 'turn-b',
        item: { id: 'shared-item', type: 'agentMessage', text: 'same text' },
      },
    })
    await state.loadMessages('paginated-identities', { force: true, silent: true })

    expect(state.messages.value.filter((message) => message.id === 'shared-item')).toEqual([
      expect.objectContaining({ turnId: 'turn-a', messageType: 'agentMessage' }),
      expect.objectContaining({ turnId: 'turn-b', messageType: 'agentMessage.live' }),
    ])
    state.stopPolling()
  })

  it('invalidates cached mode when thread/list changes historyMode', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [thread('mode-change', '/tmp/project')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [thread('mode-change', '/tmp/project', { historyMode: 'paginated' })] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadHistoryDetail.mockImplementation(async (_threadId: string, historyMode: 'legacy' | 'paginated') => ({
      ...paginatedDetail(),
      historyMode,
      resumed: historyMode === 'paginated',
      materialized: historyMode === 'paginated',
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('mode-change')
    await state.loadMessages('mode-change')
    await state.loadThreads({ force: true })
    await state.loadMessages('mode-change', { force: true })

    expect(state.projectGroups.value[0]?.threads[0]?.historyMode).toBe('paginated')
    expect(gatewayMocks.getThreadHistoryDetail.mock.calls.map((call) => call[1])).toEqual(['legacy', 'paginated'])
  })

  it('drops an unlisted thread mode probe cache when polling state resets', async () => {
    installTestWindow()
    gatewayMocks.getThreadSummary
      .mockResolvedValueOnce(thread('reset-mode', '/tmp/project', { historyMode: 'paginated' }))
      .mockResolvedValueOnce(thread('reset-mode', '/tmp/project'))
    gatewayMocks.getThreadHistoryDetail.mockImplementation(async (_threadId: string, historyMode: 'legacy' | 'paginated') => ({
      ...paginatedDetail(),
      historyMode,
      resumed: historyMode === 'paginated',
      materialized: historyMode === 'paginated',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('reset-mode')
    await state.loadMessages('reset-mode')
    state.stopPolling()
    await state.loadMessages('reset-mode', { force: true })

    expect(gatewayMocks.getThreadSummary).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getThreadHistoryDetail.mock.calls.map((call) => call[1])).toEqual(['paginated', 'legacy'])
  })

  it('ignores a stale history failure after polling state resets', async () => {
    installTestWindow()
    const pendingDetail = deferred<ReturnType<typeof paginatedDetail>>()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('reset-pending-load', '/tmp/project', {
        historyMode: 'paginated',
      })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockReturnValue(pendingDetail.promise)

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('reset-pending-load')
    const loadPromise = state.loadMessages('reset-pending-load')
    await vi.waitFor(() => expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1))
    state.stopPolling()
    pendingDetail.reject(new Error('stale failure after reset'))

    await expect(loadPromise).resolves.toBeUndefined()
    expect(state.error.value).toBe('')
    expect(state.selectedLiveOverlay.value?.errorText ?? '').not.toContain('stale failure after reset')
  })

  it('coalesces concurrent forced history refreshes for the same thread', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('forced-refresh', '/tmp/project')] }],
      nextCursor: null,
    })
    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('forced-refresh')
    await state.loadMessages('forced-refresh')

    const pendingRefresh = deferred<Record<string, unknown>>()
    gatewayMocks.getThreadHistoryDetail.mockClear()
    gatewayMocks.getThreadHistoryDetail.mockReturnValue(pendingRefresh.promise)
    const first = state.loadMessages('forced-refresh', { force: true, silent: true })
    const second = state.loadMessages('forced-refresh', { force: true, silent: true })

    await vi.waitFor(() => expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1))
    pendingRefresh.resolve({ ...paginatedDetail(), historyMode: 'legacy', resumed: false, materialized: false })
    await Promise.all([first, second])

    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(1)
  })

  it('bounds inactive history caches and keeps a recently revisited thread', async () => {
    installTestWindow()
    const threads = Array.from({ length: 22 }, (_, index) => thread(`cache-${index}`, '/tmp/project'))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockImplementation(async (threadId: string) => ({
      historyMode: 'legacy',
      model: '',
      modelProvider: '',
      messages: [{ id: `message-${threadId}`, role: 'assistant', text: threadId, messageType: 'agentMessage', turnId: `turn-${threadId}` }],
      turnIds: [`turn-${threadId}`],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      olderCursor: null,
      startTurnIndex: 0,
      turnIndexByTurnId: { [`turn-${threadId}`]: 0 },
      resumed: false,
      materialized: false,
    }))

    const state = useDesktopState()
    await state.loadThreads()
    for (let index = 0; index < 20; index += 1) {
      await state.loadMessages(`cache-${index}`)
    }
    await state.loadMessages('cache-0')
    await state.loadMessages('cache-20')
    await state.loadMessages('cache-21')
    const callsBeforeRevisit = gatewayMocks.getThreadHistoryDetail.mock.calls.length
    await state.loadMessages('cache-0')
    await state.loadMessages('cache-1')

    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(callsBeforeRevisit + 1)
    expect(gatewayMocks.getThreadHistoryDetail.mock.calls.filter((call) => call[0] === 'cache-0')).toHaveLength(1)
    expect(gatewayMocks.getThreadHistoryDetail.mock.calls.filter((call) => call[0] === 'cache-1')).toHaveLength(2)
  })

  it('enforces the history cache limit after concurrent protected loads settle', async () => {
    installTestWindow()
    const threads = Array.from({ length: 22 }, (_, index) => thread(`parallel-cache-${index}`, '/tmp/project'))
    const pendingByThreadId = new Map(threads.map((candidate) => [
      candidate.id,
      deferred<Record<string, unknown>>(),
    ]))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads }],
      nextCursor: null,
    })
    gatewayMocks.getThreadHistoryDetail.mockImplementation(async (threadId: string) => (
      await pendingByThreadId.get(threadId)!.promise
    ))

    const state = useDesktopState()
    await state.loadThreads()
    const loads = threads.map((candidate) => state.loadMessages(candidate.id))
    await vi.waitFor(() => expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(22))
    for (const candidate of threads) {
      pendingByThreadId.get(candidate.id)!.resolve({
        historyMode: 'legacy',
        model: '',
        modelProvider: '',
        messages: [{
          id: `message-${candidate.id}`,
          role: 'assistant',
          text: candidate.id,
          messageType: 'agentMessage',
          turnId: `turn-${candidate.id}`,
          turnIndex: 0,
        }],
        turnIds: [`turn-${candidate.id}`],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        olderCursor: null,
        startTurnIndex: 0,
        turnIndexByTurnId: { [`turn-${candidate.id}`]: 0 },
        resumed: false,
        materialized: false,
      })
    }
    await Promise.all(loads)

    const callsAfterSettle = gatewayMocks.getThreadHistoryDetail.mock.calls.length
    await state.loadMessages('parallel-cache-0')
    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(callsAfterSettle)
    await state.loadMessages('parallel-cache-1')
    expect(gatewayMocks.getThreadHistoryDetail).toHaveBeenCalledTimes(callsAfterSettle + 1)
  })
})

describe('Codex CLI availability', () => {
  it('surfaces a chat runtime error when the app-server bridge cannot find Codex CLI', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockRejectedValue(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })

    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  })

  it('clears a previous Codex CLI missing banner when a later refresh fails for another reason', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockRejectedValueOnce(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
      .mockRejectedValueOnce(new Error('Connection lost'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.error.value).toBe('Connection lost')
    expect(state.codexCliMissingError.value).toBe('')
  })

})

describe('startup request deduplication', () => {
  it('reloads cached thread titles on forced thread refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadTitleCache
      .mockResolvedValueOnce({ titles: {} })
      .mockResolvedValueOnce({ titles: { 'thread-1': 'Imported title' } })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('thread-1')

    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

    expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledTimes(2)
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('Imported title')
  })

  it('preserves server-reported in-progress state in sidebar thread groups', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-running', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })

    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
  })

  it('clears a preserved in-progress state when the server reports the thread is idle', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [thread('thread-running', '/tmp/project', { inProgress: true })] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [thread('thread-running', '/tmp/project', { inProgress: false })] }],
        nextCursor: null,
      })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)

    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
  })

  it('does not erase persisted queued messages when polling stops', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-running', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('thread-running')
    await state.sendMessageToSelectedThread('queued follow-up', [], [], 'queue')
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)

    gatewayMocks.setThreadQueueState.mockClear()
    state.stopPolling()

    expect(gatewayMocks.setThreadQueueState).not.toHaveBeenCalled()
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)
  })

  it('captures the thread model and reasoning effort in queued messages', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-running', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadModelPreferences.mockResolvedValue({
      'thread-running': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities({
      id: 'gpt-5.6-sol',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'xhigh',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-running')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToSelectedThread('queued follow-up', [], [], 'queue')

    expect(gatewayMocks.setThreadQueueState).toHaveBeenLastCalledWith({
      'thread-running': [expect.objectContaining({
        text: 'queued follow-up',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
      })],
    })
  })

  it('reuses a just-loaded thread list during startup refresh bursts', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      await state.refreshAll({ includeSelectedThreadMessages: false })

      expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'example',
        description: 'Example skill',
        path: '/tmp/project/.agents/skills/example/SKILL.md',
        scope: 'project',
        enabled: true,
      },
    ])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5'))

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getSkillsList).toHaveBeenCalledWith(['/tmp/project'])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded empty skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5'))

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(state.installedSkills.value).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('bypasses recent thread-list reuse for event-driven thread refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function' && delay !== 2_000 && delay !== 15_000) {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      const callsBeforeNotification = gatewayMocks.getThreadGroupsPage.mock.calls.length
      state.startPolling()
      expect(notificationHandler).toBeDefined()
      notificationHandler!({
        method: 'thread/name/updated',
        params: {
          threadId: 'thread-1',
          threadName: 'Updated title',
        },
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(callsBeforeNotification)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('live error overlay', () => {
  it('does not show an empty thinking card while live progress is still loading', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue(modelCapabilities())
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'create todo list app',
          messageType: 'userMessage',
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-thinking')
    await state.loadMessages('thread-thinking')

    expect(state.selectedLiveOverlay.value).toBeNull()
  })

  it('shows a localized activity overlay after a real turn activity event', () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])

    const state = useDesktopState()
    state.primeSelectedThread('thread-thinking')
    state.startPolling()
    notificationHandler({
      method: 'turn/started',
      params: { threadId: 'thread-thinking', turn: { id: 'turn-thinking' } },
    })

    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking activity',
      mainModelDetails: ['Model: default', 'Thinking: medium', 'Speed: Standard'],
      reasoningText: '',
      errorText: '',
    })
  })

  it('hides auto-retry notifications until Codex reports a final error', () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])

    const state = useDesktopState()
    state.primeSelectedThread('thread-retrying')
    state.startPolling()
    notificationHandler({
      method: 'turn/started',
      params: { threadId: 'thread-retrying', turn: { id: 'turn-retrying' } },
    })
    notificationHandler({
      method: 'error',
      params: {
        threadId: 'thread-retrying',
        turnId: 'turn-retrying',
        message: 'Reconnecting... 2/5',
        willRetry: true,
      },
    })

    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking activity',
      errorText: '',
    })
    expect(state.error.value).toBe('')

    notificationHandler({
      method: 'error',
      params: {
        threadId: 'thread-retrying',
        turnId: 'turn-retrying',
        message: 'Provider connection failed',
        willRetry: false,
      },
    })

    expect(state.selectedLiveOverlay.value?.errorText).toBe('Provider connection failed')
    expect(state.error.value).toBe('Provider connection failed')
  })

  it('keeps a new live error visible when an older persisted turn error exists', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue(modelCapabilities())
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'old-error',
          role: 'system',
          text: 'old persisted failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-errors')
    await state.loadMessages('thread-with-errors')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-errors',
        turnId: 'new-turn',
        turn: {
          id: 'new-turn',
          status: 'failed',
          error: { message: 'new live failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value?.errorText).toBe('new live failure')
  })

  it('suppresses a live error only after that same error has persisted', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue(modelCapabilities())
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'persisted-error',
          role: 'system',
          text: 'same failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-persisted-error')
    await state.loadMessages('thread-with-persisted-error')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-persisted-error',
        turnId: 'same-turn',
        turn: {
          id: 'same-turn',
          status: 'failed',
          error: { message: 'same failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value).toBe(null)
  })
})

describe('provider model selection', () => {
  it('sends Fast for a native Codex provider when the live model catalog allows it', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.6-terra',
      providerId: 'myproxy',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities({
      id: 'gpt-5.6-terra',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium',
      supportsFastMode: true,
    }))
    gatewayMocks.startThreadWithTurn.mockResolvedValue({
      threadId: 'fast-thread',
      model: 'gpt-5.6-terra',
      modelProvider: 'myproxy',
      turnId: 'turn-fast',
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.isFastModeSupportedForModel('gpt-5.6-terra')).toBe(true)
    await state.updateSelectedSpeedMode('fast')
    await state.sendMessageToNewThread('fast request', '/tmp/project')

    expect(gatewayMocks.setCodexSpeedMode).toHaveBeenCalledWith('fast')
    expect(gatewayMocks.startThreadWithTurn).toHaveBeenCalledWith(
      '/tmp/project',
      'fast request',
      [],
      'gpt-5.6-terra',
      'xhigh',
      undefined,
      [],
      'default',
      'fast',
    )
  })

  it('forces Standard mode for a model without a catalog Fast tier while allowing stale Fast configuration to be disabled', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: 'myproxy',
      reasoningEffort: 'xhigh',
      speedMode: 'fast',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities({
      id: 'gpt-5.4-mini',
      supportsFastMode: false,
    }))
    gatewayMocks.startThreadWithTurn.mockResolvedValue({
      threadId: 'standard-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'myproxy',
      turnId: 'turn-standard',
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.isFastModeSupportedForModel('gpt-5.4-mini')).toBe(false)
    await state.sendMessageToNewThread('standard request', '/tmp/project')
    expect(gatewayMocks.startThreadWithTurn).toHaveBeenCalledWith(
      '/tmp/project',
      'standard request',
      [],
      'gpt-5.4-mini',
      'xhigh',
      undefined,
      [],
      'default',
      null,
    )

    await state.updateSelectedSpeedMode('standard')
    expect(gatewayMocks.setCodexSpeedMode).toHaveBeenCalledWith('standard')
  })

  it('reuses a recently loaded model catalog for the same provider', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.6-sol',
      providerId: 'myproxy',
      reasoningEffort: 'low',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities({
      id: 'gpt-5.6-sol',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'low',
    }))

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getAvailableModels).toHaveBeenCalledTimes(1)
      expect(state.availableModelCapabilities.value['gpt-5.6-sol']?.supportedReasoningEfforts).toContain('ultra')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('uses model-specific reasoning efforts and falls back to the selected model default', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.6-sol',
      providerId: '',
      reasoningEffort: 'ultra',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'low',
      },
      {
        id: 'gpt-5.6-luna',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium',
      },
    ))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedReasoningEffort.value).toBe('ultra')
    expect(state.availableModelCapabilities.value['gpt-5.6-sol']?.supportedReasoningEfforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])

    state.setSelectedModelIdForThread('__new-thread__', 'gpt-5.6-luna')
    expect(state.selectedReasoningEffort.value).toBe('medium')
  })

  it('keeps model and reasoning preferences independent across threads', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [thread('thread-a', '/tmp/project'), thread('thread-b', '/tmp/project')],
      }],
      nextCursor: null,
    })
    gatewayMocks.getThreadModelPreferences.mockResolvedValue({
      'thread-a': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
      'thread-b': { model: 'gpt-5.6-luna', reasoningEffort: 'high' },
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'xhigh',
      },
      {
        id: 'gpt-5.6-luna',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'high',
      },
      'gpt-5.5',
    ))
    gatewayMocks.resumeThread.mockImplementation(async (threadId: string) => ({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      threadId,
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(state.selectedReasoningEffort.value).toBe('max')

    const modelWrite = state.updateSelectedModelIdForThread('thread-a', 'gpt-5.6-luna')
    const reasoningWrite = state.updateSelectedReasoningEffort('ultra')
    await Promise.all([modelWrite, reasoningWrite])

    await expect(state.selectThread('thread-b')).resolves.toBe('ok')
    expect(state.selectedModelId.value).toBe('gpt-5.6-luna')
    expect(state.selectedReasoningEffort.value).toBe('high')

    await expect(state.selectThread('thread-a')).resolves.toBe('ok')
    expect(state.selectedModelId.value).toBe('gpt-5.6-luna')
    expect(state.selectedReasoningEffort.value).toBe('ultra')
    expect(gatewayMocks.persistThreadModelPreference.mock.calls.slice(-2)).toEqual([
      ['thread-a', { model: 'gpt-5.6-luna', reasoningEffort: 'max' }],
      ['thread-a', { model: 'gpt-5.6-luna', reasoningEffort: 'ultra' }],
    ])
  })

  it('restores server preferences in a fresh browser state despite changed CLI and thread defaults', async () => {
    installTestWindow()
    const persisted = {
      'thread-a': { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' as ReasoningEffort },
    }
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadModelPreferences.mockImplementation(async () => structuredClone(persisted))
    gatewayMocks.persistThreadModelPreference.mockImplementation(async (threadId: string, preference: typeof persisted['thread-a']) => {
      persisted[threadId as 'thread-a'] = { ...preference }
      return preference
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'xhigh',
      },
      'gpt-5.5',
    ))
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'low',
      speedMode: 'standard',
    })

    const firstState = useDesktopState()
    firstState.primeSelectedThread('thread-a')
    await firstState.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
    await firstState.updateSelectedReasoningEffort('max')
    expect(persisted['thread-a']).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'max' })

    installTestWindow()
    const restartedState = useDesktopState()
    restartedState.primeSelectedThread('thread-a')
    await restartedState.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(restartedState.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(restartedState.selectedReasoningEffort.value).toBe('max')
  })

  it('migrates an existing browser-scoped thread model before backend hydration can overwrite it', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'gpt-5.6-sol',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadModelPreferences.mockResolvedValue({})
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5', 'gpt-5.6-sol'))
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(state.selectedReasoningEffort.value).toBe('xhigh')
    await vi.waitFor(() => {
      expect(gatewayMocks.persistThreadModelPreference).toHaveBeenCalledWith('thread-a', {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
      })
    })
  })

  it('keeps a persisted thread model even when a refreshed catalog temporarily omits it', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadModelPreferences.mockResolvedValue({
      'thread-a': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5'))
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(state.selectedReasoningEffort.value).toBe('max')
    expect(state.availableModelIds.value).toContain('gpt-5.6-sol')
    expect(gatewayMocks.persistThreadModelPreference).not.toHaveBeenCalled()
  })

  it('ignores global selected-model localStorage when a custom Codex provider is active', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread__': 'gpt-5.5',
      }),
      'codex-web-local.selected-model-id.v1': 'gpt-5.5',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'proxy-default',
      providerId: 'myproxy',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      'proxy-default',
      'proxy-reasoning',
      'proxy-fast',
    ))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModels).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'myproxy',
    })
    expect(state.availableModelIds.value).toEqual([
      'proxy-default',
      'proxy-reasoning',
      'proxy-fast',
    ])
    expect(state.selectedModelId.value).toBe('proxy-default')
    expect(state.readModelIdForThread('').trim()).toBe('proxy-default')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({})
    expect(window.localStorage.getItem('codex-web-local.selected-model-id.v1')).toBe(null)
  })

  it('uses the CLI default instead of a stale provider-scoped new-thread model', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::myproxy': 'proxy-fast',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'proxy-default',
      providerId: 'myproxy',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      'proxy-default',
      'proxy-reasoning',
      'proxy-fast',
    ))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'proxy-default',
      'proxy-reasoning',
      'proxy-fast',
    ])
    expect(state.selectedModelId.value).toBe('proxy-default')
    expect(state.readModelIdForThread('').trim()).toBe('proxy-default')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({})
  })

  it('clears stale provider-scoped defaults for the new-thread composer', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::unused-provider': 'unused-model',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      'gpt-5.5',
      'gpt-5.4-mini',
    ))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({})
  })

  it('drops stale non-Codex selected models from the Codex model list', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::codex': 'proxy-default',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      'gpt-5.5',
      'gpt-5.4-mini',
    ))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])
    expect(state.availableModelIds.value).not.toContain('proxy-default')
    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({})
  })

  it('keeps an existing provider-backed thread scoped to its provider models', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('provider-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'myproxy') {
        return modelCapabilities('proxy-default', 'proxy-fast')
      }
      return modelCapabilities('gpt-5.5', 'gpt-5.4-mini')
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'proxy-default',
      modelProvider: 'myproxy',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('provider-thread')
    await state.loadMessages('provider-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModels).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'myproxy',
    })
    expect(state.availableModelIds.value).toEqual([
      'proxy-default',
      'proxy-fast',
    ])
    expect(state.selectedModelId.value).toBe('proxy-default')
    expect(state.readModelIdForThread('provider-thread')).toBe('proxy-default')
    expect(state.readModelIdForThread('')).toBe('gpt-5.4-mini')
  })

  it('loads provider models for a selected provider-backed thread during scheduled refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function' && delay !== 2_000 && delay !== 15_000) {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('provider-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'myproxy') {
        return modelCapabilities('proxy-default', 'proxy-fast')
      }
      return modelCapabilities('gpt-5.5', 'gpt-5.4-mini')
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'proxy-default',
      modelProvider: 'myproxy',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('provider-thread')
    await state.loadMessages('provider-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

    expect(gatewayMocks.getAvailableModels).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'myproxy',
    })
    expect(state.availableModelIds.value).toEqual(['proxy-default', 'proxy-fast'])
    expect(state.selectedModelId.value).toBe('proxy-default')
  })

  it('captures the active provider when creating a new thread', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5', 'gpt-5.4-mini'))
    gatewayMocks.startThreadWithTurn.mockResolvedValue({
      threadId: 'codex-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      turnId: 'turn-1',
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')

    expect(gatewayMocks.startThreadWithTurn).toHaveBeenCalledWith(
      '/tmp/project',
      'hi',
      [],
      'gpt-5.5',
      'medium',
      undefined,
      [],
      'default',
      null,
    )
    expect(gatewayMocks.startThread).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.readModelIdForThread('codex-thread')).toBe('gpt-5.5')
    await vi.waitFor(() => {
      expect(gatewayMocks.persistThreadModelPreference).toHaveBeenCalledWith('codex-thread', {
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
      })
    })
    expect(state.messages.value.some((message) => (
      message.role === 'user' &&
      message.text === 'hi' &&
      message.messageType === 'userMessage.optimistic'
    ))).toBe(true)

    const modelConfigCallsBeforeLoad = gatewayMocks.getCurrentModelConfig.mock.calls.length
    const availableModelCallsBeforeLoad = gatewayMocks.getAvailableModels.mock.calls.length
    await state.loadMessages('codex-thread')
    expect(gatewayMocks.getCurrentModelConfig).toHaveBeenCalledTimes(modelConfigCallsBeforeLoad)
    expect(gatewayMocks.getAvailableModels).toHaveBeenCalledTimes(availableModelCallsBeforeLoad)
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'assistant:Hi.',
    ])
  })

  it('persists a manually selected new-thread combination and resets the next draft to CLI defaults', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities(
      'gpt-5.5',
      {
        id: 'gpt-5.6-sol',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'xhigh',
      },
    ))
    gatewayMocks.startThreadWithTurn.mockResolvedValue({
      threadId: 'custom-thread',
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      turnId: 'turn-1',
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.updateSelectedModelIdForThread('__new-thread__', 'gpt-5.6-sol')
    await state.updateSelectedReasoningEffort('max')
    expect(gatewayMocks.persistThreadModelPreference).not.toHaveBeenCalled()

    await state.sendMessageToNewThread('use custom settings', '/tmp/project')
    expect(gatewayMocks.startThreadWithTurn).toHaveBeenCalledWith(
      '/tmp/project',
      'use custom settings',
      [],
      'gpt-5.6-sol',
      'max',
      undefined,
      [],
      'default',
      null,
    )
    await vi.waitFor(() => {
      expect(gatewayMocks.persistThreadModelPreference).toHaveBeenCalledWith('custom-thread', {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
      })
    })

    state.primeSelectedThread('')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.selectedReasoningEffort.value).toBe('medium')
  })

  it('refreshes a loaded optimistic thread when completion events arrive', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function' && delay !== 2_000 && delay !== 15_000) {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5', 'gpt-5.4-mini'))
    gatewayMocks.startThreadWithTurn.mockResolvedValue({
      threadId: 'mini-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
      turnId: 'turn-1',
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'hi',
          messageType: 'userMessage',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')
    state.startPolling()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/completed',
      params: {
        threadId: 'mini-thread',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('mini-thread')
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'system:Worked for <1s',
      'assistant:Hi.',
    ])
  })

  it('surfaces selected thread load failures and still refreshes models', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModels.mockResolvedValue(modelCapabilities('gpt-5.5', 'gpt-5.4-mini'))
    gatewayMocks.getThreadDetail.mockRejectedValue(new Error('thread not found'))

    const state = useDesktopState()
    state.primeSelectedThread('missing-thread')
    await state.refreshAll({
      includeSelectedThreadMessages: true,
      awaitAncillaryRefreshes: true,
    })

    expect(state.selectedLiveOverlay.value?.errorText).toContain('thread not found')
    expect(state.availableModelIds.value).toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(state.selectedModelId.value).toBe('gpt-5.5')

    await state.ensureThreadMessagesLoaded('missing-thread', { silent: true })
    await state.loadMessages('missing-thread')
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  })
})

describe('findAdjacentThreadId', () => {
  it('selects the next thread after the archived thread', () => {
    const threads = [
      thread('first-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
      thread('next-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('next-thread')
  })

  it('falls back to the previous thread when the last thread is archived', () => {
    const threads = [
      thread('previous-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('previous-thread')
  })

  it('returns no fallback when there is no adjacent thread', () => {
    expect(findAdjacentThreadId([thread('selected-thread', '/tmp/project')], 'selected-thread')).toBe('')
  })
})

describe('permanent thread deletion', () => {
  it('deletes directly without archiving and selects the adjacent thread after success', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockReset().mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [
          thread('first-thread', '/tmp/project'),
          thread('delete-me', '/tmp/project'),
          thread('next-thread', '/tmp/project'),
        ],
      }],
      nextCursor: null,
    })
    let resolveDelete!: () => void
    gatewayMocks.permanentlyDeleteThread.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDelete = resolve
    }))
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('first-thread')

    const deletion = state.permanentlyDeleteThreadById('delete-me')
    state.primeSelectedThread('delete-me')
    resolveDelete()
    const deleted = await deletion

    expect(deleted).toBe(true)
    expect(gatewayMocks.permanentlyDeleteThread).toHaveBeenCalledOnce()
    expect(gatewayMocks.permanentlyDeleteThread).toHaveBeenCalledWith('delete-me')
    expect(gatewayMocks.archiveThread).not.toHaveBeenCalled()
    expect(state.projectGroups.value.flatMap((group) => group.threads.map((row) => row.id))).toEqual([
      'first-thread',
      'next-thread',
    ])
    expect(state.selectedThreadId.value).toBe('next-thread')
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledOnce()
  })

  it('keeps the thread and current selection when permanent deletion fails', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockReset().mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [
          thread('keep-thread', '/tmp/project'),
          thread('delete-me', '/tmp/project'),
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.permanentlyDeleteThread.mockRejectedValueOnce(new Error('delete failed'))

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('delete-me')

    const deleted = await state.permanentlyDeleteThreadById('delete-me')

    expect(deleted).toBe(false)
    expect(gatewayMocks.archiveThread).not.toHaveBeenCalled()
    expect(state.projectGroups.value.flatMap((group) => group.threads.map((row) => row.id))).toEqual([
      'keep-thread',
      'delete-me',
    ])
    expect(state.selectedThreadId.value).toBe('delete-me')
    expect(state.error.value).toBe('delete failed')
  })
})

describe('live output bounds', () => {
  it('keeps UTF-8 output within the configured byte ceiling', () => {
    const result = capUtf8Tail('你好世界hello', 10)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(10)
    expect(result.endsWith('hello')).toBe(true)
  })
})

describe('notification recovery', () => {
  it('keeps live deltas for a background thread when switching back', async () => {
    vi.useFakeTimers()
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue(modelCapabilities())
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-a',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-b')
    state.startPolling()
    notificationHandler!({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-a', itemId: 'agent-a', delta: 'background text' },
    })
    await vi.advanceTimersByTimeAsync(180)

    state.primeSelectedThread('thread-a')
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-a', text: 'background text' }),
    ]))
  })

  it('batches agent message deltas before updating reactive message state', async () => {
    vi.useFakeTimers()
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', itemId: 'agent-a', delta: 'hello ' } })
    notificationHandler!({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', itemId: 'agent-a', delta: 'world' } })

    expect(state.messages.value).toEqual([])
    await vi.advanceTimersByTimeAsync(179)
    expect(state.messages.value).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-a', text: 'hello world' }),
    ]))
  })

  it('batches reasoning and command output deltas in the same flush window', async () => {
    vi.useFakeTimers()
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    notificationHandler!({ method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'reason-a', type: 'reasoning' } } })
    notificationHandler!({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-a', itemId: 'reason-a', delta: 'deep ' } })
    notificationHandler!({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-a', itemId: 'reason-a', delta: 'thought' } })
    notificationHandler!({
      method: 'item/started',
      params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'command-a', type: 'commandExecution', command: 'printf test' } },
    })
    notificationHandler!({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-a', itemId: 'command-a', delta: 'one ' } })
    notificationHandler!({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-a', itemId: 'command-a', delta: 'two' } })

    expect(state.selectedLiveOverlay.value?.reasoningText).toBe('')
    expect(state.messages.value.find((message) => message.id === 'command-a')?.commandExecution?.aggregatedOutput).toBe('')
    await vi.advanceTimersByTimeAsync(180)
    expect(state.selectedLiveOverlay.value?.reasoningText).toBe('deep thought')
    expect(state.messages.value.find((message) => message.id === 'command-a')?.commandExecution?.aggregatedOutput).toBe('one two')
  })

  it('stores six-agent progress notifications, connection state, and lazy results', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getAgentResult.mockResolvedValue({ threadId: 'child-1', text: 'child result', truncated: false })

    const agents = Array.from({ length: 6 }, (_, index) => ({
      threadId: `child-${index + 1}`,
      parentThreadId: index === 5 ? 'child-1' : 'thread-a',
      path: `/root/child-${index + 1}`,
      nickname: index === 0 ? 'Darwin' : '',
      depth: index === 5 ? 2 : 1,
      taskSummary: `task ${index + 1}`,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      status: index === 0 ? 'completed' : 'running',
      startedAtMs: 1_000 + index,
      lastActivityAtMs: 2_000 + index,
      completedAtMs: index === 0 ? 3_000 : null,
      currentActivity: index === 0 ? '' : 'working',
      resultAvailable: index === 0,
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({ method: 'connection/status', params: { status: 'connected' } })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: {
        threadId: 'thread-a',
        progress: {
          rootThreadId: 'thread-a',
          turnId: 'turn-a',
          status: 'running',
          phase: 'waitingForAgents',
          startedAtMs: 1_000,
          lastActivityAtMs: 2_000,
          mainLastActivityAtMs: 1_800,
          updatedAtMs: 2_000,
          agents,
          events: [],
        },
      },
    })

    expect(state.selectedLiveOverlay.value).toMatchObject({
      connectionState: 'connected',
      turnProgress: {
        phase: 'waitingForAgents',
        agents: expect.arrayContaining([
          expect.objectContaining({ threadId: 'child-6', parentThreadId: 'child-1', depth: 2 }),
        ]),
      },
    })

    await state.loadAgentResult('child-1')
    expect(state.selectedLiveOverlay.value?.turnProgress?.agents[0]).toMatchObject({
      resultText: 'child result',
      resultLoading: false,
    })

    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toBeNull()
  })

  it('lets a later overlapping completion correct an interrupted root without rewriting its child', () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: {
        threadId: 'thread-a',
        progress: {
          ...progressSnapshot({ turnId: 'turn-b', status: 'interrupted', updatedAtMs: 5_000, childStatus: 'interrupted' }),
          mainLastActivityAtMs: 2_000,
        },
      },
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(4_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed', completedAt: new Date(4_000).toISOString() } },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-a',
      status: 'completed',
      phase: 'completed',
      agents: [{ threadId: 'child-a', status: 'interrupted' }],
    })

    notificationHandler!({
      method: 'turn/started',
      atIso: new Date(6_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
    })
    notificationHandler!({
      method: 'turn/started',
      atIso: new Date(7_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'inProgress' } },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-a',
      status: 'completed',
      phase: 'completed',
    })
  })

  it('does not let an older overlapping completion stop the active turn', () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    notificationHandler!({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } }, atIso: new Date(1_000).toISOString() })
    notificationHandler!({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-b' } }, atIso: new Date(2_000).toISOString() })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'running', updatedAtMs: 2_500, childStatus: 'running' }) },
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(3_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed', completedAt: new Date(3_000).toISOString() } },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'reasoning' })
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking activity')

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: '', status: 'interrupted', updatedAtMs: 3_500, childStatus: 'interrupted' }) },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'preparing' })
  })

  it('does not let a delayed interrupted snapshot downgrade a completed turn', () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'running', updatedAtMs: 3_000 }) },
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(4_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'completed', completedAt: new Date(4_000).toISOString() } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'interrupted', updatedAtMs: 5_000, childStatus: 'interrupted' }) },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-b',
      status: 'completed',
      phase: 'completed',
      agents: [{ threadId: 'child-a', status: 'completed' }],
    })
  })

  it('skips duplicate initial-ready history and forces the selected thread when replay is unavailable', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue(modelCapabilities())
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-a',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: true })
    const callsBeforeInitialReady = gatewayMocks.getThreadDetail.mock.calls.length
    const pendingRequestsBeforeInitialReady = gatewayMocks.getPendingServerRequests.mock.calls.length
    state.startPolling()
    notificationHandler!({
      method: 'ready',
      params: { replayAvailable: true, streamChanged: false },
    })
    await vi.waitFor(() => {
      expect(gatewayMocks.getPendingServerRequests.mock.calls.length).toBeGreaterThan(pendingRequestsBeforeInitialReady)
    })
    expect(gatewayMocks.getThreadDetail.mock.calls.length).toBe(callsBeforeInitialReady)
    const callsBeforeReconnect = gatewayMocks.getThreadDetail.mock.calls.length
    notificationHandler!({
      method: 'ready',
      params: { replayAvailable: false, streamChanged: true },
    })
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadDetail.mock.calls.length).toBeGreaterThan(callsBeforeReconnect)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledWith('thread-a')
    })
  })

  it('reuses a selected thread history request that is pending when initial readiness arrives', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-pending', '/tmp/project')] }],
      nextCursor: null,
    })
    const pendingDetail = deferred<{
      messages: []
      inProgress: boolean
      activeTurnId: string
      turnIndexByTurnId: Record<string, number>
      hasMoreOlder: boolean
    }>()
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-pending')
    const initialLoad = state.loadMessages('thread-pending')
    state.startPolling()
    const pendingRequestsBeforeReady = gatewayMocks.getPendingServerRequests.mock.calls.length
    notificationHandler!({ method: 'ready', params: { replayAvailable: true, streamChanged: false } })

    await vi.waitFor(() => {
      expect(gatewayMocks.getPendingServerRequests.mock.calls.length).toBeGreaterThan(pendingRequestsBeforeReady)
    })
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    pendingDetail.resolve({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    await initialLoad
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
  })

  it('does not hydrate unseen background running threads on initial notification readiness', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [
          thread('selected-thread', '/tmp/project'),
          thread('background-running', '/tmp/project', { inProgress: true }),
        ],
      }],
      nextCursor: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('selected-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true })
    const selectedCalls = gatewayMocks.getThreadDetail.mock.calls.filter((call) => call[0] === 'selected-thread').length
    const pendingRequestsBeforeReady = gatewayMocks.getPendingServerRequests.mock.calls.length
    state.startPolling()
    notificationHandler!({ method: 'ready', params: { replayAvailable: true, streamChanged: false } })
    await vi.waitFor(() => {
      expect(gatewayMocks.getPendingServerRequests.mock.calls.length).toBeGreaterThan(pendingRequestsBeforeReady)
    })

    expect(gatewayMocks.getThreadDetail.mock.calls.filter((call) => call[0] === 'selected-thread')).toHaveLength(selectedCalls)
    expect(gatewayMocks.getThreadDetail.mock.calls.some((call) => call[0] === 'background-running')).toBe(false)
  })
})

describe('authoritative thread runtime reconciliation', () => {
  it('repairs interrupted progress once and does not rehydrate on repeated completed polls', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'final', role: 'assistant', text: 'done', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    const completedRuntime = {
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed' as const,
      isRunning: false,
      source: 'session' as const,
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
      owner: null,
    }
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([completedRuntime])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-a',
      status: 'completed',
      updatedAtMs: 1_700_000_004_000,
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'interrupted', updatedAtMs: 1_700_000_003_000, childStatus: 'interrupted' }) },
    })

    const firstPoll = timers.find((timer) => timer.delay === 0)
    expect(firstPoll).toBeDefined()
    firstPoll?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
        status: 'completed',
        agents: [{ status: 'completed' }],
      })
    })
    await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalled())
    const requestCountsAfterRepair = {
      progress: gatewayMocks.getAgentProgress.mock.calls.length,
      detail: gatewayMocks.getThreadDetail.mock.calls.length,
      groups: gatewayMocks.getThreadGroupsPage.mock.calls.length,
      pending: gatewayMocks.getPendingServerRequests.mock.calls.length,
    }

    const secondPoll = timers.find((timer) => timer.delay === 15_000)
    expect(secondPoll).toBeDefined()
    secondPoll?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(requestCountsAfterRepair.progress)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(requestCountsAfterRepair.detail)
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(requestCountsAfterRepair.groups)
    expect(gatewayMocks.getPendingServerRequests).toHaveBeenCalledTimes(requestCountsAfterRepair.pending)
    state.stopPolling()
  })

  it('replaces an old terminal card when runtime reports a different fresh turn', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_005_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-b',
      status: 'running',
      updatedAtMs: 1_700_000_006_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'completed', updatedAtMs: 1_700_000_007_000 }) },
    })
    timers.find((timer) => timer.delay === 0)?.callback()

    await vi.waitFor(() => {
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledWith('thread-a')
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    })
    state.stopPolling()
  })

  it('rejects a stale progress snapshot after runtime switches to a newer turn', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_005_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-a',
      status: 'running',
      updatedAtMs: 1_700_000_006_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'completed', updatedAtMs: 1_700_000_004_000 }) },
    })
    timers.find((timer) => timer.delay === 0)?.callback()

    try {
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledWith('thread-a'))
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(state.selectedLiveOverlay.value?.turnProgress?.turnId).not.toBe('turn-a')

      notificationHandler!({
        method: 'codex-ui/agent-progress',
        params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'running', updatedAtMs: 1_700_000_007_000, childStatus: 'running' }) },
      })
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    } finally {
      state.stopPolling()
    }
  })

  it('rejects a stale running snapshot for a runtime-confirmed terminal turn', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
      owner: null,
    }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 15_000)).toBe(true)
    })

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'running', updatedAtMs: 1_700_000_005_000, childStatus: 'running' }) },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress ?? null).toBeNull()

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: '', status: 'running', updatedAtMs: 1_700_000_003_000, childStatus: 'running' }) },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress ?? null).toBeNull()

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: '', status: 'running', updatedAtMs: 1_700_000_005_000, childStatus: 'running' }) },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: '', status: 'running' })
    state.stopPolling()
  })

  it('keeps timestamp ordering while a local active turn still has a pending id', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'pending:local-turn',
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    await state.loadMessages('thread-a')
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'running', updatedAtMs: 7_000, childStatus: 'running' }) },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'running', updatedAtMs: 6_000, childStatus: 'running' }) },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })

    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-c', status: 'running', updatedAtMs: 8_000, childStatus: 'running' }) },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-c', status: 'running' })
    state.stopPolling()
  })

  it('replaces a terminal card with no turn identity when runtime reports a fresh turn', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_005_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-b',
      status: 'running',
      updatedAtMs: 1_700_000_006_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: '', status: 'completed', updatedAtMs: 1_700_000_004_000 }) },
    })
    timers.find((timer) => timer.delay === 0)?.callback()

    await vi.waitFor(() => {
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    })
    state.stopPolling()
  })

  it('ignores an old terminal runtime response after a different active turn starts', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let resolveRuntime!: (states: Array<{
      threadId: string
      turnId: string
      state: 'completed'
      isRunning: false
      source: 'session'
      startedAtIso: string
      completedAtIso: string
      owner: null
    }>) => void
    gatewayMocks.getThreadRuntimeStates.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRuntime = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1))
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
    })
    resolveRuntime([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
      owner: null,
    }])

    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking activity')
    state.stopPolling()
  })

  it('keeps a fresh runtime owner when another overlapping turn completes', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_002_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 2_000)).toBe(true)
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'interrupted', updatedAtMs: 1_700_000_003_000, childStatus: 'interrupted' }) },
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(1_700_000_004_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed', completedAt: new Date(1_700_000_004_000).toISOString() } },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking activity')
    state.stopPolling()
  })

  it('does not revive a completed turn from its own stale running runtime cache', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'final', role: 'assistant', text: 'done', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 2_000)).toBe(true)
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(1_700_000_004_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'completed', completedAt: new Date(1_700_000_004_000).toISOString() } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'completed', updatedAtMs: 1_700_000_004_000 }) },
    })

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'completed' })
    await state.loadMessages('thread-a', { force: true, silent: true })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'completed' })
    state.stopPolling()
  })

  it('ignores a running response that started before the same turn completed', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let resolveRuntime!: (states: Array<{
      threadId: string
      turnId: string
      state: 'running'
      isRunning: true
      source: 'external'
      startedAtIso: string
      completedAtIso: null
      owner: null
    }>) => void
    gatewayMocks.getThreadRuntimeStates.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRuntime = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    const initialPollIndex = timers.findIndex((timer) => timer.delay === 0)
    timers.splice(initialPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1))
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'inProgress' } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'running', updatedAtMs: 1_700_000_002_000, childStatus: 'running' }) },
    })
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(1_700_000_004_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed', completedAt: new Date(1_700_000_004_000).toISOString() } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'completed', updatedAtMs: 1_700_000_004_000 }) },
    })

    resolveRuntime([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-a', status: 'completed' })
    state.stopPolling()
  })

  it('does not let a running response started before a successful interrupt revive the turn', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    let resolveRuntime!: (states: Array<{
      threadId: string
      turnId: string
      state: 'running'
      isRunning: true
      source: 'external'
      startedAtIso: string
      completedAtIso: null
      owner: null
    }>) => void
    gatewayMocks.getThreadRuntimeStates.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRuntime = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'inProgress' } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'running', updatedAtMs: 1_700_000_002_000, childStatus: 'running' }) },
    })
    const initialPollIndex = timers.findIndex((timer) => timer.delay === 0)
    timers.splice(initialPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1))

    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-a')
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-a',
      status: 'interrupted',
      phase: 'interrupted',
      agents: [{ status: 'interrupted' }],
    })

    resolveRuntime([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-a',
      status: 'interrupted',
      phase: 'interrupted',
      agents: [{ status: 'interrupted' }],
    })
    state.stopPolling()
  })

  it('does not let a late successful interrupt clear a newer active turn', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-b',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    let resolveInterrupt!: () => void
    gatewayMocks.interruptThreadTurn.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveInterrupt = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'inProgress' } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-a', status: 'running', updatedAtMs: 1_700_000_002_000, childStatus: 'running' }) },
    })
    const interruptPromise = state.interruptSelectedThreadTurn()
    await vi.waitFor(() => expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-a'))

    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: 'turn-b', status: 'running', updatedAtMs: 1_700_000_004_000, childStatus: 'running' }) },
    })
    resolveInterrupt()
    await interruptPromise

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: 'turn-b',
      status: 'running',
      agents: [{ status: 'running' }],
    })
    state.stopPolling()
  })

  it('ignores an older terminal reconcile response after a newer running request applies', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    let resolveOlderRuntime!: (states: Array<{
      threadId: string
      turnId: string
      state: 'completed'
      isRunning: false
      source: 'session'
      startedAtIso: string
      completedAtIso: string
      owner: null
    }>) => void
    gatewayMocks.getThreadRuntimeStates
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOlderRuntime = resolve
      }))
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-b',
        state: 'running',
        isRunning: true,
        source: 'external',
        startedAtIso: new Date(1_700_000_003_000).toISOString(),
        completedAtIso: null,
        owner: null,
      }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-b',
      status: 'running',
      updatedAtMs: 1_700_000_003_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    const initialPollIndex = timers.findIndex((timer) => timer.delay === 0)
    timers.splice(initialPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1))

    const interruptPromise = state.interruptSelectedThreadTurn()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    })
    resolveOlderRuntime([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_002_000).toISOString(),
      owner: null,
    }])
    await interruptPromise
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    state.stopPolling()
  })

  it('does not let an older terminal reconcile result clear a newer running poll', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-a',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('no active turn to interrupt'))
    let resolveOlderRuntime!: (states: Array<{
      threadId: string
      turnId: string
      state: 'completed'
      isRunning: false
      source: 'session'
      startedAtIso: string
      completedAtIso: string
      owner: null
    }>) => void
    gatewayMocks.getThreadRuntimeStates
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOlderRuntime = resolve
      }))
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-b',
        state: 'running',
        isRunning: true,
        source: 'external',
        startedAtIso: new Date(1_700_000_003_000).toISOString(),
        completedAtIso: null,
        owner: null,
      }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-b',
      status: 'running',
      updatedAtMs: 1_700_000_003_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-a')
    const interruptPromise = state.interruptSelectedThreadTurn()
    await vi.waitFor(() => {
      expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-a')
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    })

    state.startPolling()
    const initialPollIndex = timers.findIndex((timer) => timer.delay === 0)
    timers.splice(initialPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    })
    resolveOlderRuntime([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_002_000).toISOString(),
      owner: null,
    }])
    await interruptPromise
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    state.stopPolling()
  })

  it('does not let an older terminal refresh clear a newer same-turn running state', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    let resolveDetail!: (detail: {
      messages: never[]
      inProgress: false
      activeTurnId: string
      turnIndexByTurnId: Record<string, number>
      hasMoreOlder: false
    }) => void
    gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDetail = resolve
    }))
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-a',
        state: 'interrupted',
        isRunning: false,
        source: 'local',
        startedAtIso: new Date(1_700_000_001_000).toISOString(),
        completedAtIso: new Date(1_700_000_002_000).toISOString(),
        owner: null,
      }])
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-a',
        state: 'running',
        isRunning: true,
        source: 'external',
        startedAtIso: new Date(1_700_000_001_000).toISOString(),
        completedAtIso: null,
        owner: null,
      }])
    gatewayMocks.getAgentProgress.mockResolvedValue(progressSnapshot({
      turnId: 'turn-a',
      status: 'running',
      updatedAtMs: 1_700_000_003_000,
      childStatus: 'running',
    }))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    const initialPollIndex = timers.findIndex((timer) => timer.delay === 0)
    timers.splice(initialPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 15_000)).toBe(true)
    })

    const nextPollIndex = timers.findIndex((timer) => timer.delay === 15_000)
    timers.splice(nextPollIndex, 1)[0]?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-a', status: 'running' })
    })
    resolveDetail({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    for (let index = 0; index < 12; index += 1) await Promise.resolve()

    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-a', status: 'running' })
    state.stopPolling()
  })

  it('lets a later terminal poll replace the previous running runtime snapshot', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getAgentProgress
      .mockResolvedValueOnce(progressSnapshot({
        turnId: '019f6200-0001-7000-8000-000000000002',
        status: 'running',
        updatedAtMs: 1_700_000_002_000,
        childStatus: 'running',
      }))
      .mockResolvedValueOnce({
        ...progressSnapshot({
          turnId: '019f6200-0001-7000-8000-000000000002',
          status: 'interrupted',
          updatedAtMs: 1_700_000_005_000,
          childStatus: 'interrupted',
        }),
        mainLastActivityAtMs: 1_700_000_003_000,
      })
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: '019f6200-0001-7000-8000-000000000002',
        state: 'running',
        isRunning: true,
        source: 'external',
        startedAtIso: new Date(1_700_000_002_000).toISOString(),
        completedAtIso: null,
        owner: null,
      }])
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: '019f6200-0000-7000-8000-000000000001',
        state: 'completed',
        isRunning: false,
        source: 'session',
        startedAtIso: new Date(1_700_000_001_000).toISOString(),
        completedAtIso: new Date(1_700_000_004_000).toISOString(),
        owner: null,
      }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 2_000)).toBe(true)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
        turnId: '019f6200-0001-7000-8000-000000000002',
        status: 'running',
      })
    })
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: {
        threadId: 'thread-a',
        progress: {
          ...progressSnapshot({
            turnId: '019f6200-0001-7000-8000-000000000002',
            status: 'interrupted',
            updatedAtMs: 1_700_000_005_000,
            childStatus: 'interrupted',
          }),
          mainLastActivityAtMs: 1_700_000_003_000,
        },
      },
    })
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
      turnId: '019f6200-0001-7000-8000-000000000002',
      status: 'running',
    })

    const activePollIndex = timers.findIndex((timer) => timer.delay === 2_000)
    expect(activePollIndex).toBeGreaterThanOrEqual(0)
    timers.splice(activePollIndex, 1)[0]?.callback()

    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(2)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
        turnId: '019f6200-0000-7000-8000-000000000001',
        status: 'completed',
      })
    })
    state.stopPolling()
  })

  it('keeps an in-flight progress load for the active turn when an older turn completes', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown; atIso?: string }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: new Date(1_700_000_002_000).toISOString(),
      completedAtIso: null,
      owner: null,
    }])
    let resolveProgress!: (progress: UiTurnProgress) => void
    gatewayMocks.getAgentProgress.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProgress = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1))
    notificationHandler!({
      method: 'turn/completed',
      atIso: new Date(1_700_000_004_000).toISOString(),
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed', completedAt: new Date(1_700_000_004_000).toISOString() } },
    })
    resolveProgress(progressSnapshot({
      turnId: 'turn-b',
      status: 'running',
      updatedAtMs: 1_700_000_005_000,
      childStatus: 'running',
    }))

    await vi.waitFor(() => {
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'running' })
    })
    state.stopPolling()
  })

  it('does not let a terminal refresh clear a turn that starts while detail is loading', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
      owner: null,
    }])
    let resolveDetail!: (detail: {
      messages: never[]
      inProgress: false
      activeTurnId: string
      turnIndexByTurnId: Record<string, number>
      hasMoreOlder: false
    }) => void
    gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDetail = resolve
    }))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'inProgress' } },
    })
    timers.find((timer) => timer.delay === 0)?.callback()
    await vi.waitFor(() => expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1))
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
    })
    resolveDetail({
      messages: [],
      inProgress: false,
      activeTurnId: 'turn-a',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    for (let index = 0; index < 12; index += 1) await Promise.resolve()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking activity')
    state.stopPolling()
  })

  it('does not replace a confirmed failed turn with a generic completed runtime', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
      owner: null,
    }])
    const failedProgress: UiTurnProgress = {
      ...progressSnapshot({ turnId: 'turn-a', status: 'interrupted', updatedAtMs: 1_700_000_004_000 }),
      status: 'failed',
      phase: 'failed',
    }

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: failedProgress },
    })
    timers.find((timer) => timer.delay === 0)?.callback()

    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-a', status: 'failed', phase: 'failed' })
    })
    state.stopPolling()
  })

  it('replaces an unidentified terminal card with a later authoritative interruption', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-b',
      state: 'interrupted',
      isRunning: false,
      source: 'local',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_005_000).toISOString(),
      owner: null,
    }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()
    notificationHandler!({
      method: 'codex-ui/agent-progress',
      params: { threadId: 'thread-a', progress: progressSnapshot({ turnId: '', status: 'completed', updatedAtMs: 1_700_000_004_000 }) },
    })
    timers.find((timer) => timer.delay === 0)?.callback()

    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1)
      expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({
        turnId: 'turn-b',
        status: 'interrupted',
        phase: 'interrupted',
      })
    })
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
    expect(state.selectedLiveOverlay.value?.turnProgress).toMatchObject({ turnId: 'turn-b', status: 'interrupted' })
    state.stopPolling()
  })

  it('backs off missing agent progress instead of retrying on every active runtime poll', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    let now = 100_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'running',
      isRunning: true,
      source: 'local',
      startedAtIso: '2026-07-10T00:00:00.000Z',
      completedAtIso: null,
      owner: null,
    }])
    gatewayMocks.getAgentProgress
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('progress unavailable'))

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    async function runRuntimePoll(delay: number, nextNow: number): Promise<void> {
      const timerIndex = timers.findIndex((timer) => timer.delay === delay)
      expect(timerIndex).toBeGreaterThanOrEqual(0)
      const [timer] = timers.splice(timerIndex, 1)
      const expectedRuntimeCalls = gatewayMocks.getThreadRuntimeStates.mock.calls.length + 1
      now = nextNow
      timer?.callback()
      await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(expectedRuntimeCalls))
      await Promise.resolve()
      await Promise.resolve()
      await vi.waitFor(() => expect(timers.some((candidate) => candidate.delay === 2_000)).toBe(true))
    }

    try {
      await runRuntimePoll(0, 100_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1))

      await runRuntimePoll(2_000, 104_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1)

      await runRuntimePoll(2_000, 105_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(2))

      await runRuntimePoll(2_000, 114_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(2)

      await runRuntimePoll(2_000, 115_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(3))
      await runRuntimePoll(2_000, 134_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(3)

      await runRuntimePoll(2_000, 135_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(4))
      await runRuntimePoll(2_000, 174_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(4)

      await runRuntimePoll(2_000, 175_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(5))
      await runRuntimePoll(2_000, 234_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(5)

      await runRuntimePoll(2_000, 235_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(6))
      await runRuntimePoll(2_000, 294_999)
      expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(6)

      await runRuntimePoll(2_000, 295_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(7))
    } finally {
      state.stopPolling()
      nowSpy.mockRestore()
    }
  })

  it('ignores a stale progress failure after a new turn invalidates the old request', async () => {
    installTestWindow()
    let nextTimerId = 0
    const timers: Array<{ id: number; callback: () => void; delay: number; cancelled: boolean }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      nextTimerId += 1
      if (typeof callback === 'function') {
        timers.push({ id: nextTimerId, callback: callback as () => void, delay: delay ?? 0, cancelled: false })
      }
      return nextTimerId
    }) as typeof window.setTimeout)
    vi.mocked(window.clearTimeout).mockImplementation(((timerId?: number) => {
      const timer = timers.find((candidate) => candidate.id === timerId)
      if (timer) timer.cancelled = true
    }) as typeof window.clearTimeout)
    let now = 100_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    let runtimeTurnId = 'turn-a'
    gatewayMocks.getThreadRuntimeStates.mockImplementation(async () => [{
      threadId: 'thread-a',
      turnId: runtimeTurnId,
      state: 'running',
      isRunning: true,
      source: 'local',
      startedAtIso: '2026-07-10T00:00:00.000Z',
      completedAtIso: null,
      owner: null,
    }])
    let rejectFirstProgress: (error: Error) => void = () => {}
    let resolveSecondProgress: (value: null) => void = () => {}
    const firstProgress = new Promise<null>((_resolve, reject) => {
      rejectFirstProgress = reject
    })
    const secondProgress = new Promise<null>((resolve) => {
      resolveSecondProgress = resolve
    })
    gatewayMocks.getAgentProgress
      .mockImplementationOnce(() => firstProgress)
      .mockImplementationOnce(() => secondProgress)
      .mockResolvedValue(null)

    const state = useDesktopState()
    await state.loadThreads()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    async function runRuntimePoll(delay: number, nextNow: number): Promise<void> {
      const timerIndex = timers.findIndex((timer) => !timer.cancelled && timer.delay === delay)
      expect(timerIndex).toBeGreaterThanOrEqual(0)
      const [timer] = timers.splice(timerIndex, 1)
      const expectedRuntimeCalls = gatewayMocks.getThreadRuntimeStates.mock.calls.length + 1
      now = nextNow
      timer?.callback()
      await vi.waitFor(() => expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(expectedRuntimeCalls))
      await Promise.resolve()
      await Promise.resolve()
    }

    try {
      await runRuntimePoll(0, 100_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(1))

      notificationHandler?.({
        method: 'turn/completed',
        params: { threadId: 'thread-a', turnId: 'turn-a', turn: { id: 'turn-a', status: 'completed' } },
      })
      runtimeTurnId = 'turn-b'
      notificationHandler?.({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: { id: 'turn-b', status: 'inProgress' } },
      })

      await runRuntimePoll(0, 103_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(2))
      resolveSecondProgress(null)
      await Promise.resolve()
      await Promise.resolve()
      rejectFirstProgress(new Error('old request failed late'))
      await Promise.resolve()
      await Promise.resolve()

      await runRuntimePoll(2_000, 108_000)
      await vi.waitFor(() => expect(gatewayMocks.getAgentProgress).toHaveBeenCalledTimes(3))
    } finally {
      state.stopPolling()
      nowSpy.mockRestore()
    }
  })

  it('clears a silent-WebSocket spinner on the next active runtime poll', async () => {
    installTestWindow()
    const timers: Array<{ callback: () => void; delay: number }> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      return timers.length
    }) as typeof window.setTimeout)
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{ id: 'final', role: 'assistant', text: 'done', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-a',
        state: 'running',
        isRunning: true,
        source: 'local',
        startedAtIso: '2026-07-10T00:00:00.000Z',
        completedAtIso: null,
        owner: null,
      }])
      .mockResolvedValueOnce([{
        threadId: 'thread-a',
        turnId: 'turn-a',
        state: 'completed',
        isRunning: false,
        source: 'session',
        startedAtIso: '2026-07-10T00:00:00.000Z',
        completedAtIso: '2026-07-10T00:00:02.000Z',
        owner: null,
      }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadThreads()
    state.startPolling()

    const initialPoll = timers.find((timer) => timer.delay === 0)
    expect(initialPoll).toBeDefined()
    initialPoll?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
      expect(timers.some((timer) => timer.delay === 2_000)).toBe(true)
    })

    const activePoll = timers.find((timer) => timer.delay === 2_000)
    expect(activePoll).toBeDefined()
    activePoll?.callback()
    await vi.waitFor(() => {
      expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
      expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
      expect(state.messages.value).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'final', text: 'done' }),
      ]))
    })
    state.stopPolling()
  })

  it('treats no-active-turn interrupt errors as stale UI when runtime is terminal', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-a', '/tmp/project', { inProgress: true })] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{ id: 'final', role: 'assistant', text: 'done', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: 'turn-a',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('no active turn to interrupt'))
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue([{
      threadId: 'thread-a',
      turnId: 'turn-a',
      state: 'completed',
      isRunning: false,
      source: 'session',
      startedAtIso: '2026-07-10T00:00:00.000Z',
      completedAtIso: '2026-07-10T00:00:02.000Z',
      owner: null,
    }])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadThreads()
    await state.interruptSelectedThreadTurn()

    await vi.waitFor(() => {
      expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
      expect(state.error.value).toBe('')
    })
  })
})
