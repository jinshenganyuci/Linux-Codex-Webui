import { reactive } from 'vue'
import {
  addNativeQueueInput, clearNativeGoal, deleteNativeQueueInput, getNativeCapabilities, getNativeGoal,
  getNativePermissionProfiles, getNativeQueue, getNativeThreadState, invalidateNativeCapabilities,
  reorderNativeQueue, setNativeGoal, setNativeQueueMode, startNativeQueueInput, updateNativeQueueInput, updateNativeSettings,
} from '../../api/nativeThreadGateway'
import type { RpcNotification } from '../../api/codexRpcClient'
import {
  EMPTY_NATIVE_CAPABILITIES, normalizeNativeGoal, normalizeNativeSettings,
  type NativeCapabilities, type NativeGoal, type NativeGoalStatus, type NativePermissionProfile,
  type NativeQueueMode, type NativeSettingsPatch, type NativeSubmission, type NativeThreadSettings,
} from '../../nativeThreadControls'

export type NativeThreadControllerState = {
  threadId: string
  capabilities: NativeCapabilities
  mode: NativeQueueMode | null
  settings: NativeThreadSettings | null
  goal: NativeGoal | null
  queue: NativeSubmission[]
  profiles: NativePermissionProfile[]
  permissionsLoading: boolean
  loading: boolean
  busy: boolean
  expanded: boolean
  error: string
  message: string
}

export function createNativeThreadController() {
  const state = reactive<NativeThreadControllerState>({
    threadId: '', capabilities: { ...EMPTY_NATIVE_CAPABILITIES }, mode: null, settings: null,
    goal: null, queue: [], profiles: [], permissionsLoading: false, loading: false, busy: false, expanded: false, error: '', message: '',
  })
  let selection = 0
  let settingsRevision = 0
  let goalRevision = 0
  let goalLoaded = false
  let queueRevision = 0
  let queuePromise: Promise<void> | null = null
  let queueTimer: ReturnType<typeof setTimeout> | null = null
  let streamId = ''
  let receivedReady = false
  let generation = 0
  let pendingThread = ''

  const current = (threadId: string, revision: number) => state.threadId === threadId && selection === revision
  const message = (error: unknown) => error instanceof Error ? error.message : '原生操作失败。'

  function cancelQueueTimer() { if (queueTimer) clearTimeout(queueTimer); queueTimer = null }

  async function refreshQueue(): Promise<void> {
    cancelQueueTimer()
    if (queuePromise) return queuePromise
    if (!state.threadId || state.mode !== 'native' || !state.capabilities.queue) return
    const threadId = state.threadId
    const revision = selection
    const queueVersion = queueRevision
    const pending = getNativeQueue(threadId).then(queue => {
      if (current(threadId, revision) && state.mode === 'native') state.queue = queue
    }).catch(error => { if (current(threadId, revision)) state.error = message(error) })
    queuePromise = pending
    try { await pending } finally {
      if (queuePromise === pending) queuePromise = null
      if (current(threadId, revision) && queueVersion !== queueRevision && state.mode === 'native') {
        cancelQueueTimer()
        queueTimer = setTimeout(() => { queueTimer = null; void refreshQueue() }, 120)
      }
    }
  }

  async function loadGoal(): Promise<void> {
    const threadId = state.threadId
    const revision = selection
    const goalVersion = goalRevision
    if (!threadId) return
    if (!state.capabilities.goals) return
    await getNativeGoal(threadId).then(goal => {
      if (current(threadId, revision) && goalVersion === goalRevision) { state.goal = goal; goalLoaded = true }
    }).catch(error => { if (current(threadId, revision)) state.error = message(error) })
  }

  let permissionsPromise: Promise<void> | null = null
  async function loadPermissions(): Promise<void> {
    if (!state.threadId || !state.capabilities.permissions || state.profiles.length) return
    if (permissionsPromise) return permissionsPromise
    const threadId = state.threadId, revision = selection
    state.permissionsLoading = true
    const pending = getNativePermissionProfiles().then(profiles => {
      if (current(threadId, revision)) state.profiles = profiles
    }).catch(error => { if (current(threadId, revision)) state.error = message(error) })
    permissionsPromise = pending
    try { await pending } finally { if (permissionsPromise === pending) { permissionsPromise = null; state.permissionsLoading = false } }
  }

  async function loadDetails(): Promise<void> {
    const threadId = state.threadId, revision = selection
    await Promise.all([
      goalLoaded ? Promise.resolve() : loadGoal(),
      loadPermissions(),
    ]).catch(error => { if (current(threadId, revision)) state.error = message(error) })
  }

  async function select(threadId: string): Promise<void> {
    selection += 1
    const revision = selection
    cancelQueueTimer()
    queuePromise = null
    state.threadId = threadId
    state.mode = null
    state.goal = null
    goalLoaded = false
    state.settings = null
    state.queue = []
    state.profiles = []
    permissionsPromise = null
    state.permissionsLoading = false
    state.error = ''
    state.message = ''
    state.busy = pendingThread === threadId && Boolean(threadId)
    state.loading = Boolean(threadId)
    state.capabilities = { ...EMPTY_NATIVE_CAPABILITIES }
    if (!threadId) return
    const settingsVersion = settingsRevision
    try {
      const capabilities = await getNativeCapabilities()
      if (!current(threadId, revision)) return
      state.capabilities = capabilities
      {
        const runtime = await getNativeThreadState(threadId)
        if (!current(threadId, revision)) return
        state.mode = runtime.mode
        if (settingsVersion === settingsRevision) state.settings = runtime.settings
        if (runtime.mode === 'native' && !capabilities.queue) state.error = '当前 CLI 不支持已启用的原生队列；不会切回旧队列或重复发送。'
        await Promise.all([refreshQueue(), loadGoal()])
      }
      if (current(threadId, revision) && state.expanded) await loadDetails()
    } catch (error) { if (current(threadId, revision)) state.error = message(error) }
    finally { if (current(threadId, revision)) state.loading = false }
  }

  async function expand(): Promise<void> {
    state.expanded = !state.expanded
    if (state.expanded && !state.loading) await loadDetails()
  }

  async function operation(action: (threadId: string, revision: number) => Promise<void>, rethrow = false): Promise<void> {
    const threadId = state.threadId
    const revision = selection
    if (!threadId || pendingThread) {
      const error = new Error('请等待当前原生操作完成。')
      state.error = error.message
      if (rethrow) throw error
      return
    }
    pendingThread = threadId
    state.busy = true
    state.error = ''
    state.message = ''
    try { await action(threadId, revision) }
    catch (error) { if (current(threadId, revision)) state.error = message(error); if (rethrow) throw error }
    finally { pendingThread = ''; if (state.threadId === threadId) state.busy = false }
  }

  async function applySettings(patch: NativeSettingsPatch, turnId?: string): Promise<void> {
    await operation(async (threadId, revision) => {
      const result = await updateNativeSettings(threadId, patch, turnId)
      if (!current(threadId, revision)) return
      state.message = result === 'targetUnavailable'
        ? '目标回合已经结束或不可修改，本次运行设置没有生效。'
        : result === 'applied'
          ? '已发布到当前回合的后续步骤；已经开始的步骤不变，也不保证一定还有下一次推理。'
          : '已更新本会话后续回合的设置，未修改全局默认。'
      if (turnId === undefined) {
        const settingsVersion = settingsRevision
        const result = await getNativeThreadState(threadId)
        if (current(threadId, revision) && settingsVersion === settingsRevision) state.settings = result.settings
      }
    })
  }

  async function saveGoal(patch: { objective?: string; tokenBudget?: number | null; status?: NativeGoalStatus }): Promise<void> {
    await operation(async (threadId, revision) => {
      const goal = await setNativeGoal(threadId, patch)
      if (current(threadId, revision)) { state.goal = goal; state.message = '目标状态已保存。' }
    })
  }

  async function removeGoal(): Promise<void> {
    await operation(async (threadId, revision) => {
      await clearNativeGoal(threadId)
      if (current(threadId, revision)) { state.goal = null; state.message = '已清除原生目标，计划卡和聊天历史保持不变。' }
    })
  }

  async function changeQueueMode(mode: NativeQueueMode): Promise<void> {
    await operation(async (threadId, revision) => {
      await setNativeQueueMode(threadId, mode)
      if (current(threadId, revision)) { state.mode = mode; state.queue = []; await refreshQueue() }
    })
  }

  async function enqueue(input: Array<Record<string, unknown>>, threadId = state.threadId): Promise<void> {
    if (threadId !== state.threadId) throw new Error('会话已切换，请重新确认排队目标。')
    await operation(async (targetThread, revision) => {
      const identifier = globalThis.crypto?.randomUUID?.() ?? `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`
      await addNativeQueueInput(targetThread, identifier, input)
      if (current(targetThread, revision)) await refreshQueue()
    }, true)
  }

  async function changeQueue(action: 'start' | 'delete' | 'up' | 'down' | 'edit', id: string, text?: string): Promise<void> {
    await operation(async (threadId, revision) => {
      const queue = [...state.queue]
      const index = queue.findIndex(row => row.id === id)
      if (index < 0) throw new Error('排队消息已变更，请刷新核对。')
      try {
        if (action === 'start') await startNativeQueueInput(threadId, id)
        else if (action === 'delete') await deleteNativeQueueInput(threadId, id)
        else if (action === 'edit') {
          const input = queue[index].input.filter(item => item.type !== 'text')
          input.unshift({ type: 'text', text: text ?? '' })
          await updateNativeQueueInput(threadId, id, input)
        } else {
          const target = index + (action === 'up' ? -1 : 1)
          if (target < 0 || target >= queue.length) return
          const [moved] = queue.splice(index, 1)
          queue.splice(target, 0, moved)
          await reorderNativeQueue(threadId, queue.map(row => row.id))
        }
      } finally {
        if (current(threadId, revision)) await refreshQueue()
      }
    })
  }

  function observe(notification: RpcNotification): void {
    const params = notification.params as Record<string, unknown> | null
    if (notification.method === 'ready') {
      const nextStream = String(params?.streamId ?? '')
      if (streamId && nextStream && streamId !== nextStream) { invalidateNativeCapabilities(); generation = 0 }
      streamId = nextStream || streamId
      if (receivedReady && state.threadId) void select(state.threadId)
      receivedReady = true
      return
    }
    if (typeof notification.generation === 'number' && notification.generation > generation) {
      const changed = generation > 0
      generation = notification.generation
      if (changed) { invalidateNativeCapabilities(); if (state.threadId) void select(state.threadId) }
    }
    if (!params || params.threadId !== state.threadId) return
    if (notification.method === 'thread/goal/updated') {
      const goal = normalizeNativeGoal(params.goal, state.threadId)
      if (goal) { goalRevision += 1; goalLoaded = true; state.goal = goal }
    } else if (notification.method === 'thread/goal/cleared') {
      goalRevision += 1
      goalLoaded = true
      state.goal = null
    } else if (notification.method === 'thread/settings/updated' || notification.method === 'codex-ui/thread-settings') {
      const settings = normalizeNativeSettings(params.threadSettings)
      if (settings) { settingsRevision += 1; state.settings = settings }
    } else if (notification.method === 'codex-ui/native-queue-mode') {
      if (params.mode === 'native' || params.mode === 'legacy') { state.mode = params.mode; state.queue = []; void refreshQueue() }
    } else if (notification.method === 'thread/queue/changed' && state.mode === 'native') {
      queueRevision += 1
      cancelQueueTimer()
      queueTimer = setTimeout(() => { queueTimer = null; void refreshQueue() }, 120)
    }
  }

  function dispose(): void { selection += 1; cancelQueueTimer(); state.threadId = ''; queuePromise = null }
  async function reload(): Promise<void> { invalidateNativeCapabilities(); await select(state.threadId) }

  return { state, select, expand, loadPermissions, refreshQueue, applySettings, saveGoal, removeGoal, changeQueueMode, enqueue, changeQueue, observe, dispose, reload }
}
