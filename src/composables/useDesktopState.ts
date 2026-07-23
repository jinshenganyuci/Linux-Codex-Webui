import { computed, ref } from 'vue'
import {

  archiveThread,
  permanentlyDeleteThread,
  forkThread,
  getAvailableCollaborationModes,
  getAccountRateLimits,
  getAgentProgress,
  getAgentResult,
  getCodexRuntimeConfig,
  renameThread,
  getAvailableModels,
  getCurrentModelConfig,
  getPendingServerRequests,
  getSkillsList,
  getThreadDetail,
  getThreadSummary,
  getThreadHistoryDetail,
  getOlderThreadHistoryPage,
  getThreadTurnItemsPage,
  getThreadRuntimeStates,
  getThreadModelPreferences,
  getBackgroundThreadListLimit,
  interruptThreadTurn,
  pickCodexRateLimitSnapshot,
  replyToServerRequest,
  revertThreadFileChanges,
  rollbackThread,
  getThreadGroupsPage,
  getThreadQueueState,
  getWorkspaceRootsState,
  normalizeAgentProgressSnapshot,
  setCodexRuntimeConfig,
  setCodexSpeedMode,
  setThreadQueueState,
  setWorkspaceRootsState,
  getThreadTitleCache,
  persistThreadTitle,
  persistThreadModelPreference,
  generateThreadTitle,
  resumeThread,

  startThreadWithTurn,
  subscribeCodexNotifications,
  startThreadTurn,
  type CodexRuntimeConfig,
  type RpcNotification,
  type SkillInfo,
  type ThreadQueueState,
  type ThreadModelPreference,
  type ThreadModelPreferenceState,
  type ThreadRuntimeState,
  type WorkspaceRootsState,
} from '../api/codexGateway'
import { CodexApiError } from '../api/codexErrors'
import { normalizeFileChangeStatus, toUiFileChanges } from '../api/normalizers/v2'
import type {
  CollaborationModeKind,
  CollaborationModeOption,
  CodexPermissionMode,
  CommandExecutionData,
  UiPendingRequestState,
  ReasoningEffort,
  SpeedMode,
  UiFileChange,
  UiLiveOverlay,
  UiMessage,
  UiModelCapability,
  UiNotificationConnectionState,
  UiPlanData,
  UiPlanStep,
  UiProjectGroup,
  UiRateLimitSnapshot,
  UiServerRequest,
  UiServerRequestReply,
  UiThreadTokenUsage,
  UiTokenUsageBreakdown,
  UiThread,
  UiTurnProgress,
  ThreadHistoryMode,
} from '../types/codex'
import { getPathParent, isProjectlessChatPath, normalizePathForUi, toProjectName } from '../pathUtils.js'
import {
  collectThreadRuntimeStateIds,
  createThreadRuntimePollingController,
  shouldIgnoreOlderTerminalRuntimeState as shouldIgnoreOlderRuntimeState,
} from './desktop/threadRuntimePolling'
import {
  createLiveDeltaBuffer,
  LIVE_AGENT_TEXT_MAX_BYTES,
  LIVE_COMMAND_OUTPUT_MAX_BYTES,
  LIVE_DELTA_FLUSH_MS,
  LIVE_REASONING_TEXT_MAX_BYTES,
} from './desktop/liveDeltaBuffer'
import {
  createThreadListLoader,
  removeThreadFromGroups,
} from './desktop/threadListLoader'

export { capUtf8Tail } from './desktop/liveDeltaBuffer'
export { removeThreadFromGroups } from './desktop/threadListLoader'

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

type ThreadHistoryState = {
  mode: ThreadHistoryMode
  initialized: boolean
  materialized: boolean
  olderCursor: string | null
  hasMoreOlder: boolean
  loadedTurnIds: string[]
}

export function findAdjacentThreadId(threads: UiThread[], threadId: string): string {
  const targetIndex = threads.findIndex((thread) => thread.id === threadId)
  if (targetIndex < 0) return ''
  return threads[targetIndex + 1]?.id ?? threads[targetIndex - 1]?.id ?? ''
}

const READ_STATE_STORAGE_KEY = 'codex-web-local.thread-read-state.v1'
const UNREAD_CUTOFF_STORAGE_KEY = 'codex-web-local.thread-unread-cutoff.v1'
const THREAD_TOKEN_USAGE_STORAGE_KEY = 'codex-web-local.thread-token-usage.v1'
const THREAD_TERMINAL_OPEN_STORAGE_KEY = 'codex-web-local.thread-terminal-open.v1'
const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.selected-model-by-context.v1'
const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'codex-web-local.selected-model-id.v1'
const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'
const COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode-by-context.v1'
const LEGACY_COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode.v1'
const CODEX_PERMISSION_MODE_STORAGE_KEY = 'codex-web-local.codex-permission-mode.v1'
const NEW_THREAD_COLLABORATION_MODE_CONTEXT = '__new-thread__'
const NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX = '__new-thread-provider__::'
const EVENT_SYNC_DEBOUNCE_MS = 220
const EVENT_SYNC_RETRY_DELAY_MS = 1_000
const RATE_LIMIT_REFRESH_DEBOUNCE_MS = 500
const TURN_START_FOLLOW_UP_SYNC_DELAY_MS = 3000
const RECENT_THREAD_MESSAGE_LOAD_REUSE_MS = 2000
const MAX_CACHED_THREAD_HISTORIES = 20
const MAX_RECENT_PAGINATED_RECONCILIATIONS = 100
const RECENT_AGENT_PROGRESS_LOAD_REUSE_MS = 30_000
const AGENT_PROGRESS_RETRY_BASE_DELAY_MS = 5_000
const AGENT_PROGRESS_RETRY_MAX_DELAY_MS = 60_000
const RECENT_SKILLS_LOAD_REUSE_MS = 2000
const RECENT_MODEL_CATALOG_REUSE_MS = 10_000
const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'
const MODEL_FALLBACK_ID = 'gpt-5.4-mini'
const CODEX_CLI_MISSING_MESSAGE = 'Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'
const THINKING_ACTIVITY_LABEL = 'Thinking activity'
type SelectThreadResult = 'ok' | 'not-found' | 'error'

function isCodexCliMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Codex CLI is not available')
}

function isThreadNotFoundError(error: unknown): boolean {
  if (error instanceof CodexApiError && error.status === 404) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b404\b|thread.*not found|conversation.*not found|no such thread|no rollout found for thread id/i.test(message)
}

function isNoActiveTurnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /no active turn|turn is not active|active turn not found|cannot interrupt.*(?:completed|inactive)/iu.test(message)
}

function loadReadStateMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(READ_STATE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function saveReadStateMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(READ_STATE_STORAGE_KEY, JSON.stringify(state))
}

function loadUnreadCutoffIso(): string {
  if (typeof window === 'undefined') return ''

  const existing = window.localStorage.getItem(UNREAD_CUTOFF_STORAGE_KEY)
  if (existing) return existing

  const initialCutoff = new Date().toISOString()
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, initialCutoff)
  return initialCutoff
}

function saveUnreadCutoffIso(cutoffIso: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, cutoffIso)
}

function isThreadUpdatedAfterCutoff(updatedAtIso: string, cutoffIso: string): boolean {
  if (!updatedAtIso || !cutoffIso) return false
  const updatedAtMs = new Date(updatedAtIso).getTime()
  const cutoffMs = new Date(cutoffIso).getTime()
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(cutoffMs)) return false
  return updatedAtMs > cutoffMs
}

export function isThreadUnreadByLastRead(
  updatedAtIso: string,
  threadReadStateIso: string | undefined,
  unreadCutoffIso: string,
): boolean {
  const effectiveLastReadIso = threadReadStateIso ?? unreadCutoffIso
  return isThreadUpdatedAfterCutoff(updatedAtIso, effectiveLastReadIso)
}

function normalizeCollaborationMode(value: unknown): CollaborationModeKind {
  return value === 'plan' ? 'plan' : 'default'
}

function normalizeCodexPermissionMode(value: unknown): CodexPermissionMode | null {
  if (value === 'request-approval' || value === 'auto-approve' || value === 'full-access') {
    return value
  }
  return null
}

function loadSelectedCodexPermissionMode(): CodexPermissionMode {
  if (typeof window === 'undefined') return 'full-access'
  try {
    return normalizeCodexPermissionMode(window.localStorage.getItem(CODEX_PERMISSION_MODE_STORAGE_KEY)) ?? 'full-access'
  } catch {
    return 'full-access'
  }
}

function hasStoredCodexPermissionMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return normalizeCodexPermissionMode(window.localStorage.getItem(CODEX_PERMISSION_MODE_STORAGE_KEY)) !== null
  } catch {
    return false
  }
}

function saveSelectedCodexPermissionMode(mode: CodexPermissionMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, mode)
  } catch {
    // Keep in-memory mode selection working even if localStorage writes fail.
  }
}

function clearSelectedCodexPermissionMode(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CODEX_PERMISSION_MODE_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

function codexPermissionModeToRuntimeConfig(
  mode: CodexPermissionMode,
): Pick<CodexRuntimeConfig, 'sandboxMode' | 'approvalPolicy'> {
  if (mode === 'request-approval') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
  }
  if (mode === 'auto-approve') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' }
  }
  return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
}

function codexRuntimeConfigToPermissionMode(config: CodexRuntimeConfig): CodexPermissionMode {
  if (config.approvalPolicy === 'on-request') return 'request-approval'
  if (config.approvalPolicy === 'on-failure' || config.approvalPolicy === 'untrusted') return 'auto-approve'
  if (config.sandboxMode === 'danger-full-access' && config.approvalPolicy === 'never') return 'full-access'
  return 'auto-approve'
}

function runtimeConfigMatchesPermissionMode(config: CodexRuntimeConfig, mode: CodexPermissionMode): boolean {
  const expected = codexPermissionModeToRuntimeConfig(mode)
  return config.sandboxMode === expected.sandboxMode && config.approvalPolicy === expected.approvalPolicy
}

function normalizeStoredModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function cloneStringKeyedRecord<T>(record: Record<string, T>): Record<string, T> {
  const next = createStringKeyedRecord<T>()
  for (const [key, value] of Object.entries(record)) {
    next[key] = value
  }
  return next
}

function omitStringKeyedRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = createStringKeyedRecord<T>()
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      next[entryKey] = value
    }
  }
  return next
}

function pruneThreadContextStateMap<T>(
  stateMap: Record<string, T>,
  threadIds: Set<string>,
): Record<string, T> {
  let changed = false
  const next = createStringKeyedRecord<T>()
  for (const [contextId, value] of Object.entries(stateMap)) {
    if (
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      || contextId.startsWith(NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX)
      || threadIds.has(contextId)
    ) {
      next[contextId] = value
      continue
    }
    changed = true
  }
  return changed ? next : stateMap
}

function normalizeProviderContextId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized || normalized === 'openai') return 'codex'
  return normalized
}

function isNewThreadContextId(contextId: string): boolean {
  return contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function toProviderModelContextId(providerId: string): string {
  const normalizedProviderId = normalizeProviderContextId(providerId)
  if (!normalizedProviderId) return ''
  return `${NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX}${normalizedProviderId}`
}

function toThreadContextId(threadId: string): string {
  const normalizedThreadId = threadId.trim()
  return normalizedThreadId || NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function loadSelectedModelMap(): Record<string, string> {
  if (typeof window === 'undefined') return createStringKeyedRecord<string>()

  try {
    const raw = window.localStorage.getItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createStringKeyedRecord<string>()

      const next = createStringKeyedRecord<string>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedModelId = normalizeStoredModelId(value)
        if (normalizedModelId) {
          next[contextId] = normalizedModelId
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  const legacyModelId = normalizeStoredModelId(window.localStorage.getItem(LEGACY_SELECTED_MODEL_STORAGE_KEY))
  const next = createStringKeyedRecord<string>()
  if (legacyModelId) {
    next[NEW_THREAD_COLLABORATION_MODE_CONTEXT] = legacyModelId
  }
  return next
}

function readSelectedModel(
  state: Record<string, string>,
  threadId: string,
): string {
  const contextId = toThreadContextId(threadId)
  const contextModelId = normalizeStoredModelId(state[contextId])
  if (contextModelId) return contextModelId
  return normalizeStoredModelId(state[NEW_THREAD_COLLABORATION_MODE_CONTEXT])
}

function saveSelectedModelMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
}

function loadSelectedCollaborationModeMap(): Record<string, CollaborationModeKind> {
  if (typeof window === 'undefined') return createStringKeyedRecord<CollaborationModeKind>()

  try {
    const raw = window.localStorage.getItem(COLLABORATION_MODE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return createStringKeyedRecord<CollaborationModeKind>()
      }

      const next = createStringKeyedRecord<CollaborationModeKind>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedMode = normalizeCollaborationMode(value)
        if (normalizedMode === 'plan') {
          next[contextId] = normalizedMode
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  return createStringKeyedRecord<CollaborationModeKind>()
}

function readSelectedCollaborationMode(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
): CollaborationModeKind {
  const contextId = toThreadContextId(threadId)
  return normalizeCollaborationMode(state[contextId])
}

function writeSelectedCollaborationModeForContext(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
  mode: CollaborationModeKind,
): Record<string, CollaborationModeKind> {
  const contextId = toThreadContextId(threadId)
  if (isNewThreadContextId(contextId)) {
    return omitStringKeyedRecordKey(state, contextId)
  }
  if (mode === 'plan') {
    const next = cloneStringKeyedRecord(state)
    next[contextId] = 'plan'
    return next
  }
  return omitStringKeyedRecordKey(state, contextId)
}

function saveSelectedCollaborationModeMap(state: Record<string, CollaborationModeKind>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(COLLABORATION_MODE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(COLLABORATION_MODE_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_COLLABORATION_MODE_STORAGE_KEY)
  } catch {
    // Keep in-memory mode selection working even if localStorage writes fail.
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function normalizeStoredTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed))
    }
  }

  return null
}

function normalizeTokenUsageBreakdown(value: unknown): UiThreadTokenUsage['last'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  return {
    totalTokens: normalizeStoredTokenCount(record.totalTokens) ?? 0,
    inputTokens: normalizeStoredTokenCount(record.inputTokens) ?? 0,
    cachedInputTokens: normalizeStoredTokenCount(record.cachedInputTokens) ?? 0,
    outputTokens: normalizeStoredTokenCount(record.outputTokens) ?? 0,
    reasoningOutputTokens: normalizeStoredTokenCount(record.reasoningOutputTokens) ?? 0,
  }
}

function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const total = normalizeTokenUsageBreakdown(record.total)
  const last = normalizeTokenUsageBreakdown(record.last)
  if (!total || !last) return null

  const modelContextWindow = normalizeStoredTokenCount(record.modelContextWindow)
  const currentContextTokens = last.totalTokens
  const remainingContextTokens = typeof modelContextWindow === 'number'
    ? Math.max(modelContextWindow - currentContextTokens, 0)
    : null
  const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
    ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
    : null

  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextTokens,
    remainingContextPercent,
  }
}

function loadThreadTokenUsageMap(): Record<string, UiThreadTokenUsage> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, UiThreadTokenUsage> = {}
    for (const [threadId, usage] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedUsage = normalizeThreadTokenUsage(usage)
      if (normalizedUsage) {
        normalizedMap[threadId] = normalizedUsage
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTokenUsageMap(state: Record<string, UiThreadTokenUsage>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(state))
}

function loadThreadTerminalOpenMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TERMINAL_OPEN_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, boolean> = {}
    for (const [threadId, isOpen] of Object.entries(parsed as Record<string, unknown>)) {
      if (threadId && typeof isOpen === 'boolean') {
        normalizedMap[threadId] = isOpen
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTerminalOpenMap(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TERMINAL_OPEN_STORAGE_KEY, JSON.stringify(state))
}

function loadSelectedThreadId(): string {
  if (typeof window === 'undefined') return ''
  const raw = window.localStorage.getItem(SELECTED_THREAD_STORAGE_KEY)
  return raw ?? ''
}

function saveSelectedThreadId(threadId: string): void {
  if (typeof window === 'undefined') return
  if (!threadId) {
    window.localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, threadId)
}

function loadProjectOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item.length === 0) continue
      const normalizedItem = toProjectName(item)
      if (normalizedItem.length > 0 && !order.includes(normalizedItem)) {
        order.push(normalizedItem)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveProjectOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadProjectDisplayNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(PROJECT_DISPLAY_NAME_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const displayNames: Record<string, string> = {}
    for (const [projectName, displayName] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedProjectName = typeof projectName === 'string' ? toProjectName(projectName) : ''
      if (normalizedProjectName.length > 0 && typeof displayName === 'string') {
        displayNames[normalizedProjectName] = displayName
      }
    }
    return displayNames
  } catch {
    return {}
  }
}

function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_DISPLAY_NAME_STORAGE_KEY, JSON.stringify(displayNames))
}

function mergeProjectOrder(previousOrder: string[], incomingGroups: UiProjectGroup[]): string[] {
  const nextOrder: string[] = []

  for (const projectName of previousOrder) {
    if (!nextOrder.includes(projectName)) {
      nextOrder.push(projectName)
    }
  }

  for (const group of incomingGroups) {
    if (!nextOrder.includes(group.projectName)) {
      nextOrder.push(group.projectName)
    }
  }

  return areStringArraysEqual(previousOrder, nextOrder) ? previousOrder : nextOrder
}

function orderGroupsByProjectOrder(incoming: UiProjectGroup[], projectOrder: string[]): UiProjectGroup[] {
  const incomingByName = new Map(incoming.map((group) => [group.projectName, group]))
  const ordered: UiProjectGroup[] = projectOrder
    .map((projectName) => incomingByName.get(projectName) ?? null)
    .filter((group): group is UiProjectGroup => group !== null)

  for (const group of incoming) {
    if (!projectOrder.includes(group.projectName)) {
      ordered.push(group)
    }
  }

  return ordered
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function reorderStringArray(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return items
  }

  if (fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function arePlanStepsEqual(first: UiPlanStep[] = [], second: UiPlanStep[] = []): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index]?.step !== second[index]?.step || first[index]?.status !== second[index]?.status) {
      return false
    }
  }
  return true
}

function arePlanDataEqual(first?: UiPlanData, second?: UiPlanData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.explanation === second.explanation &&
    first.isStreaming === second.isStreaming &&
    arePlanStepsEqual(first.steps, second.steps)
  )
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('not supported when using codex with a chatgpt account') ||
    message.includes('model is not supported') ||
    message.includes('requires a newer version of codex')
  )
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    areStringArraysEqual(first.images, second.images) &&
    areUiFileChangesEqual(first.fileChanges, second.fileChanges) &&
    first.fileChangeStatus === second.fileChangeStatus &&
    first.messageType === second.messageType &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    arePlanDataEqual(first.plan, second.plan) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex &&
    first.isAutomationRun === second.isAutomationRun &&
    first.automationDisplayName === second.automationDisplayName
  )
}

function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function messageIdentityKey(message: UiMessage): string {
  const turnId = message.turnId?.trim() ?? ''
  return turnId ? `${turnId}\u0000${message.id}` : message.id
}

function messageTextIdentityKey(message: UiMessage): string {
  const normalizedText = normalizeMessageText(message.text)
  const turnId = message.turnId?.trim() ?? ''
  return turnId ? `${turnId}\u0000${normalizedText}` : normalizedText
}

function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  const previousById = new Map(previous.map((message) => [messageIdentityKey(message), message]))
  const incomingById = new Map(incoming.map((message) => [messageIdentityKey(message), message]))

  const mergedIncoming = incoming.map((incomingMessage) => {
    const previousMessage = previousById.get(messageIdentityKey(incomingMessage))
    if (previousMessage && areMessageFieldsEqual(previousMessage, incomingMessage)) {
      return previousMessage
    }
    return incomingMessage
  })

  if (options.preserveMissing !== true) {
    return areMessageArraysEqual(previous, mergedIncoming) ? previous : mergedIncoming
  }

  const mergedFromPrevious = previous
    .map((previousMessage) => {
      const nextMessage = incomingById.get(messageIdentityKey(previousMessage))
      if (!nextMessage) {
        return previousMessage
      }
      if (areMessageFieldsEqual(previousMessage, nextMessage)) {
        return previousMessage
      }
      return nextMessage
    })
    .filter((message) => !isOptimisticUserMessage(message) || !hasEquivalentUserMessage(message, incoming))

  const previousIdSet = new Set(previous.map(messageIdentityKey))
  const appended = mergedIncoming.filter((message) => !previousIdSet.has(messageIdentityKey(message)))
  const merged = [...mergedFromPrevious, ...appended]

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

function areUiFileChangesEqual(first?: UiFileChange[], second?: UiFileChange[]): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    const firstChange = first[index]
    const secondChange = second[index]
    if (
      firstChange.path !== secondChange.path ||
      firstChange.operation !== secondChange.operation ||
      firstChange.movedToPath !== secondChange.movedToPath ||
      firstChange.diff !== secondChange.diff ||
      firstChange.addedLineCount !== secondChange.addedLineCount ||
      firstChange.removedLineCount !== secondChange.removedLineCount
    ) {
      return false
    }
  }
  return true
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function isOptimisticUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage.optimistic'
}

function isNonItemTurnMetadataMessage(message: UiMessage): boolean {
  return message.messageType?.startsWith('turn') === true
}

function hasOptimisticUserMessages(messages: UiMessage[]): boolean {
  return messages.some(isOptimisticUserMessage)
}

function hasEquivalentUserMessage(target: UiMessage, messages: UiMessage[]): boolean {
  if (target.role !== 'user') return false
  const targetText = normalizeMessageText(target.text)
  const targetImages = Array.isArray(target.images) ? target.images : []
  const targetFileCount = Array.isArray(target.fileAttachments) ? target.fileAttachments.length : 0
  const targetSkillCount = Array.isArray(target.skills) ? target.skills.length : 0

  return messages.some((message) => {
    if (message === target || message.role !== 'user' || isOptimisticUserMessage(message)) return false
    const messageText = normalizeMessageText(message.text)
    const messageImages = Array.isArray(message.images) ? message.images : []
    const messageFileCount = Array.isArray(message.fileAttachments) ? message.fileAttachments.length : 0
    const messageSkillCount = Array.isArray(message.skills) ? message.skills.length : 0
    return (
      messageText === targetText &&
      areStringArraysEqual(messageImages, targetImages) &&
      messageFileCount === targetFileCount &&
      messageSkillCount === targetSkillCount
    )
  })
}

function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingMessageIds = new Set(incoming.map(messageIdentityKey))
  const incomingAssistantTexts = new Set(
    incoming
      .filter((message) => message.role === 'assistant')
      .filter((message) => normalizeMessageText(message.text).length > 0)
      .map(messageTextIdentityKey),
  )

  if (incomingAssistantTexts.size === 0) {
    return previous
  }

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    if (incomingMessageIds.has(messageIdentityKey(message))) return false
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return !incomingAssistantTexts.has(messageTextIdentityKey(message))
  })

  return next.length === previous.length ? previous : next
}

function removePersistedLiveMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingIds = new Set(incoming.map(messageIdentityKey))
  const next = previous.filter((message) => !incomingIds.has(messageIdentityKey(message)))
  return next.length === previous.length ? previous : next
}

function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const nextIdentity = messageIdentityKey(nextMessage)
  const existingIndex = previous.findIndex((message) => messageIdentityKey(message) === nextIdentity)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

type TurnSummaryState = {
  turnId: string
  durationMs: number
}

type TurnActivityState = {
  label: string
  details: string[]
}

type TurnErrorState = {
  message: string
  transient: boolean
}

type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

const WORKED_MESSAGE_TYPE = 'worked'

function parseIsoTimestamp(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '<1s'
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  const displaySeconds = seconds > 0 || parts.length === 0 ? seconds : 0
  parts.push(`${displaySeconds}s`)
  return parts.join(' ')
}

function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId && first.durationMs === second.durationMs
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function buildTurnSummaryMessage(summary: TurnSummaryState): UiMessage {
  return {
    id: `turn-summary:${summary.turnId}`,
    role: 'system',
    text: `Worked for ${formatTurnDuration(summary.durationMs)}`,
    messageType: WORKED_MESSAGE_TYPE,
    turnId: summary.turnId,
  }
}

function findLastAssistantMessageIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return index
    }
  }
  return -1
}

function insertTurnSummaryMessage(messages: UiMessage[], summary: TurnSummaryState): UiMessage[] {
  const summaryMessage = buildTurnSummaryMessage(summary)
  const sanitizedMessages = messages.filter((message) => message.messageType !== WORKED_MESSAGE_TYPE)
  const insertIndex = findLastAssistantMessageIndex(sanitizedMessages)
  if (insertIndex < 0) {
    return [...sanitizedMessages, summaryMessage]
  }
  const next = [...sanitizedMessages]
  next.splice(insertIndex, 0, summaryMessage)
  return next
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function omitKeys<TValue>(record: Record<string, TValue>, keys: Set<string>): Record<string, TValue> {
  if (keys.size === 0) return record
  let changed = false
  const next: Record<string, TValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : record
}

function areThreadFieldsEqual(first: UiThread, second: UiThread): boolean {
  return (
    first.id === second.id &&
    first.title === second.title &&
    first.projectName === second.projectName &&
    first.cwd === second.cwd &&
    first.createdAtIso === second.createdAtIso &&
    first.updatedAtIso === second.updatedAtIso &&
    first.preview === second.preview &&
    first.unread === second.unread &&
    first.inProgress === second.inProgress &&
    first.historyMode === second.historyMode &&
    first.pendingRequestState === second.pendingRequestState
  )
}

function areThreadArraysEqual(first: UiThread[], second: UiThread[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areGroupArraysEqual(first: UiProjectGroup[], second: UiProjectGroup[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

function mergeThreadGroups(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  const previousGroupsByName = new Map(previous.map((group) => [group.projectName, group]))
  const mergedGroups: UiProjectGroup[] = incoming.map((incomingGroup) => {
    const previousGroup = previousGroupsByName.get(incomingGroup.projectName)
    const previousThreadsById = new Map(previousGroup?.threads.map((thread) => [thread.id, thread]) ?? [])

    const mergedThreads = incomingGroup.threads.map((incomingThread) => {
      const previousThread = previousThreadsById.get(incomingThread.id)
      if (previousThread && areThreadFieldsEqual(previousThread, incomingThread)) {
        return previousThread
      }
      return incomingThread
    })

    if (
      previousGroup &&
      previousGroup.projectName === incomingGroup.projectName &&
      areThreadArraysEqual(previousGroup.threads, mergedThreads)
    ) {
      return previousGroup
    }

    return {
      projectName: incomingGroup.projectName,
      threads: mergedThreads,
    }
  })

  return areGroupArraysEqual(previous, mergedGroups) ? previous : mergedGroups
}

function mergeIncomingWithLocalInProgressThreads(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
  inProgressById: Record<string, boolean>,
): UiProjectGroup[] {
  const incomingThreadIds = new Set(flattenThreads(incoming).map((thread) => thread.id))
  const localInProgressThreads = flattenThreads(previous).filter(
    (thread) => inProgressById[thread.id] === true && !incomingThreadIds.has(thread.id),
  )

  if (localInProgressThreads.length === 0) {
    return incoming
  }

  const incomingByProjectName = new Map(incoming.map((group) => [group.projectName, group]))
  const merged: UiProjectGroup[] = incoming.map((group) => ({
    projectName: group.projectName,
    threads: [...group.threads],
  }))

  for (const thread of localInProgressThreads) {
    const existingGroup = incomingByProjectName.get(thread.projectName)
    if (existingGroup) {
      const mergedGroupIndex = merged.findIndex((group) => group.projectName === thread.projectName)
      if (mergedGroupIndex >= 0) {
        merged[mergedGroupIndex] = {
          projectName: merged[mergedGroupIndex].projectName,
          threads: [thread, ...merged[mergedGroupIndex].threads],
        }
      }
      continue
    }

    merged.push({
      projectName: thread.projectName,
      threads: [thread],
    })
  }

  return merged
}

function syncIncomingInProgressState(
  current: Record<string, boolean>,
  groups: UiProjectGroup[],
): Record<string, boolean> {
  let next = current

  for (const thread of flattenThreads(groups)) {
    const currentValue = next[thread.id] === true
    if (thread.inProgress === true) {
      if (currentValue) continue
      if (next === current) {
        next = { ...current }
      }
      next[thread.id] = true
      continue
    }

    if (!currentValue) continue
    if (next === current) {
      next = { ...current }
    }
    delete next[thread.id]
  }

  return next
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  return toProjectName(value)
}

function getRemoteProjectHostLabel(hostId: string): string {
  const normalized = hostId.trim()
  if (!normalized) return ''
  const separatorIndex = normalized.lastIndexOf(':')
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
}

function getRemoteProjectDisplayName(remoteProject: NonNullable<WorkspaceRootsState['remoteProjects']>[number]): string {
  const label = remoteProject.label || toProjectName(remoteProject.remotePath) || remoteProject.id
  const hostLabel = getRemoteProjectHostLabel(remoteProject.hostId)
  return hostLabel ? `${label} ${hostLabel}` : label
}

function getRemoteProjectById(rootsState: WorkspaceRootsState | null): Map<string, NonNullable<WorkspaceRootsState['remoteProjects']>[number]> {
  const remoteProjects = rootsState?.remoteProjects ?? []
  return new Map(remoteProjects.map((project) => [project.id, project]))
}

function getWorkspaceProjectOrderPaths(rootsState: WorkspaceRootsState | null): string[] {
  if (!rootsState) return []
  const savedRoots = new Set(rootsState.order)
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const orderedRoots = rootsState.projectOrder.filter((item) => savedRoots.has(item) || remoteProjectIds.has(item))
  for (const rootPath of rootsState.order) {
    if (!orderedRoots.includes(rootPath)) orderedRoots.push(rootPath)
  }
  for (const remoteProjectId of remoteProjectIds) {
    if (!orderedRoots.includes(remoteProjectId)) orderedRoots.push(remoteProjectId)
  }
  return orderedRoots
}

function getWorkspaceProjectOrderNames(
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): string[] {
  const remoteProjectsById = getRemoteProjectById(rootsState)
  return getWorkspaceProjectOrderPaths(rootsState).map((rootPath) => {
    if (remoteProjectsById.has(rootPath)) return rootPath
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    return duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
  })
}

function matchesWorkspaceRootProject(rootPath: string, projectName: string): boolean {
  const normalizedRootPath = normalizePathForUi(rootPath).trim()
  return normalizedRootPath === projectName || toProjectNameFromWorkspaceRoot(rootPath) === projectName
}

export function collectWorkspaceRootPathsForProjectRemoval(
  rootsState: WorkspaceRootsState,
  projectName: string,
): Set<string> {
  const removedRootPaths = new Set<string>()
  for (const rootPath of rootsState.order) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of rootsState.active) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of Object.keys(rootsState.labels)) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  return removedRootPaths
}

export function buildWorkspaceRootsProjectOrderState(
  rootsState: WorkspaceRootsState,
  orderedProjectNames: string[],
  groups: UiProjectGroup[],
): Pick<WorkspaceRootsState, 'order' | 'active' | 'projectOrder'> {
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const rootByProjectName = new Map<string, string>()
  for (const rootPath of rootsState.order) {
    const projectName = toProjectNameFromWorkspaceRoot(rootPath)
    if (!rootByProjectName.has(projectName)) {
      rootByProjectName.set(projectName, rootPath)
    }
  }
  for (const group of groups) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd) continue
    rootByProjectName.set(group.projectName, cwd)
  }

  const nextProjectOrder: string[] = []
  const pushProjectOrderItem = (item: string): void => {
    if (item && !nextProjectOrder.includes(item)) {
      nextProjectOrder.push(item)
    }
  }

  for (const projectName of orderedProjectNames) {
    if (remoteProjectIds.has(projectName)) {
      pushProjectOrderItem(projectName)
      continue
    }
    const rootPath = rootByProjectName.get(projectName)
    if (rootPath) {
      pushProjectOrderItem(rootPath)
    }
  }
  for (const item of getWorkspaceProjectOrderPaths(rootsState)) {
    pushProjectOrderItem(item)
  }

  const nextOrder = nextProjectOrder.filter((item) => rootsState.order.includes(item))
  for (const rootPath of rootsState.order) {
    if (!nextOrder.includes(rootPath)) {
      nextOrder.push(rootPath)
    }
  }

  const nextActive = rootsState.active.filter((rootPath) => nextOrder.includes(rootPath))
  if (nextActive.length === 0 && nextOrder.length > 0) {
    nextActive.push(nextOrder[0])
  }

  return {
    order: nextOrder,
    active: nextActive,
    projectOrder: nextProjectOrder,
  }
}

function orderGroupsByWorkspaceProjectOrder(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  const order = getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)
  if (order.length === 0) return groups
  const orderIndexByName = new Map(order.map((name, index) => [name, index]))
  return [...groups].sort((first, second) => {
    if (isProjectlessGroup(first) || isProjectlessGroup(second)) return 0
    const firstIndex = orderIndexByName.get(first.projectName) ?? Number.POSITIVE_INFINITY
    const secondIndex = orderIndexByName.get(second.projectName) ?? Number.POSITIVE_INFINITY
    if (firstIndex === secondIndex) return 0
    return firstIndex - secondIndex
  })
}

function collectDuplicateProjectLeafNames(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): Set<string> {
  const rootByLeafName = new Map<string, Set<string>>()
  const canonicalWorkspaceRootCountsByLeafName = new Map<string, number>()
  const addPath = (value: string): void => {
    const normalizedPath = normalizePathForUi(value).trim()
    if (!normalizedPath) return
    const leafName = toProjectName(normalizedPath)
    const existing = rootByLeafName.get(leafName) ?? new Set<string>()
    existing.add(normalizedPath)
    rootByLeafName.set(leafName, existing)
  }

  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectName(normalizedRootPath)
    if (!isManagedCodexWorktreePath(normalizedRootPath)) {
      canonicalWorkspaceRootCountsByLeafName.set(leafName, (canonicalWorkspaceRootCountsByLeafName.get(leafName) ?? 0) + 1)
    }
    addPath(rootPath)
  }
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = rootsState?.order.some((rootPath) => normalizePathForUi(rootPath).trim() === normalizedCwd) === true
      if (isManagedCodexWorktreePath(normalizedCwd) && !isRegisteredRoot && canonicalWorkspaceRootCountsByLeafName.get(leafName) === 1) continue
      addPath(thread.cwd)
    }
  }

  const duplicateLeafNames = new Set<string>()
  for (const [leafName, paths] of rootByLeafName.entries()) {
    if (paths.size > 1) duplicateLeafNames.add(leafName)
  }
  return duplicateLeafNames
}

function isManagedCodexWorktreePath(value: string): boolean {
  return value.includes('/.codex/worktrees/')
}

function disambiguateProjectGroupsByCwd(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  if (duplicateLeafNames.size === 0) return groups

  const uniqueCanonicalWorkspaceRootLeafNames = new Set<string>()
  const duplicateCanonicalWorkspaceRootLeafNames = new Set<string>()
  const canonicalWorkspaceRootByLeafName = new Map<string, string>()
  const registeredWorkspaceRoots = new Set<string>()
  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    registeredWorkspaceRoots.add(normalizedRootPath)
    if (isManagedCodexWorktreePath(normalizedRootPath)) continue
    const leafName = toProjectName(normalizedRootPath)
    if (uniqueCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.delete(leafName)
      duplicateCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.delete(leafName)
    } else if (!duplicateCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.set(leafName, normalizedRootPath)
    }
  }

  const disambiguatedGroups: UiProjectGroup[] = []
  const groupsByProjectName = new Map<string, UiProjectGroup>()
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = registeredWorkspaceRoots.has(normalizedCwd)
      const isCanonicalWorktreeThread = isManagedCodexWorktreePath(normalizedCwd)
        && !isRegisteredRoot
        && uniqueCanonicalWorkspaceRootLeafNames.has(leafName)
      let projectName = group.projectName
      if (isCanonicalWorktreeThread && duplicateLeafNames.has(leafName)) {
        projectName = canonicalWorkspaceRootByLeafName.get(leafName) ?? group.projectName
      } else if (normalizedCwd && duplicateLeafNames.has(leafName)) {
        projectName = normalizedCwd
      }
      const nextThread = thread.projectName === projectName ? thread : { ...thread, projectName }
      const existingGroup = groupsByProjectName.get(projectName)
      if (existingGroup) {
        existingGroup.threads.push(nextThread)
      } else {
        const nextGroup = { projectName, threads: [nextThread] }
        groupsByProjectName.set(projectName, nextGroup)
        disambiguatedGroups.push(nextGroup)
      }
    }
  }

  return disambiguatedGroups
}

function addWorkspaceRootPlaceholderGroups(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groups
  const existingProjectNames = new Set(groups.map((group) => group.projectName))
  const nextGroups = [...groups]
  const remoteProjectsById = getRemoteProjectById(rootsState)

  for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
    if (remoteProjectsById.has(rootPath)) {
      if (existingProjectNames.has(rootPath)) continue
      nextGroups.push({ projectName: rootPath, threads: [] })
      existingProjectNames.add(rootPath)
      continue
    }
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    const projectName = duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
    if (existingProjectNames.has(projectName)) continue
    nextGroups.push({ projectName, threads: [] })
    existingProjectNames.add(projectName)
  }

  return nextGroups
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

function toForkedThreadTitle(title: string): string {
  const normalizedTitle = title.trim() || 'Untitled thread'
  return /^fork:\s+/iu.test(normalizedTitle) ? normalizedTitle : `Fork: ${normalizedTitle}`
}

function isProjectlessGroup(group: UiProjectGroup): boolean {
  return group.threads.some((thread) => thread.cwd.trim().length === 0 || isProjectlessChatPath(thread.cwd))
}

export function filterGroupsByWorkspaceRoots(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
  const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
  const allowedProjectNames = new Set<string>()
  for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
    allowedProjectNames.add(projectName)
  }
  const filteredGroups = groupsWithWorkspaceRoots.filter((group) => allowedProjectNames.has(group.projectName) || isProjectlessGroup(group))
  return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
}

export function useDesktopState() {
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const selectedThreadId = ref(loadSelectedThreadId())
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const livePlanMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveFileChangeMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const agentProgressByThreadId = ref<Record<string, UiTurnProgress>>({})
  const notificationConnectionState = ref<UiNotificationConnectionState>('connecting')
  const inProgressById = ref<Record<string, boolean>>({})
  const agentProgressLoadPromiseByThreadId = new Map<string, Promise<void>>()
  const lastAgentProgressLoadAtByThreadId = new Map<string, number>()
  const agentProgressRetryStateByThreadId = new Map<string, { consecutiveFailures: number; nextRetryAt: number }>()
  const agentProgressLoadEpochByThreadId = new Map<string, number>()
  let agentProgressLoadGeneration = 0
  type FileAttachment = { label: string; path: string; fsPath: string }
  type QueuedMessage = {
    id: string
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    collaborationMode: CollaborationModeKind
    speedMode?: SpeedMode
    model?: string
    reasoningEffort?: ReasoningEffort
  }
  type PendingTurnRequest = {
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    effort: ReasoningEffort | ''
    collaborationMode: CollaborationModeKind
    speedMode: SpeedMode
    fallbackRetried: boolean
  }
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const queueProcessingByThreadId = ref<Record<string, boolean>>({})
  let hasLoadedPersistedQueueState = false
  const eventUnreadByThreadId = ref<Record<string, boolean>>({})
  const availableModelIds = ref<string[]>([])
  const availableModelCapabilities = ref<Record<string, UiModelCapability>>({})
  const availableCollaborationModes = ref<CollaborationModeOption[]>([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ])
  const selectedCollaborationModeByContext = ref<Record<string, CollaborationModeKind>>(
    loadSelectedCollaborationModeMap(),
  )
  const selectedModelIdByContext = ref<Record<string, string>>(loadSelectedModelMap())
  const threadModelPreferencesById = ref<ThreadModelPreferenceState>({})
  const selectedCollaborationMode = ref<CollaborationModeKind>(
    readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value),
  )
  const selectedModelId = ref(readSelectedModel(selectedModelIdByContext.value, selectedThreadId.value))
  const selectedReasoningEffort = ref<ReasoningEffort | ''>('medium')
  const selectedSpeedMode = ref<SpeedMode>('standard')
  const selectedCodexPermissionMode = ref<CodexPermissionMode>(loadSelectedCodexPermissionMode())
  const activeProviderId = ref('')
  const codexCliMissingError = ref('')
  const readStateByThreadId = ref<Record<string, string>>(loadReadStateMap())
  const unreadCutoffIso = ref(loadUnreadCutoffIso())
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const threadHistoryStateById = ref<Record<string, ThreadHistoryState>>({})

  const fastModeSupportByModelId = ref<Record<string, boolean>>({})

  function isFastModeSupportedForModel(modelId: string): boolean {
    const normalizedModelId = modelId.trim()
    if (!normalizedModelId) return false
    const currentCapability = availableModelCapabilities.value[normalizedModelId]
    if (currentCapability) return currentCapability.supportsFastMode
    return fastModeSupportByModelId.value[normalizedModelId] === true
  }

  function serviceTierForSpeedMode(
    speedMode: SpeedMode | undefined,
    modelId: string,
  ): string | null | undefined {
    if (speedMode === 'fast') {
      return isFastModeSupportedForModel(modelId) ? 'fast' : null
    }
    if (speedMode === 'standard') return null
    return undefined
  }
  const hasMoreOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const loadingOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
  const interruptBlockedUntilPersistedByThreadId = ref<Record<string, boolean>>({})
  const threadListedByServerById = ref<Record<string, boolean>>({})
  const persistedUserMessageByThreadId = ref<Record<string, boolean>>({})
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})
  const pendingTurnRequestByThreadId = ref<Record<string, PendingTurnRequest>>({})
  const codexRateLimit = ref<UiRateLimitSnapshot | null>(null)
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>(loadThreadTokenUsageMap())
  const terminalOpenByThreadId = ref<Record<string, boolean>>(loadThreadTerminalOpenMap())
  const threadModelProviderByThreadId = ref<Record<string, string>>({})

  const threadTitleById = ref<Record<string, string>>({})

  const installedSkills = ref<SkillInfo[]>([])
  const accountRateLimitSnapshots = ref<UiRateLimitSnapshot[]>([])

  const isLoadingThreads = ref(false)
  const isLoadingMessages = ref(false)
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const isUpdatingSpeedMode = ref(false)
  const isUpdatingPermissionMode = ref(false)
  const isRollingBack = ref(false)
  const pendingNewThreadMessages = ref<UiMessage[]>([])
  const pendingNewThreadPreviewError = ref('')

  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)

  function extractLocalImagePathFromUrl(value: string): string {
    try {
      const parsed = new URL(value, 'http://localhost')
      if (parsed.pathname !== '/codex-local-image') return ''
      return parsed.searchParams.get('path')?.trim() ?? ''
    } catch {
      return ''
    }
  }

  function shouldReuseAttachedImageFromPrompt(promptText: string): boolean {
    const normalized = promptText.trim().toLowerCase()
    if (!normalized) return false
    return /\b(attached image|attached screenshot|save the attached|copy (the )?screenshot|save screenshot)\b/i.test(normalized)
  }

  function findLatestUserLocalImageUrl(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (let index = persisted.length - 1; index >= 0; index -= 1) {
      const message = persisted[index]
      if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length === 0) continue
      for (let imageIndex = message.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
        const imageUrl = message.images[imageIndex]?.trim() ?? ''
        if (!imageUrl) continue
        if (extractLocalImagePathFromUrl(imageUrl)) return imageUrl
      }
    }
    return ''
  }
  let stopNotificationStream: (() => void) | null = null
  let hasReceivedNotificationReady = false
  let eventSyncTimer: number | null = null
  const terminalRuntimeRefreshThreadIds = new Set<string>()
  const latestRuntimeStateByThreadId = new Map<string, ThreadRuntimeState>()
  const terminalTurnAtMsByThreadId = new Map<string, Map<string, number>>()
  const runtimeStateLifecycleEpochByThreadId = new Map<string, number>()
  const lastAppliedRuntimeRequestByThreadId = new Map<string, number>()
  const runtimeRequestContextByState = new WeakMap<ThreadRuntimeState, {
    generation: number
    requestSequence: number
    lifecycleEpoch: number
  }>()
  const appliedRuntimeStateSnapshots = new WeakSet<ThreadRuntimeState>()
  let runtimeRequestGeneration = 0
  let runtimeRequestSequence = 0
  const optimisticTurnStartedAtByThreadId = new Map<string, number>()
  let rateLimitRefreshTimer: number | null = null
  const delayedTurnSyncTimerByThreadId = new Map<string, number>()
  const loadMessagePromiseByThreadId = new Map<string, Promise<void>>()
  const forcedMessageLoadPromiseByThreadId = new Map<string, Promise<void>>()
  const threadHistoryModeProbeByThreadId = new Map<string, Promise<ThreadHistoryMode>>()
  const paginatedTurnReconcileByKey = new Map<string, {
    promise: Promise<boolean>
    createdAt: number
    settled: boolean
  }>()
  const threadHistoryAccessOrderByThreadId = new Map<string, number>()
  let threadHistoryAccessSequence = 0
  let visibleMessageLoadOwnerThreadId = ''
  let messageLoadGeneration = 0
  let refreshSkillsPromise: Promise<void> | null = null
  const modelCatalogPromiseByKey = new Map<string, Promise<UiModelCapability[]>>()
  let hasLoadedSkills = false
  let lastSkillsLoadAt = 0
  let lastSkillsLoadKey = ''
  let lastModelCatalogAt = 0
  let lastModelCatalogKey = ''
  let lastModelCatalog: UiModelCapability[] = []
  let rateLimitRefreshPromise: Promise<void> | null = null
  let pendingThreadsRefresh = false
  let pendingThreadsRefreshForce = false
  const pendingThreadMessageRefresh = new Set<string>()
  const pendingCompletedTurnReconciliationByThreadId = new Map<string, Set<string>>()
  const lastMessageLoadAtByThreadId = new Map<string, number>()
  const lastMessageLoadFailureAtByThreadId = new Map<string, number>()
  let hasHydratedWorkspaceRootsState = false
  const activeReasoningItemIdByThreadId = new Map<string, string>()
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()
  const fallbackRetryInFlightThreadIds = new Set<string>()
  let hasPersistedCodexPermissionMode = hasStoredCodexPermissionMode()
  let hasLoadedThreadModelPreferences = false
  let newThreadSelectionInitialized = false
  let newThreadDraftModelId = ''
  let runtimeDefaultModelId = ''
  let runtimeDefaultReasoningEffort: ReasoningEffort | '' = ''
  const threadModelPreferenceWriteChainById = new Map<string, Promise<void>>()


  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() =>
    allThreads.value.find((thread) => thread.id === selectedThreadId.value) ?? null,
  )
  const selectedThreadTerminalOpen = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && terminalOpenByThreadId.value[threadId] === true)
  })
  const isSelectedThreadInterruptPending = computed(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return false
    return interruptBlockedUntilPersistedByThreadId.value[threadId] === true
  })
  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = selectedThreadId.value
    if (selected && Array.isArray(pendingServerRequestsByThreadId.value[selected])) {
      rows.push(...pendingServerRequestsByThreadId.value[selected])
    }
    if (Array.isArray(pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])) {
      rows.push(...pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null

    const turnProgress = agentProgressByThreadId.value[threadId] ?? null
    const isInProgress = inProgressById.value[threadId] === true || turnProgress?.status === 'running'
    const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
    const reasoningText = isInProgress
      ? (liveReasoningTextByThreadId.value[threadId] ?? '').trim()
      : ''
    const liveErrorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
    let latestPersistedTurnErrorText = ''
    if (!isInProgress && liveErrorText) {
      const persistedMessages = persistedMessagesByThreadId.value[threadId] ?? []
      for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
        const message = persistedMessages[index]
        if (message.messageType !== 'turnError') continue
        latestPersistedTurnErrorText = normalizeMessageText(message.text)
        break
      }
    }
    const errorText =
      !isInProgress && liveErrorText && latestPersistedTurnErrorText === liveErrorText
        ? ''
        : liveErrorText

    const hasAgentProgress = Boolean(turnProgress && (turnProgress.status === 'running' || turnProgress.agents.length > 0))
    const connectionState = notificationConnectionState.value
    const hasConnectionWarning = isInProgress && (connectionState === 'reconnecting' || connectionState === 'unavailable')
    if (!activity && !reasoningText && !errorText && !hasAgentProgress && !hasConnectionWarning) return null
    const activityModelDetails = (activity?.details ?? []).filter((detail) => (
      detail.startsWith('Model:') || detail.startsWith('Thinking:') || detail.startsWith('Speed:')
    ))
    const pendingTurn = pendingTurnRequestByThreadId.value[threadId]
    const mainModelDetails = activityModelDetails.length > 0
      ? activityModelDetails
      : buildPendingTurnDetails(
          readModelIdForThread(threadId),
          pendingTurn?.effort || readReasoningEffortForThread(threadId) || selectedReasoningEffort.value,
          pendingTurn?.collaborationMode ?? selectedCollaborationMode.value,
          pendingTurn?.speedMode ?? selectedSpeedMode.value,
        ).filter((detail) => detail.startsWith('Model:') || detail.startsWith('Thinking:') || detail.startsWith('Speed:'))
    return {
      activityLabel: activity?.label || THINKING_ACTIVITY_LABEL,
      activityDetails: activity?.details ?? [],
      mainModelDetails,
      reasoningText,
      errorText,
      connectionState,
      turnProgress,
    }
  })
  const pendingNewThreadLiveOverlay = computed<UiLiveOverlay | null>(() => {
    if (pendingNewThreadMessages.value.length === 0) return null
    const details = buildPendingTurnDetails(
      readModelIdForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT),
      selectedReasoningEffort.value,
      selectedCollaborationMode.value,
      selectedSpeedMode.value,
    )
    return {
      activityLabel: THINKING_ACTIVITY_LABEL,
      activityDetails: details,
      mainModelDetails: details.filter((detail) => (
        detail.startsWith('Model:') || detail.startsWith('Thinking:') || detail.startsWith('Speed:')
      )),
      reasoningText: '',
      errorText: pendingNewThreadPreviewError.value,
      connectionState: notificationConnectionState.value,
      turnProgress: null,
    }
  })
  const codexQuota = computed<UiRateLimitSnapshot | null>(() => codexRateLimit.value)
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    return threadTokenUsageByThreadId.value[threadId] ?? null
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const livePlan = livePlanMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    const liveCommands = liveCommandsByThreadId.value[threadId] ?? []
    const liveFileChanges = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const combined = [...persisted, ...livePlan, ...liveCommands, ...liveFileChanges, ...liveAgent]

    const summary = turnSummaryByThreadId.value[threadId]
    if (!summary) return combined
    return insertTurnSummaryMessage(combined, summary)
  })
  const hasMoreOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? hasMoreOlderMessagesByThreadId.value[threadId] === true : false
  })
  const isLoadingOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingOlderMessagesByThreadId.value[threadId] === true : false
  })

  function getFirstPersistedTurnId(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) return turnId
    }
    return ''
  }

  function readModelIdForThread(threadId: string): string {
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      if (!selectedThreadId.value.trim()) return selectedModelId.value.trim()
      return newThreadDraftModelId || runtimeDefaultModelId
    }
    return readSelectedModel(selectedModelIdByContext.value, threadId).trim()
  }

  function readThreadModelPreference(threadId: string): ThreadModelPreference | null {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return null
    return threadModelPreferencesById.value[normalizedThreadId] ?? null
  }

  function hasCachedThreadModelSelection(threadId: string): boolean {
    const normalizedThreadId = threadId.trim()
    return Boolean(normalizedThreadId && normalizeStoredModelId(selectedModelIdByContext.value[normalizedThreadId]))
  }

  function readReasoningEffortForThread(threadId: string): ReasoningEffort | '' {
    return readThreadModelPreference(threadId)?.reasoningEffort || runtimeDefaultReasoningEffort
  }

  function cacheThreadModelPreference(threadId: string, preference: ThreadModelPreference): void {
    const normalizedThreadId = threadId.trim()
    const normalizedModelId = preference.model.trim()
    if (!normalizedThreadId || !normalizedModelId || !REASONING_EFFORT_OPTIONS.includes(preference.reasoningEffort)) return

    const normalizedPreference: ThreadModelPreference = {
      model: normalizedModelId,
      reasoningEffort: preference.reasoningEffort,
    }
    threadModelPreferencesById.value = {
      ...threadModelPreferencesById.value,
      [normalizedThreadId]: normalizedPreference,
    }
    selectedModelIdByContext.value = {
      ...selectedModelIdByContext.value,
      [normalizedThreadId]: normalizedModelId,
    }
    ensureAvailableModelIds(normalizedModelId)
    saveSelectedModelMap(selectedModelIdByContext.value)

    if (selectedThreadId.value === normalizedThreadId) {
      selectedModelId.value = normalizedModelId
      selectedReasoningEffort.value = normalizedPreference.reasoningEffort
    }
  }

  function sameThreadModelPreference(
    first: ThreadModelPreference | null | undefined,
    second: ThreadModelPreference | null | undefined,
  ): boolean {
    return first?.model === second?.model && first?.reasoningEffort === second?.reasoningEffort
  }

  function queueThreadModelPreferenceWrite(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const snapshot = readThreadModelPreference(normalizedThreadId)
    if (!normalizedThreadId || !snapshot) return Promise.resolve()

    const previous = threadModelPreferenceWriteChainById.get(normalizedThreadId) ?? Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(async () => {
        const saved = await persistThreadModelPreference(normalizedThreadId, snapshot)
        if (sameThreadModelPreference(readThreadModelPreference(normalizedThreadId), snapshot)) {
          cacheThreadModelPreference(normalizedThreadId, saved)
        }
      })
      .catch((unknownError) => {
        error.value = unknownError instanceof Error
          ? unknownError.message
          : 'Failed to save the thread model preference'
      })
      .finally(() => {
        if (threadModelPreferenceWriteChainById.get(normalizedThreadId) === run) {
          threadModelPreferenceWriteChainById.delete(normalizedThreadId)
        }
      })
    threadModelPreferenceWriteChainById.set(normalizedThreadId, run)
    return run
  }

  function readProviderIdForThread(threadId: string): string {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return normalizeProviderContextId(activeProviderId.value)
    return normalizeProviderContextId(threadModelProviderByThreadId.value[normalizedThreadId] ?? activeProviderId.value)
  }

  function ensureAvailableModelIds(...modelIds: string[]): void {
    const nextModelIds = [...availableModelIds.value]
    for (const modelId of modelIds) {
      const normalizedModelId = modelId.trim()
      if (normalizedModelId && !nextModelIds.includes(normalizedModelId)) {
        nextModelIds.push(normalizedModelId)
      }
    }
    if (!areStringArraysEqual(availableModelIds.value, nextModelIds)) {
      availableModelIds.value = nextModelIds
    }
  }

  function readProviderCompatibleSelectedModel(modelId: string): string {
    const normalizedModelId = modelId.trim()
    if (availableModelIds.value.length === 0) return normalizedModelId
    if (normalizedModelId && availableModelIds.value.includes(normalizedModelId)) return normalizedModelId
    return availableModelIds.value[0] ?? ''
  }

  function reconcileSelectedReasoningEffort(modelId: string): boolean {
    const capability = availableModelCapabilities.value[modelId.trim()]
    const supported = capability?.supportedReasoningEfforts ?? []
    if (supported.length === 0 || supported.includes(selectedReasoningEffort.value as ReasoningEffort)) return false

    selectedReasoningEffort.value = capability.defaultReasoningEffort && supported.includes(capability.defaultReasoningEffort)
      ? capability.defaultReasoningEffort
      : supported[0] ?? ''
    return true
  }

  function setSelectedThreadId(nextThreadId: string, options: { persist?: boolean } = {}): void {
    if (selectedThreadId.value === nextThreadId) return
    const previousThreadId = selectedThreadId.value
    selectedThreadId.value = nextThreadId
    if (options.persist !== false) {
      saveSelectedThreadId(nextThreadId)
    }
    const preference = readThreadModelPreference(nextThreadId)
    if (!nextThreadId.trim() && previousThreadId.trim()) {
      newThreadSelectionInitialized = false
      newThreadDraftModelId = ''
    }
    const nextModelId = nextThreadId.trim()
      ? preference?.model ?? readModelIdForThread(nextThreadId)
      : newThreadDraftModelId || runtimeDefaultModelId
    selectedModelId.value = preference?.model ?? readProviderCompatibleSelectedModel(nextModelId)
    selectedReasoningEffort.value = preference?.reasoningEffort || runtimeDefaultReasoningEffort || selectedReasoningEffort.value
    reconcileSelectedReasoningEffort(selectedModelId.value)
    selectedCollaborationMode.value = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      nextThreadId,
    )
    activeReasoningItemIdByThreadId.delete(nextThreadId)
    shouldAutoScrollOnNextAgentEvent = false
  }

  function setSelectedModelIdForThread(threadId: string, modelId: string): void {
    const normalizedModelId = modelId.trim()
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      newThreadDraftModelId = normalizedModelId
      if (!selectedThreadId.value.trim()) {
        selectedModelId.value = normalizedModelId
        ensureAvailableModelIds(normalizedModelId)
        reconcileSelectedReasoningEffort(normalizedModelId)
      }
      return
    }
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[contextId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, contextId)
    }
    if (contextId === toThreadContextId(selectedThreadId.value)) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
      ensureAvailableModelIds(selectedModelId.value)
      reconcileSelectedReasoningEffort(selectedModelId.value)
    } else {
      ensureAvailableModelIds(normalizedModelId)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setSelectedModelId(modelId: string): void {
    setSelectedModelIdForThread(selectedThreadId.value, modelId)
  }

  function updateSelectedModelIdForThread(threadId: string, modelId: string): Promise<void> {
    setSelectedModelIdForThread(threadId, modelId)
    const normalizedThreadId = threadId.trim()
    if (toThreadContextId(threadId) === NEW_THREAD_COLLABORATION_MODE_CONTEXT) return Promise.resolve()

    const normalizedModelId = readModelIdForThread(normalizedThreadId)
    reconcileSelectedReasoningEffort(normalizedModelId)
    const reasoningEffort = selectedReasoningEffort.value || readReasoningEffortForThread(normalizedThreadId)
    if (!normalizedModelId || !reasoningEffort) return Promise.resolve()
    cacheThreadModelPreference(normalizedThreadId, {
      model: normalizedModelId,
      reasoningEffort,
    })
    return queueThreadModelPreferenceWrite(normalizedThreadId)
  }

  function setThreadModelId(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[normalizedThreadId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, normalizedThreadId)
    }
    ensureAvailableModelIds(normalizedModelId)
    if (selectedThreadId.value === normalizedThreadId) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setThreadModelProviderId(threadId: string, providerId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId) {
      threadModelProviderByThreadId.value = {
        ...threadModelProviderByThreadId.value,
        [normalizedThreadId]: normalizedProviderId,
      }
    } else if (threadModelProviderByThreadId.value[normalizedThreadId]) {
      threadModelProviderByThreadId.value = omitKey(threadModelProviderByThreadId.value, normalizedThreadId)
    }
  }

  function setThreadTokenUsage(threadId: string, usage: UiThreadTokenUsage | null): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    if (!usage) {
      if (!(normalizedThreadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
      saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
      return
    }

    const current = threadTokenUsageByThreadId.value[normalizedThreadId]
    if (current && JSON.stringify(current) === JSON.stringify(usage)) return

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [normalizedThreadId]: usage,
    }
    saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
  }

  function setSelectedCollaborationMode(mode: CollaborationModeKind): void {
    const nextMode: CollaborationModeKind = mode === 'plan' ? 'plan' : 'default'
    const contextId = toThreadContextId(selectedThreadId.value)
    const currentMode = readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value)
    if (currentMode === nextMode && selectedCollaborationMode.value === nextMode) return
    selectedCollaborationMode.value = nextMode
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      contextId,
      nextMode,
    )
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setSelectedCollaborationModeForThread(threadId: string, mode: CollaborationModeKind): void {
    const nextMode = mode === 'plan' ? 'plan' : 'default'
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      threadId,
      nextMode,
    )
    if (threadId.trim() === selectedThreadId.value) {
      selectedCollaborationMode.value = nextMode
    }
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setCodexRateLimit(nextSnapshot: UiRateLimitSnapshot | null): void {
    codexRateLimit.value = nextSnapshot
  }

  async function applyFallbackModelSelection(threadId: string = selectedThreadId.value): Promise<void> {
    if (threadId.trim()) {
      setThreadModelId(threadId, MODEL_FALLBACK_ID)
      reconcileSelectedReasoningEffort(MODEL_FALLBACK_ID)
      const reasoningEffort = selectedReasoningEffort.value || readReasoningEffortForThread(threadId)
      if (reasoningEffort) {
        cacheThreadModelPreference(threadId, {
          model: MODEL_FALLBACK_ID,
          reasoningEffort,
        })
        void queueThreadModelPreferenceWrite(threadId)
      }
    } else {
      setSelectedModelId(MODEL_FALLBACK_ID)
      reconcileSelectedReasoningEffort(MODEL_FALLBACK_ID)
    }
    ensureAvailableModelIds(MODEL_FALLBACK_ID)
  }

  function setPendingTurnRequest(threadId: string, request: PendingTurnRequest): void {
    pendingTurnRequestByThreadId.value = {
      ...pendingTurnRequestByThreadId.value,
      [threadId]: request,
    }
  }

  function clearPendingTurnRequest(threadId: string): void {
    if (!pendingTurnRequestByThreadId.value[threadId]) return
    pendingTurnRequestByThreadId.value = omitKey(pendingTurnRequestByThreadId.value, threadId)
  }



  async function retryPendingTurnWithFallback(threadId: string): Promise<void> {
    if (fallbackRetryInFlightThreadIds.has(threadId)) return
    const pending = pendingTurnRequestByThreadId.value[threadId]
    if (!pending || pending.fallbackRetried) return

    if (readThreadHistoryMode(threadId) === 'paginated') {
      const message = 'Automatic model fallback cannot replay a paginated thread because Codex does not support rollback for this history mode.'
      setTurnErrorForThread(threadId, message)
      error.value = message
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      clearPendingTurnRequest(threadId)
      return
    }

    fallbackRetryInFlightThreadIds.add(threadId)
    setPendingTurnRequest(threadId, {
      ...pending,
      fallbackRetried: true,
    })

    try {
      await applyFallbackModelSelection(threadId)
      // Remove the failed user turn before replaying on fallback model to avoid duplicated user messages.
      try {
        const rolledBackMessages = await rollbackThread(threadId, 1)
        setPersistedMessagesForThread(threadId, rolledBackMessages)
        clearLivePlansForThread(threadId)
        setLiveAgentMessagesForThread(threadId, [])
        clearLiveReasoningForThread(threadId)
        if (liveCommandsByThreadId.value[threadId]) {
          liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
        }
      } catch {
        // If rollback fails, continue with retry rather than dropping the turn.
      }
      setTurnErrorForThread(threadId, null)
      error.value = ''
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, {
        label: THINKING_ACTIVITY_LABEL,
        details: buildPendingTurnDetails(
          MODEL_FALLBACK_ID,
          pending.effort,
          pending.collaborationMode,
          pending.speedMode,
        ),
      })
      setThreadInProgress(threadId, true)

      if (resumedThreadById.value[threadId] !== true) {
        const resumedThread = await resumeThread(threadId)
        if (resumedThread.model && !readThreadModelPreference(threadId) && !hasCachedThreadModelSelection(threadId)) {
          setThreadModelId(threadId, resumedThread.model.trim())
        }
        if (resumedThread.modelProvider) {
          setThreadModelProviderId(threadId, resumedThread.modelProvider)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }

      await startThreadTurn(
        threadId,
        pending.text,
        pending.imageUrls,
        MODEL_FALLBACK_ID,
        pending.effort || undefined,
        pending.skills.length > 0 ? pending.skills : undefined,
        pending.fileAttachments,
        pending.collaborationMode,
        serviceTierForSpeedMode(pending.speedMode, MODEL_FALLBACK_ID),
      )

      scheduleRateLimitRefresh()
      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
    } finally {
      fallbackRetryInFlightThreadIds.delete(threadId)
    }
  }

  function setSelectedReasoningEffort(effort: ReasoningEffort | ''): void {
    if (effort && !REASONING_EFFORT_OPTIONS.includes(effort)) {
      return
    }
    selectedReasoningEffort.value = effort
  }

  function updateSelectedReasoningEffort(effort: ReasoningEffort | ''): Promise<void> {
    setSelectedReasoningEffort(effort)
    const threadId = selectedThreadId.value.trim()
    const model = readModelIdForThread(threadId)
    if (!threadId || !model || !effort) return Promise.resolve()
    cacheThreadModelPreference(threadId, { model, reasoningEffort: effort })
    return queueThreadModelPreferenceWrite(threadId)
  }

  async function updateSelectedSpeedMode(mode: SpeedMode): Promise<void> {
    const nextMode: SpeedMode = mode === 'fast' ? 'fast' : 'standard'
    if (isUpdatingSpeedMode.value || selectedSpeedMode.value === nextMode) {
      return
    }

    if (nextMode === 'fast') {
      const contextId = selectedThreadId.value.trim() || NEW_THREAD_COLLABORATION_MODE_CONTEXT
      if (!isFastModeSupportedForModel(readModelIdForThread(contextId))) {
        error.value = 'Fast mode is not available for the selected model.'
        return
      }
    }

    const previousMode = selectedSpeedMode.value
    selectedSpeedMode.value = nextMode
    isUpdatingSpeedMode.value = true
    error.value = ''

    try {
      await setCodexSpeedMode(nextMode)
    } catch (unknownError) {
      selectedSpeedMode.value = previousMode
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to update Fast mode'
    } finally {
      isUpdatingSpeedMode.value = false
    }
  }

  async function refreshCodexRuntimeConfig(): Promise<void> {
    try {
      const currentConfig = await getCodexRuntimeConfig()
      if (!hasPersistedCodexPermissionMode) {
        selectedCodexPermissionMode.value = codexRuntimeConfigToPermissionMode(currentConfig)
        return
      }

      if (!runtimeConfigMatchesPermissionMode(currentConfig, selectedCodexPermissionMode.value)) {
        await setCodexRuntimeConfig(codexPermissionModeToRuntimeConfig(selectedCodexPermissionMode.value))
      }
    } catch {
      // Runtime config is best-effort; chat can still work with the server's current defaults.
    }
  }

  async function updateSelectedCodexPermissionMode(mode: CodexPermissionMode): Promise<void> {
    const nextMode = normalizeCodexPermissionMode(mode) ?? 'full-access'
    if (isUpdatingPermissionMode.value || selectedCodexPermissionMode.value === nextMode) {
      return
    }

    const previousMode = selectedCodexPermissionMode.value
    const previousHadPersistedMode = hasPersistedCodexPermissionMode
    selectedCodexPermissionMode.value = nextMode
    saveSelectedCodexPermissionMode(nextMode)
    hasPersistedCodexPermissionMode = true
    isUpdatingPermissionMode.value = true
    error.value = ''

    try {
      await setCodexRuntimeConfig(codexPermissionModeToRuntimeConfig(nextMode))
    } catch (unknownError) {
      selectedCodexPermissionMode.value = previousMode
      hasPersistedCodexPermissionMode = previousHadPersistedMode
      if (previousHadPersistedMode) {
        saveSelectedCodexPermissionMode(previousMode)
      } else {
        clearSelectedCodexPermissionMode()
      }
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to update Codex permissions'
    } finally {
      isUpdatingPermissionMode.value = false
    }
  }

  async function refreshCollaborationModes(): Promise<void> {
    try {
      const modes = await getAvailableCollaborationModes()
      availableCollaborationModes.value = modes
      if (!modes.some((mode) => mode.value === selectedCollaborationMode.value)) {
        setSelectedCollaborationMode('default')
      }
    } catch {
      // Keep the last known collaboration mode choices on transient failures.
    }
  }

  function buildPendingTurnDetails(
    modelId: string,
    effort: ReasoningEffort | '',
    collaborationMode: CollaborationModeKind = selectedCollaborationMode.value,
    speedMode: SpeedMode = selectedSpeedMode.value,
  ): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    const modeLabel = collaborationMode === 'plan' ? 'Plan' : 'Default'
    const speedLabel = serviceTierForSpeedMode(speedMode, modelId) === 'fast' ? 'Fast' : 'Standard'
    return [`Mode: ${modeLabel}`, `Model: ${modelLabel}`, `Thinking: ${effortLabel}`, `Speed: ${speedLabel}`]
  }

  async function loadAvailableModelCatalog(options: {
    includeProviderModels: boolean
    requireProviderModels: boolean
    providerId?: string
  }): Promise<UiModelCapability[]> {
    const key = JSON.stringify([
      options.includeProviderModels,
      options.requireProviderModels,
      options.providerId?.trim() ?? '',
    ])
    if (
      key === lastModelCatalogKey
      && Date.now() - lastModelCatalogAt < RECENT_MODEL_CATALOG_REUSE_MS
    ) {
      return lastModelCatalog
    }

    const pending = modelCatalogPromiseByKey.get(key)
    if (pending) return await pending

    const request = getAvailableModels(options)
      .then((models) => {
        const nextFastModeSupportByModelId = { ...fastModeSupportByModelId.value }
        for (const model of models) {
          nextFastModeSupportByModelId[model.id] = model.supportsFastMode
        }
        fastModeSupportByModelId.value = nextFastModeSupportByModelId
        lastModelCatalog = models
        lastModelCatalogKey = key
        lastModelCatalogAt = Date.now()
        return models
      })
      .finally(() => {
        modelCatalogPromiseByKey.delete(key)
      })
    modelCatalogPromiseByKey.set(key, request)
    return await request
  }

  async function loadThreadModelPreferencesIfNeeded(): Promise<void> {
    if (hasLoadedThreadModelPreferences) return
    let persisted: ThreadModelPreferenceState
    try {
      persisted = await getThreadModelPreferences()
    } catch (unknownError) {
      error.value = unknownError instanceof Error
        ? unknownError.message
        : 'Failed to load thread model preferences'
      return
    }
    threadModelPreferencesById.value = persisted

    const nextModelMap = createStringKeyedRecord<string>()
    for (const [contextId, modelId] of Object.entries(selectedModelIdByContext.value)) {
      if (
        contextId !== NEW_THREAD_COLLABORATION_MODE_CONTEXT
        && !contextId.startsWith(NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX)
      ) {
        nextModelMap[contextId] = modelId
      }
    }
    for (const [threadId, preference] of Object.entries(persisted)) {
      nextModelMap[threadId] = preference.model
    }
    ensureAvailableModelIds(...Object.values(persisted).map((preference) => preference.model))
    selectedModelIdByContext.value = nextModelMap
    saveSelectedModelMap(nextModelMap)

    const selectedPreference = readThreadModelPreference(selectedThreadId.value)
    if (selectedPreference) {
      selectedModelId.value = selectedPreference.model
      selectedReasoningEffort.value = selectedPreference.reasoningEffort
    }
    hasLoadedThreadModelPreferences = true
  }

  async function refreshModelPreferences(options?: { providerChanged?: boolean; includeProviderModels?: boolean }): Promise<void> {
    codexCliMissingError.value = ''
    try {
      const currentConfig = await getCurrentModelConfig()
      const normalizedConfiguredModelId = currentConfig.model.trim()
      runtimeDefaultModelId = normalizedConfiguredModelId
      runtimeDefaultReasoningEffort = currentConfig.reasoningEffort
      const normalizedProviderId = normalizeProviderContextId(currentConfig.providerId)
      activeProviderId.value = normalizedProviderId
      const targetProviderId = readProviderIdForThread(selectedThreadId.value)
      const isProviderBacked = targetProviderId !== 'codex'
      const selectedThreadPreference = readThreadModelPreference(selectedThreadId.value)
      const isNewThreadContext = selectedThreadId.value.trim().length === 0
      if (isNewThreadContext && options?.providerChanged) {
        newThreadSelectionInitialized = false
        newThreadDraftModelId = ''
      }
      const normalizedSelectedModelId = isNewThreadContext && !newThreadSelectionInitialized
        ? normalizedConfiguredModelId
        : selectedThreadPreference?.model ?? readModelIdForThread(selectedThreadId.value)
      const models = await loadAvailableModelCatalog({
        includeProviderModels: isProviderBacked || options?.includeProviderModels !== false,
        requireProviderModels: isProviderBacked,
        providerId: isProviderBacked ? targetProviderId : undefined,
      })
      const modelIds = models.map((model) => model.id)
      availableModelCapabilities.value = Object.fromEntries(models.map((model) => [model.id, model]))
      const providerModelContextId = toProviderModelContextId(targetProviderId)
      const providerScopedModelId = providerModelContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerModelContextId])
        : ''
      const nextModelIds = [...modelIds]
      if (selectedThreadPreference?.model && !nextModelIds.includes(selectedThreadPreference.model)) {
        nextModelIds.push(selectedThreadPreference.model)
      }
      if (
        !options?.providerChanged
        && isProviderBacked
        && targetProviderId === normalizedProviderId
        && normalizedConfiguredModelId
        && !nextModelIds.includes(normalizedConfiguredModelId)
      ) {
        nextModelIds.push(normalizedConfiguredModelId)
      }
      availableModelIds.value = nextModelIds

      const currentModelInNewList = normalizedSelectedModelId && nextModelIds.includes(normalizedSelectedModelId)
      if (!normalizedSelectedModelId || !currentModelInNewList || options?.providerChanged) {
        if (options?.providerChanged && nextModelIds.length > 0) {
          if (providerScopedModelId && modelIds.includes(providerScopedModelId)) {
            setSelectedModelId(providerScopedModelId)
          } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
            setSelectedModelId(normalizedConfiguredModelId)
          } else {
            setSelectedModelId(nextModelIds[0])
          }
        } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
          setSelectedModelId(currentConfig.model)
        } else if (nextModelIds.length > 0) {
          setSelectedModelId(nextModelIds[0])
        } else {
          setSelectedModelId('')
        }
      } else if (selectedModelId.value.trim() !== normalizedSelectedModelId) {
        setSelectedModelId(normalizedSelectedModelId)
      }
      if (!isNewThreadContext && providerModelContextId && selectedModelId.value.trim().length > 0) {
        const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
        nextModelMap[providerModelContextId] = selectedModelId.value.trim()
        const activeProviderModelContextId = toProviderModelContextId(normalizedProviderId)
        if (
          activeProviderModelContextId
          && activeProviderModelContextId !== providerModelContextId
          && normalizedConfiguredModelId
        ) {
          nextModelMap[activeProviderModelContextId] = normalizedConfiguredModelId
        }
        selectedModelIdByContext.value = nextModelMap
        saveSelectedModelMap(selectedModelIdByContext.value)
      }

      if (selectedThreadPreference) {
        selectedReasoningEffort.value = selectedThreadPreference.reasoningEffort
      } else if (
        currentConfig.reasoningEffort
        && REASONING_EFFORT_OPTIONS.includes(currentConfig.reasoningEffort)
        && (!isNewThreadContext || !newThreadSelectionInitialized)
      ) {
        selectedReasoningEffort.value = currentConfig.reasoningEffort
      }
      reconcileSelectedReasoningEffort(selectedModelId.value)
      if (isNewThreadContext) {
        newThreadSelectionInitialized = true
      } else {
        const model = readModelIdForThread(selectedThreadId.value)
        const reasoningEffort = selectedReasoningEffort.value
        if (model && reasoningEffort) {
          const nextPreference = { model, reasoningEffort }
          if (!sameThreadModelPreference(selectedThreadPreference, nextPreference)) {
            cacheThreadModelPreference(selectedThreadId.value, nextPreference)
            void queueThreadModelPreferenceWrite(selectedThreadId.value)
          }
        }
      }
      selectedSpeedMode.value = currentConfig.speedMode
    } catch (unknownError) {
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  async function refreshRateLimits(): Promise<void> {
    if (rateLimitRefreshPromise) {
      await rateLimitRefreshPromise
      return
    }

    rateLimitRefreshPromise = (async () => {
      try {
        const snapshot = await getAccountRateLimits()
        setCodexRateLimit(snapshot)
        accountRateLimitSnapshots.value = snapshot ? [snapshot] : []
      } catch {
        // Keep the last known rate-limit state if the endpoint is temporarily unavailable.
      } finally {
        rateLimitRefreshPromise = null
      }
    })()

    await rateLimitRefreshPromise
  }

  function scheduleRateLimitRefresh(): void {
    if (typeof window === 'undefined') {
      void refreshRateLimits()
      return
    }

    if (rateLimitRefreshTimer !== null) {
      window.clearTimeout(rateLimitRefreshTimer)
    }

    rateLimitRefreshTimer = window.setTimeout(() => {
      rateLimitRefreshTimer = null
      void refreshRateLimits()
    }, RATE_LIMIT_REFRESH_DEBOUNCE_MS)
  }

  function clearDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    const timerId = delayedTurnSyncTimerByThreadId.get(threadId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    delayedTurnSyncTimerByThreadId.delete(threadId)
  }

  function scheduleDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    clearDelayedTurnSync(threadId)
    const timerId = window.setTimeout(() => {
      delayedTurnSyncTimerByThreadId.delete(threadId)
      pendingThreadMessageRefresh.add(threadId)
      void syncFromNotifications()
    }, TURN_START_FOLLOW_UP_SYNC_DELAY_MS)
    delayedTurnSyncTimerByThreadId.set(threadId, timerId)
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  function getThreadPendingRequests(threadId: string): UiServerRequest[] {
    if (!threadId) return []
    return Array.isArray(pendingServerRequestsByThreadId.value[threadId])
      ? pendingServerRequestsByThreadId.value[threadId]
      : []
  }

  function isApprovalRequestMethod(method: string): boolean {
    return (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    )
  }

  function readPendingRequestState(requests: UiServerRequest[]): UiPendingRequestState | null {
    if (requests.some((request) => isApprovalRequestMethod(request.method))) {
      return 'approval'
    }
    return requests.length > 0 ? 'response' : null
  }

  function applyThreadFlags(): void {
    const withTitles = applyCachedTitlesToGroups(sourceGroups.value)
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = inProgressById.value[thread.id] === true
        const pendingRequestState = readPendingRequestState(getThreadPendingRequests(thread.id))
        const isSelected = selectedThreadId.value === thread.id
        const unreadByEvent = eventUnreadByThreadId.value[thread.id] === true
        const unreadByTime = isThreadUnreadByLastRead(
          thread.updatedAtIso,
          readStateByThreadId.value[thread.id],
          unreadCutoffIso.value,
        )
        const unread = !isSelected && !inProgress && (unreadByEvent || unreadByTime)

        return {
          ...thread,
          inProgress,
          unread,
          pendingRequestState,
        }
      }),
    }))
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function insertOptimisticThread(threadId: string, cwd: string, firstMessageText: string): void {
    const nowIso = new Date().toISOString()
    const normalizedCwd = normalizePathForUi(cwd)
    const projectName = toProjectName(normalizedCwd)
    const nextThread: UiThread = {
      id: threadId,
      title: toOptimisticThreadTitle(firstMessageText),
      projectName,
      cwd: normalizedCwd,
      hasWorktree: normalizedCwd.includes('/.codex/worktrees/') || normalizedCwd.includes('/.git/worktrees/'),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      preview: firstMessageText,
      unread: false,
      inProgress: false,
      historyMode: 'legacy',
    }

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const remainingThreads = existingGroup.threads.filter((thread) => thread.id !== threadId)
      const nextGroup: UiProjectGroup = {
        projectName,
        threads: [nextThread, ...remainingThreads],
      }
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, nextGroup)
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [{ projectName, threads: [nextThread] }, ...sourceGroups.value]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }
    applyThreadFlags()
  }

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    const currentThreadId = selectedThreadId.value.trim()
    if (currentThreadId) {
      activeThreadIds.add(currentThreadId)
    }
    for (const threadId of latestRuntimeStateByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) latestRuntimeStateByThreadId.delete(threadId)
    }
    for (const threadId of terminalTurnAtMsByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) terminalTurnAtMsByThreadId.delete(threadId)
    }
    for (const threadId of runtimeStateLifecycleEpochByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) runtimeStateLifecycleEpochByThreadId.delete(threadId)
    }
    for (const threadId of lastAppliedRuntimeRequestByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) lastAppliedRuntimeRequestByThreadId.delete(threadId)
    }
    for (const threadId of optimisticTurnStartedAtByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) optimisticTurnStartedAtByThreadId.delete(threadId)
    }
    for (const key of paginatedTurnReconcileByKey.keys()) {
      const separatorIndex = key.indexOf('\u0000')
      const threadId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key
      if (!activeThreadIds.has(threadId)) paginatedTurnReconcileByKey.delete(key)
    }
    for (const threadId of threadHistoryAccessOrderByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) threadHistoryAccessOrderByThreadId.delete(threadId)
    }
    const nextSelectedModelMap = pruneThreadContextStateMap(selectedModelIdByContext.value, activeThreadIds)
    if (nextSelectedModelMap !== selectedModelIdByContext.value) {
      selectedModelIdByContext.value = nextSelectedModelMap
      selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(selectedThreadId.value))
      saveSelectedModelMap(nextSelectedModelMap)
    }
    const nextSelectedCollaborationModeMap = pruneThreadContextStateMap(
      selectedCollaborationModeByContext.value,
      activeThreadIds,
    )
    if (nextSelectedCollaborationModeMap !== selectedCollaborationModeByContext.value) {
      selectedCollaborationModeByContext.value = nextSelectedCollaborationModeMap
      selectedCollaborationMode.value = readSelectedCollaborationMode(
        nextSelectedCollaborationModeMap,
        selectedThreadId.value,
      )
      saveSelectedCollaborationModeMap(nextSelectedCollaborationModeMap)
    }
    const nextReadState = pruneThreadStateMap(readStateByThreadId.value, activeThreadIds)
    if (nextReadState !== readStateByThreadId.value) {
      readStateByThreadId.value = nextReadState
      saveReadStateMap(nextReadState)
    }
    loadedMessagesByThreadId.value = pruneThreadStateMap(loadedMessagesByThreadId.value, activeThreadIds)
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    threadHistoryStateById.value = pruneThreadStateMap(threadHistoryStateById.value, activeThreadIds)
    hasMoreOlderMessagesByThreadId.value = pruneThreadStateMap(hasMoreOlderMessagesByThreadId.value, activeThreadIds)
    loadingOlderMessagesByThreadId.value = pruneThreadStateMap(loadingOlderMessagesByThreadId.value, activeThreadIds)
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    turnIndexByTurnIdByThreadId.value = pruneThreadStateMap(turnIndexByTurnIdByThreadId.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
    liveAgentMessagesByThreadId.value = pruneThreadStateMap(liveAgentMessagesByThreadId.value, activeThreadIds)
    liveReasoningTextByThreadId.value = pruneThreadStateMap(liveReasoningTextByThreadId.value, activeThreadIds)
    liveCommandsByThreadId.value = pruneThreadStateMap(liveCommandsByThreadId.value, activeThreadIds)
    liveFileChangeMessagesByThreadId.value = pruneThreadStateMap(liveFileChangeMessagesByThreadId.value, activeThreadIds)
    agentProgressByThreadId.value = pruneThreadStateMap(agentProgressByThreadId.value, activeThreadIds)
    turnSummaryByThreadId.value = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    activeTurnIdByThreadId.value = pruneThreadStateMap(activeTurnIdByThreadId.value, activeThreadIds)
    interruptBlockedUntilPersistedByThreadId.value = pruneThreadStateMap(
      interruptBlockedUntilPersistedByThreadId.value,
      activeThreadIds,
    )
    threadListedByServerById.value = pruneThreadStateMap(threadListedByServerById.value, activeThreadIds)
    persistedUserMessageByThreadId.value = pruneThreadStateMap(persistedUserMessageByThreadId.value, activeThreadIds)
    threadModelProviderByThreadId.value = pruneThreadStateMap(threadModelProviderByThreadId.value, activeThreadIds)
    const nextQueuedMessages = pruneThreadStateMap(queuedMessagesByThreadId.value, activeThreadIds)
    if (nextQueuedMessages !== queuedMessagesByThreadId.value) {
      queuedMessagesByThreadId.value = nextQueuedMessages
      persistQueueState()
    }
    threadTokenUsageByThreadId.value = pruneThreadStateMap(threadTokenUsageByThreadId.value, activeThreadIds)
    eventUnreadByThreadId.value = pruneThreadStateMap(eventUnreadByThreadId.value, activeThreadIds)
    inProgressById.value = pruneThreadStateMap(inProgressById.value, activeThreadIds)
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending
  }

  function markThreadAsRead(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    if (!thread) return

    readStateByThreadId.value = {
      ...readStateByThreadId.value,
      [threadId]: thread.updatedAtIso,
    }
    saveReadStateMap(readStateByThreadId.value)
    if (eventUnreadByThreadId.value[threadId]) {
      eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
    }
    applyThreadFlags()
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId]
    if (summary) {
      if (areTurnSummariesEqual(previous, summary)) return
      turnSummaryByThreadId.value = {
        ...turnSummaryByThreadId.value,
        [threadId]: summary,
      }
    } else {
      if (previous) {
        turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      }
    }
  }

  function setThreadInProgress(
    threadId: string,
    nextInProgress: boolean,
    options: { requestRuntimeReconcile?: boolean } = {},
  ): void {
    if (!threadId) return
    const currentValue = inProgressById.value[threadId] === true
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      invalidateAgentProgressLoadForThread(threadId)
      inProgressById.value = omitKey(inProgressById.value, threadId)
      clearCompletedTurnLiveState(threadId)
      clearInterruptPersistenceGate(threadId)
    }
    applyThreadFlags()
    if (nextInProgress && stopNotificationStream && options.requestRuntimeReconcile !== false) {
      threadRuntimePolling.requestImmediate()
    }
    if (!nextInProgress && !hasActiveInProgressThreads() && threadListLoader.hasRemaining()) {
      threadListLoader.scheduleRemaining()
    }
  }

  function clearInterruptPersistenceGate(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId]) {
      interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, threadId)
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function blockInterruptUntilThreadIsPersisted(threadId: string): void {
    if (!threadId) return
    interruptBlockedUntilPersistedByThreadId.value = {
      ...interruptBlockedUntilPersistedByThreadId.value,
      [threadId]: true,
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function maybeUnblockInterruptForPersistedThread(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (threadListedByServerById.value[threadId] !== true) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function maybeUnblockInterruptForActiveTurn(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function markServerListedThreads(serverThreadIds: Set<string>): void {
    const pendingThreadIds = Object.keys(interruptBlockedUntilPersistedByThreadId.value)
    if (pendingThreadIds.length === 0) return

    let nextListedState = threadListedByServerById.value
    let changed = false
    for (const threadId of pendingThreadIds) {
      if (!serverThreadIds.has(threadId) || nextListedState[threadId] === true) continue
      nextListedState = {
        ...nextListedState,
        [threadId]: true,
      }
      changed = true
    }

    if (!changed) return
    threadListedByServerById.value = nextListedState
    for (const threadId of pendingThreadIds) {
      maybeUnblockInterruptForPersistedThread(threadId)
    }
  }

  function markThreadMessagesPersisted(threadId: string, messages: UiMessage[]): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (!messages.some((message) => message.role === 'user')) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) {
      persistedUserMessageByThreadId.value = {
        ...persistedUserMessageByThreadId.value,
        [threadId]: true,
      }
    }
    maybeUnblockInterruptForPersistedThread(threadId)
  }

  function markThreadUnreadByEvent(threadId: string): void {
    if (!threadId) return
    if (threadId === selectedThreadId.value) return
    if (eventUnreadByThreadId.value[threadId] === true) return
    eventUnreadByThreadId.value = {
      ...eventUnreadByThreadId.value,
      [threadId]: true,
    }
    applyThreadFlags()
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }

    const normalizedLabel = sanitizeDisplayText(activity.label) || THINKING_ACTIVITY_LABEL
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(
    threadId: string,
    message: string | null,
    options: { transient?: boolean } = {},
  ): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    const transient = options.transient === true
    if (previous?.message === normalizedMessage && previous.transient === transient) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage, transient },
    }
  }

  function clearTransientTurnErrorForThread(threadId: string): void {
    if (!threadId) return
    if (!turnErrorByThreadId.value[threadId]?.transient) return
    setTurnErrorForThread(threadId, null)
  }

  function clearAllTransientTurnErrors(): void {
    const transientThreadIds = Object.entries(turnErrorByThreadId.value)
      .filter(([, state]) => state?.transient)
      .map(([threadId]) => threadId)
    if (transientThreadIds.length === 0) return

    let nextState = turnErrorByThreadId.value
    for (const threadId of transientThreadIds) {
      nextState = omitKey(nextState, threadId)
    }
    turnErrorByThreadId.value = nextState
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function listedThreadHistoryMode(threadId: string): ThreadHistoryMode | null {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    if (!thread) return null
    return thread.historyMode === 'paginated' ? 'paginated' : 'legacy'
  }

  function knownThreadHistoryMode(threadId: string): ThreadHistoryMode | null {
    return listedThreadHistoryMode(threadId) ?? threadHistoryStateById.value[threadId]?.mode ?? null
  }

  function readThreadHistoryMode(threadId: string): ThreadHistoryMode {
    return knownThreadHistoryMode(threadId) ?? 'legacy'
  }

  function mergeTurnIds(first: string[], second: string[]): string[] {
    const seen = new Set<string>()
    const merged: string[] = []
    for (const turnId of [...first, ...second]) {
      const normalized = turnId.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      merged.push(normalized)
    }
    return merged
  }

  function invalidateThreadHistoryCache(threadId: string, mode: ThreadHistoryMode): void {
    const cached = threadHistoryStateById.value[threadId]
    if (!cached || cached.mode === mode) return
    threadHistoryStateById.value = omitKey(threadHistoryStateById.value, threadId)
    loadedMessagesByThreadId.value = omitKey(loadedMessagesByThreadId.value, threadId)
    loadedVersionByThreadId.value = omitKey(loadedVersionByThreadId.value, threadId)
    hasMoreOlderMessagesByThreadId.value = omitKey(hasMoreOlderMessagesByThreadId.value, threadId)
    loadingOlderMessagesByThreadId.value = omitKey(loadingOlderMessagesByThreadId.value, threadId)
    resumedThreadById.value = omitKey(resumedThreadById.value, threadId)
    turnIndexByTurnIdByThreadId.value = omitKey(turnIndexByTurnIdByThreadId.value, threadId)
    persistedMessagesByThreadId.value = omitKey(persistedMessagesByThreadId.value, threadId)
    lastMessageLoadAtByThreadId.delete(threadId)
    lastMessageLoadFailureAtByThreadId.delete(threadId)
    threadHistoryAccessOrderByThreadId.delete(threadId)
    const reconciliationPrefix = `${threadId}\u0000`
    for (const key of paginatedTurnReconcileByKey.keys()) {
      if (key.startsWith(reconciliationPrefix)) paginatedTurnReconcileByKey.delete(key)
    }
  }

  function hasPaginatedTurnReconciliation(threadId: string): boolean {
    const prefix = `${threadId}\u0000`
    for (const key of paginatedTurnReconcileByKey.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  function evictThreadHistoryCache(threadId: string): void {
    threadHistoryStateById.value = omitKey(threadHistoryStateById.value, threadId)
    persistedMessagesByThreadId.value = omitKey(persistedMessagesByThreadId.value, threadId)
    loadedMessagesByThreadId.value = omitKey(loadedMessagesByThreadId.value, threadId)
    loadedVersionByThreadId.value = omitKey(loadedVersionByThreadId.value, threadId)
    hasMoreOlderMessagesByThreadId.value = omitKey(hasMoreOlderMessagesByThreadId.value, threadId)
    loadingOlderMessagesByThreadId.value = omitKey(loadingOlderMessagesByThreadId.value, threadId)
    resumedThreadById.value = omitKey(resumedThreadById.value, threadId)
    turnIndexByTurnIdByThreadId.value = omitKey(turnIndexByTurnIdByThreadId.value, threadId)
    lastMessageLoadAtByThreadId.delete(threadId)
    lastMessageLoadFailureAtByThreadId.delete(threadId)
    loadMessagePromiseByThreadId.delete(threadId)
    forcedMessageLoadPromiseByThreadId.delete(threadId)
    threadHistoryModeProbeByThreadId.delete(threadId)
    const reconciliationPrefix = `${threadId}\u0000`
    for (const key of paginatedTurnReconcileByKey.keys()) {
      if (key.startsWith(reconciliationPrefix)) paginatedTurnReconcileByKey.delete(key)
    }
    threadHistoryAccessOrderByThreadId.delete(threadId)
  }

  function enforceThreadHistoryCacheLimit(): void {
    const cachedThreadIds = new Set([
      ...Object.keys(threadHistoryStateById.value),
      ...Object.keys(persistedMessagesByThreadId.value),
      ...Object.keys(loadedMessagesByThreadId.value),
    ])
    if (cachedThreadIds.size <= MAX_CACHED_THREAD_HISTORIES) return

    const protectedThreadIds = new Set<string>()
    if (selectedThreadId.value) protectedThreadIds.add(selectedThreadId.value)
    for (const [threadId, isRunning] of Object.entries(inProgressById.value)) {
      if (isRunning) protectedThreadIds.add(threadId)
    }
    for (const threadId of cachedThreadIds) {
      if (
        loadMessagePromiseByThreadId.has(threadId)
        || threadHistoryModeProbeByThreadId.has(threadId)
        || hasPaginatedTurnReconciliation(threadId)
      ) {
        protectedThreadIds.add(threadId)
      }
    }

    const evictionCandidates = [...cachedThreadIds]
      .filter((threadId) => !protectedThreadIds.has(threadId))
      .sort((first, second) => (
        (threadHistoryAccessOrderByThreadId.get(first) ?? 0)
        - (threadHistoryAccessOrderByThreadId.get(second) ?? 0)
      ))
    let remainingCount = cachedThreadIds.size
    for (const threadId of evictionCandidates) {
      if (remainingCount <= MAX_CACHED_THREAD_HISTORIES) break
      evictThreadHistoryCache(threadId)
      remainingCount -= 1
    }
  }

  function touchThreadHistoryCache(threadId: string): void {
    threadHistoryAccessSequence += 1
    threadHistoryAccessOrderByThreadId.set(threadId, threadHistoryAccessSequence)
    enforceThreadHistoryCacheLimit()
  }

  function pruneRecentPaginatedTurnReconciliations(now = Date.now()): void {
    for (const [key, entry] of paginatedTurnReconcileByKey) {
      if (entry.settled && now - entry.createdAt >= RECENT_THREAD_MESSAGE_LOAD_REUSE_MS) {
        paginatedTurnReconcileByKey.delete(key)
      }
    }
    if (paginatedTurnReconcileByKey.size < MAX_RECENT_PAGINATED_RECONCILIATIONS) return
    const settledEntries = [...paginatedTurnReconcileByKey.entries()]
      .filter(([, entry]) => entry.settled)
      .sort(([, first], [, second]) => first.createdAt - second.createdAt)
    for (const [key] of settledEntries) {
      if (paginatedTurnReconcileByKey.size < MAX_RECENT_PAGINATED_RECONCILIATIONS) break
      paginatedTurnReconcileByKey.delete(key)
    }
  }

  function rememberThreadHistoryMode(threadId: string, mode: ThreadHistoryMode): void {
    const cached = threadHistoryStateById.value[threadId]
    if (cached?.mode === mode) return
    if (cached) invalidateThreadHistoryCache(threadId, mode)
    threadHistoryStateById.value = {
      ...threadHistoryStateById.value,
      [threadId]: {
        mode,
        initialized: false,
        materialized: false,
        olderCursor: null,
        hasMoreOlder: false,
        loadedTurnIds: [],
      },
    }
    touchThreadHistoryCache(threadId)
  }

  function resolveThreadHistoryMode(threadId: string): Promise<ThreadHistoryMode> {
    const knownMode = knownThreadHistoryMode(threadId)
    if (knownMode) return Promise.resolve(knownMode)

    const existing = threadHistoryModeProbeByThreadId.get(threadId)
    if (existing) return existing

    const probeGeneration = messageLoadGeneration
    const promise = getThreadSummary(threadId).then((summary) => {
      const listedMode = listedThreadHistoryMode(threadId)
      const mode = listedMode ?? (summary?.historyMode === 'paginated' ? 'paginated' : 'legacy')
      if (probeGeneration === messageLoadGeneration) rememberThreadHistoryMode(threadId, mode)
      return mode
    })
    threadHistoryModeProbeByThreadId.set(threadId, promise)
    void promise.finally(() => {
      if (threadHistoryModeProbeByThreadId.get(threadId) === promise) {
        threadHistoryModeProbeByThreadId.delete(threadId)
      }
    }).catch(() => undefined)
    return promise
  }

  function setThreadTerminalOpen(threadId: string, isOpen: boolean): void {
    if (!threadId) return
    const next = { ...terminalOpenByThreadId.value }
    if (isOpen) {
      next[threadId] = true
    } else {
      delete next[threadId]
    }
    terminalOpenByThreadId.value = next
    saveThreadTerminalOpenMap(next)
  }

  function toggleSelectedThreadTerminal(): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    setThreadTerminalOpen(threadId, !selectedThreadTerminalOpen.value)
  }

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    persistedMessagesByThreadId.value = {
      ...persistedMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setAgentProgressSnapshot(
    snapshot: UiTurnProgress,
    options: { authoritativeRuntime?: boolean } = {},
  ): void {
    const knownRuntimeState = latestRuntimeStateByThreadId.get(snapshot.rootThreadId)
    const activeTurnId = activeTurnIdByThreadId.value[snapshot.rootThreadId] ?? ''
    const expectedRunningTurnId = knownRuntimeState?.isRunning && knownRuntimeState.turnId
      ? knownRuntimeState.turnId
      : activeTurnId && !activeTurnId.startsWith('pending:')
        ? activeTurnId
        : ''
    const hasPendingActiveTurn = activeTurnId.startsWith('pending:')
    const snapshotMatchesExpectedTurn = Boolean(
      expectedRunningTurnId
      && snapshot.turnId === expectedRunningTurnId,
    )
    const permitsDifferentTurnSnapshot = snapshotMatchesExpectedTurn || hasPendingActiveTurn
    if (
      !options.authoritativeRuntime
      && expectedRunningTurnId
      && snapshot.turnId
      && snapshot.turnId !== expectedRunningTurnId
    ) return
    if (
      !options.authoritativeRuntime
      && expectedRunningTurnId
      && (!snapshot.turnId || snapshot.turnId === expectedRunningTurnId)
      && snapshot.status !== 'running'
    ) {
      snapshot = {
        ...snapshot,
        turnId: expectedRunningTurnId,
        status: 'running',
        phase: 'preparing',
      }
    }
    if (
      !options.authoritativeRuntime
      && knownRuntimeState
      && !knownRuntimeState.isRunning
      && knownRuntimeState.turnId
      && snapshot.status === 'running'
      && snapshot.turnId === knownRuntimeState.turnId
    ) return
    if (
      knownRuntimeState?.isRunning
      && knownRuntimeState.turnId
      && (!snapshot.turnId || snapshot.turnId === knownRuntimeState.turnId)
      && snapshot.status !== 'running'
    ) {
      snapshot = {
        ...snapshot,
        turnId: knownRuntimeState.turnId,
        status: 'running',
        phase: 'preparing',
      }
    }
    if (
      knownRuntimeState
      && !knownRuntimeState.isRunning
      && knownRuntimeState.turnId
      && snapshot.turnId !== knownRuntimeState.turnId
      && !snapshotMatchesExpectedTurn
    ) {
      const runtimeTerminalAtMs = knownRuntimeState.completedAtIso
        ? Date.parse(knownRuntimeState.completedAtIso)
        : knownRuntimeState.startedAtIso
          ? Date.parse(knownRuntimeState.startedAtIso)
          : NaN
      if (Number.isFinite(runtimeTerminalAtMs) && runtimeTerminalAtMs >= snapshot.mainLastActivityAtMs) return
    }
    const previous = agentProgressByThreadId.value[snapshot.rootThreadId]
    if (previous && !options.authoritativeRuntime) {
      const sameTurn = !previous.turnId || !snapshot.turnId || previous.turnId === snapshot.turnId
      const previousTerminal = previous.status === 'completed' || previous.status === 'failed' || previous.status === 'interrupted'
      if (
        !sameTurn
        && previous.status === 'running'
        && !permitsDifferentTurnSnapshot
      ) return
      if (sameTurn && previousTerminal && snapshot.status === 'running') return
      if (sameTurn && previous.status === 'completed' && snapshot.status === 'interrupted') return
      if (sameTurn && previous.status === 'failed' && snapshot.status === 'interrupted') return
      if (
        snapshot.updatedAtMs < previous.updatedAtMs
        && !(sameTurn && snapshot.status === 'completed' && previous.status === 'interrupted')
        && !(!sameTurn && snapshotMatchesExpectedTurn)
      ) return
    }
    const previousAgents = previous?.turnId === snapshot.turnId
      ? new Map(previous.agents.map((agent) => [agent.threadId, agent]))
      : new Map<string, UiTurnProgress['agents'][number]>()
    const agents = snapshot.agents.map((agent) => {
      const previousAgent = previousAgents.get(agent.threadId)
      if (!previousAgent) return agent
      return {
        ...agent,
        ...(previousAgent.resultText === undefined ? {} : { resultText: previousAgent.resultText }),
        ...(previousAgent.resultTruncated === undefined ? {} : { resultTruncated: previousAgent.resultTruncated }),
        ...(previousAgent.resultLoading === undefined ? {} : { resultLoading: previousAgent.resultLoading }),
        ...(previousAgent.resultError === undefined ? {} : { resultError: previousAgent.resultError }),
      }
    })
    agentProgressByThreadId.value = {
      ...agentProgressByThreadId.value,
      [snapshot.rootThreadId]: { ...snapshot, agents },
    }
    if (snapshot.status === 'completed' || snapshot.status === 'interrupted' || snapshot.status === 'failed') {
      recordTerminalTurn(snapshot.rootThreadId, snapshot.turnId, snapshot.updatedAtMs)
    }
    agentProgressRetryStateByThreadId.delete(snapshot.rootThreadId)
    lastAgentProgressLoadAtByThreadId.set(snapshot.rootThreadId, Date.now())
  }

  function recordAgentProgressLoadFailure(threadId: string): void {
    const previousFailureCount = agentProgressRetryStateByThreadId.get(threadId)?.consecutiveFailures ?? 0
    const consecutiveFailures = previousFailureCount + 1
    const exponent = Math.min(consecutiveFailures - 1, 4)
    const delayMs = Math.min(
      AGENT_PROGRESS_RETRY_BASE_DELAY_MS * (2 ** exponent),
      AGENT_PROGRESS_RETRY_MAX_DELAY_MS,
    )
    lastAgentProgressLoadAtByThreadId.delete(threadId)
    agentProgressRetryStateByThreadId.set(threadId, {
      consecutiveFailures,
      nextRetryAt: Date.now() + delayMs,
    })
  }

  function invalidateAgentProgressLoadForThread(threadId: string): void {
    if (!threadId) return
    agentProgressLoadEpochByThreadId.set(
      threadId,
      (agentProgressLoadEpochByThreadId.get(threadId) ?? 0) + 1,
    )
    agentProgressLoadPromiseByThreadId.delete(threadId)
    lastAgentProgressLoadAtByThreadId.delete(threadId)
    agentProgressRetryStateByThreadId.delete(threadId)
  }

  async function loadAgentProgressSnapshot(
    threadId: string,
    options: { force?: boolean; preserveOnNull?: boolean } = {},
  ): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    const pending = agentProgressLoadPromiseByThreadId.get(normalizedThreadId)
    if (pending) return pending
    const retryState = agentProgressRetryStateByThreadId.get(normalizedThreadId)
    if (!options.force && retryState && Date.now() < retryState.nextRetryAt) return
    if (
      !options.force &&
      Date.now() - (lastAgentProgressLoadAtByThreadId.get(normalizedThreadId) ?? 0) < RECENT_AGENT_PROGRESS_LOAD_REUSE_MS
    ) return
    const loadGeneration = agentProgressLoadGeneration
    const loadEpoch = agentProgressLoadEpochByThreadId.get(normalizedThreadId) ?? 0
    const isCurrentLoad = () => (
      loadGeneration === agentProgressLoadGeneration
      && loadEpoch === (agentProgressLoadEpochByThreadId.get(normalizedThreadId) ?? 0)
    )
    const loadPromise = (async () => {
      try {
        const snapshot = await getAgentProgress(normalizedThreadId)
        if (!isCurrentLoad()) return
        if (snapshot) {
          setAgentProgressSnapshot(snapshot)
        } else if (!options.preserveOnNull && normalizedThreadId in agentProgressByThreadId.value) {
          agentProgressByThreadId.value = omitKey(agentProgressByThreadId.value, normalizedThreadId)
        }
        if (!snapshot && inProgressById.value[normalizedThreadId] === true) {
          recordAgentProgressLoadFailure(normalizedThreadId)
        } else {
          agentProgressRetryStateByThreadId.delete(normalizedThreadId)
          lastAgentProgressLoadAtByThreadId.set(normalizedThreadId, Date.now())
        }
      } catch {
        if (!isCurrentLoad()) return
        recordAgentProgressLoadFailure(normalizedThreadId)
        // Notification connection state communicates outages without replacing usable progress data.
      }
    })().finally(() => {
      if (agentProgressLoadPromiseByThreadId.get(normalizedThreadId) === loadPromise) {
        agentProgressLoadPromiseByThreadId.delete(normalizedThreadId)
      }
    })
    agentProgressLoadPromiseByThreadId.set(normalizedThreadId, loadPromise)
    return loadPromise
  }

  function patchAgentResult(agentThreadId: string, patch: Partial<UiTurnProgress['agents'][number]>): void {
    for (const [rootThreadId, progress] of Object.entries(agentProgressByThreadId.value)) {
      const index = progress.agents.findIndex((agent) => agent.threadId === agentThreadId)
      if (index < 0) continue
      const agents = [...progress.agents]
      agents[index] = { ...agents[index], ...patch }
      agentProgressByThreadId.value = {
        ...agentProgressByThreadId.value,
        [rootThreadId]: { ...progress, agents },
      }
      return
    }
  }

  async function loadAgentResult(agentThreadId: string): Promise<void> {
    const normalizedThreadId = agentThreadId.trim()
    if (!normalizedThreadId) return
    const agent = Object.values(agentProgressByThreadId.value)
      .flatMap((progress) => progress.agents)
      .find((candidate) => candidate.threadId === normalizedThreadId)
    if (!agent?.resultAvailable || agent.resultLoading || agent.resultText !== undefined) return
    patchAgentResult(normalizedThreadId, { resultLoading: true, resultError: '' })
    try {
      const result = await getAgentResult(normalizedThreadId)
      patchAgentResult(normalizedThreadId, {
        resultLoading: false,
        resultText: result.text,
        resultTruncated: result.truncated,
        resultError: '',
      })
    } catch (unknownError) {
      patchAgentResult(normalizedThreadId, {
        resultLoading: false,
        resultError: unknownError instanceof Error ? unknownError.message : 'Failed to load agent result',
      })
    }
  }

  const liveDeltaBuffer = createLiveDeltaBuffer({
    flushMs: LIVE_DELTA_FLUSH_MS,
    agentTextMaxBytes: LIVE_AGENT_TEXT_MAX_BYTES,
    commandOutputMaxBytes: LIVE_COMMAND_OUTPUT_MAX_BYTES,
    reasoningTextMaxBytes: LIVE_REASONING_TEXT_MAX_BYTES,
    getAgentText: (threadId, itemId) => {
      const turnId = activeTurnIdByThreadId.value[threadId] ?? ''
      return (liveAgentMessagesByThreadId.value[threadId] ?? [])
        .find((message) => message.id === itemId && (!turnId || message.turnId === turnId))?.text ?? ''
    },
    setAgentText: (threadId, itemId, text) => {
      const turnId = activeTurnIdByThreadId.value[threadId] ?? ''
      upsertLiveAgentMessage(threadId, {
        id: itemId,
        role: 'assistant',
        text,
        messageType: 'agentMessage.live',
        turnId: turnId || undefined,
      })
    },
    updateCommandOutput: (threadId, itemId, update) => {
      const turnId = activeTurnIdByThreadId.value[threadId] ?? ''
      const current = (liveCommandsByThreadId.value[threadId] ?? [])
        .find((message) => message.id === itemId && (!turnId || message.turnId === turnId))
      if (!current?.commandExecution) return
      upsertLiveCommand(threadId, {
        ...current,
        commandExecution: {
          ...current.commandExecution,
          aggregatedOutput: update(current.commandExecution.aggregatedOutput),
        },
      })
    },
    getReasoningText: (threadId) => liveReasoningTextByThreadId.value[threadId] ?? '',
    setReasoningText: (threadId, text) => setLiveReasoningText(threadId, text),
  })

  function appendOptimisticUserMessage(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): void {
    const existing = persistedMessagesByThreadId.value[threadId] ?? []
    const nextMessage: UiMessage = {
      id: `optimistic-user:${threadId}:${Date.now()}`,
      role: 'user',
      text,
      images: imageUrls.length > 0 ? [...imageUrls] : undefined,
      skills: skills.length > 0 ? skills.map((skill) => ({ name: skill.name, path: skill.path })) : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map((file) => ({ ...file })) : undefined,
      messageType: 'userMessage.optimistic',
    }
    setPersistedMessagesForThread(threadId, [...existing, nextMessage])
  }

  function beginPendingNewThreadPreview(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): void {
    const nextText = text.trim()
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) return
    const current = pendingNewThreadMessages.value[0]
    const isSamePreview = pendingNewThreadMessages.value.length === 1
      && current?.text === nextText
      && areStringArraysEqual(current.images ?? [], imageUrls)
      && areStringArraysEqual((current.skills ?? []).map((skill) => skill.path), skills.map((skill) => skill.path))
      && areStringArraysEqual(
        (current.fileAttachments ?? []).map((file) => file.path),
        fileAttachments.map((file) => file.path),
      )
    pendingNewThreadPreviewError.value = ''
    if (isSamePreview) return
    pendingNewThreadMessages.value = [{
      id: `optimistic-user:new-thread:${Date.now()}`,
      role: 'user',
      text: nextText,
      images: imageUrls.length > 0 ? [...imageUrls] : undefined,
      skills: skills.length > 0 ? skills.map((skill) => ({ name: skill.name, path: skill.path })) : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map((file) => ({ ...file })) : undefined,
      messageType: 'userMessage.optimistic',
    }]
  }

  function clearPendingNewThreadPreview(): void {
    pendingNewThreadMessages.value = []
    pendingNewThreadPreviewError.value = ''
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveAgentMessagesByThreadId.value = {
      ...liveAgentMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function clearLiveAgentMessagesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveAgentMessagesByThreadId.value)) return
    liveAgentMessagesByThreadId.value = omitKey(liveAgentMessagesByThreadId.value, threadId)
  }

  function setLiveFileChangeMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLivePlanMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    livePlanMessagesByThreadId.value = {
      ...livePlanMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function upsertLivePlanMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLivePlanMessagesForThread(threadId, next)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveAgentMessagesForThread(threadId, next)
  }

  function upsertLiveFileChangeMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveFileChangeMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    if (!threadId) return
    const normalized = text
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    if (normalized.trim().length === 0) {
      if (!previous) return
      liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
      return
    }
    if (previous === normalized) return
    liveReasoningTextByThreadId.value = {
      ...liveReasoningTextByThreadId.value,
      [threadId]: normalized,
    }
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    if (!threadId) return
    liveDeltaBuffer.queueReasoningText(threadId, delta)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveReasoningTextByThreadId.value)) return
    liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
  }

  function clearLivePlansForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in livePlanMessagesByThreadId.value)) return
    livePlanMessagesByThreadId.value = omitKey(livePlanMessagesByThreadId.value, threadId)
  }

  function clearLiveFileChangesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveFileChangeMessagesByThreadId.value)) return
    liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
  }

  function clearCompletedTurnLiveState(threadId: string): void {
    if (!threadId) return
    liveDeltaBuffer.discardThread(threadId)
    clearLivePlansForThread(threadId)
    clearLiveReasoningForThread(threadId)
    setTurnActivityForThread(threadId, null)
    if (threadId === selectedThreadId.value) {
      activeReasoningItemIdByThreadId.delete(threadId)
    }
    if (liveCommandsByThreadId.value[threadId]) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    }
    if (activeTurnIdByThreadId.value[threadId]) {
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
    }
    clearPendingTurnRequest(threadId)
  }

  function markTurnProgressInterrupted(threadId: string, turnId: string, interruptedAtMs: number): void {
    const progress = agentProgressByThreadId.value[threadId]
    if (!progress) return
    if (progress.turnId && turnId && progress.turnId !== turnId) return
    if (progress.status !== 'running' && progress.status !== 'idle') return
    setAgentProgressSnapshot({
      ...progress,
      turnId: turnId || progress.turnId,
      status: 'interrupted',
      phase: 'interrupted',
      lastActivityAtMs: Math.max(progress.lastActivityAtMs, interruptedAtMs),
      mainLastActivityAtMs: Math.max(progress.mainLastActivityAtMs, interruptedAtMs),
      updatedAtMs: Math.max(progress.updatedAtMs, interruptedAtMs),
      agents: progress.agents.map((agent) => (
        agent.status === 'starting' || agent.status === 'running'
          ? {
              ...agent,
              status: 'interrupted',
              lastActivityAtMs: Math.max(agent.lastActivityAtMs, interruptedAtMs),
              completedAtMs: interruptedAtMs,
              currentActivity: '',
            }
          : agent
      )),
    }, { authoritativeRuntime: true })
  }

  function normalizePlanStepStatus(value: unknown): UiPlanStep['status'] {
    if (value === 'completed') return 'completed'
    if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
    return 'pending'
  }

  function buildPlanMessageText(plan: UiPlanData): string {
    const lines: string[] = []
    if (plan.explanation?.trim()) {
      lines.push(plan.explanation.trim())
    }
    for (const step of plan.steps) {
      const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
      lines.push(`- [${marker}] ${step.step}`)
    }
    return lines.join('\n').trim()
  }

  function readPlanUpdate(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'turn/plan/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const rawSteps = Array.isArray(params?.plan) ? params?.plan : []
    const steps: UiPlanStep[] = rawSteps
      .map((row) => asRecord(row))
      .map((row) => ({
        step: readString(row?.step),
        status: normalizePlanStepStatus(row?.status),
      }))
      .filter((row) => row.step.length > 0)

    if (!threadId || !turnId) return null

    const explanation = readString(params?.explanation).trim()
    const plan: UiPlanData = {
      explanation: explanation || undefined,
      steps,
      isStreaming: true,
    }

    return {
      threadId,
      message: {
        id: `${turnId}:plan`,
        role: 'assistant',
        text: buildPlanMessageText(plan),
        messageType: 'plan.live',
        plan,
      },
    }
  }

  function readPlanDelta(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'item/plan/delta') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const delta = readString(params?.delta)
    if (!threadId || !turnId || !delta) return null

    const messageId = `${turnId}:plan`
    const existing = (livePlanMessagesByThreadId.value[threadId] ?? []).find((message) => message.id === messageId)
    const nextText = `${existing?.text ?? ''}${delta}`
    const nextPlan: UiPlanData | undefined = existing?.plan
      ? { ...existing.plan, isStreaming: true }
      : undefined

    return {
      threadId,
      message: {
        id: messageId,
        role: 'assistant',
        text: nextText,
        messageType: 'plan.live',
        plan: nextPlan,
      },
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  function readString(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  function getRateLimitSnapshotKey(snapshot: UiRateLimitSnapshot): string {
    return snapshot.limitId?.trim() || snapshot.limitName?.trim() || '__default__'
  }

  function normalizeRateLimitWindow(value: unknown): UiRateLimitSnapshot['primary'] {
    const record = asRecord(value)
    if (!record) return null

    const windowValue = readNumber(record.windowDurationMins)
    return {
      usedPercent: clamp(readNumber(record.usedPercent) ?? 0, 0, 100),
      windowDurationMins: windowValue,
      windowMinutes: windowValue,
      resetsAt: readNumber(record.resetsAt),
    }
  }

  function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
    const record = asRecord(value)
    if (!record) return null

    const credits = asRecord(record.credits)
    return {
      limitId: readString(record.limitId) || null,
      limitName: readString(record.limitName) || null,
      primary: normalizeRateLimitWindow(record.primary),
      secondary: normalizeRateLimitWindow(record.secondary),
      credits: credits
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance: readString(credits.balance) || null,
          }
        : null,
      planType: readString(record.planType) || null,
    }
  }

  function normalizeRateLimitSnapshotsPayload(value: unknown): UiRateLimitSnapshot[] {
    const record = asRecord(value)
    if (!record) return []

    const next: UiRateLimitSnapshot[] = []
    const seen = new Set<string>()
    const pushSnapshot = (snapshot: UiRateLimitSnapshot | null): void => {
      if (!snapshot) return
      const key = getRateLimitSnapshotKey(snapshot)
      if (seen.has(key)) return
      seen.add(key)
      next.push(snapshot)
    }

    pushSnapshot(normalizeRateLimitSnapshot(record.rateLimits))

    const byLimitId = asRecord(record.rateLimitsByLimitId)
    if (byLimitId) {
      for (const snapshot of Object.values(byLimitId)) {
        pushSnapshot(normalizeRateLimitSnapshot(snapshot))
      }
    }

    return next
  }

  function normalizeTokenUsageBreakdown(value: unknown): UiTokenUsageBreakdown | null {
    const record = asRecord(value)
    if (!record) return null

    const totalTokens = readNumber(record.totalTokens ?? record.total_tokens)
    const inputTokens = readNumber(record.inputTokens ?? record.input_tokens)
    const cachedInputTokens = readNumber(record.cachedInputTokens ?? record.cached_input_tokens)
    const outputTokens = readNumber(record.outputTokens ?? record.output_tokens)
    const reasoningOutputTokens = readNumber(record.reasoningOutputTokens ?? record.reasoning_output_tokens)
    if (
      totalTokens === null ||
      inputTokens === null ||
      cachedInputTokens === null ||
      outputTokens === null ||
      reasoningOutputTokens === null
    ) {
      return null
    }

    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    }
  }

  function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
    const record = asRecord(value)
    if (!record) return null

    const total = normalizeTokenUsageBreakdown(record.total)
    const last = normalizeTokenUsageBreakdown(record.last)
    if (!total || !last) return null

    const modelContextWindow = readNumber(record.modelContextWindow ?? record.model_context_window)
    const currentContextTokens = last.totalTokens
    const remainingContextTokens = typeof modelContextWindow === 'number'
      ? Math.max(modelContextWindow - currentContextTokens, 0)
      : null
    const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
      ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
      : null

    return {
      total,
      last,
      modelContextWindow,
      currentContextTokens,
      remainingContextTokens,
      remainingContextPercent,
    }
  }

  function readThreadTokenUsageUpdate(notification: RpcNotification): { threadId: string; usage: UiThreadTokenUsage } | null {
    if (notification.method !== 'thread/tokenUsage/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const usage = normalizeThreadTokenUsage(params?.tokenUsage ?? params?.token_usage)
    if (!threadId || !usage) return null
    return { threadId, usage }
  }

  function extractThreadIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directThreadId = readString(params.threadId)
    if (directThreadId) return directThreadId
    const snakeThreadId = readString(params.thread_id)
    if (snakeThreadId) return snakeThreadId

    const conversationId = readString(params.conversationId)
    if (conversationId) return conversationId
    const snakeConversationId = readString(params.conversation_id)
    if (snakeConversationId) return snakeConversationId

    const thread = asRecord(params.thread)
    const nestedThreadId = readString(thread?.id)
    if (nestedThreadId) return nestedThreadId

    const turn = asRecord(params.turn)
    const turnThreadId = readString(turn?.threadId)
    if (turnThreadId) return turnThreadId
    const turnSnakeThreadId = readString(turn?.thread_id)
    if (turnSnakeThreadId) return turnSnakeThreadId

    return ''
  }

  function readTurnErrorMessage(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    if (!turn || turn.status !== 'failed') return ''
    const errorPayload = asRecord(turn.error)
    return readString(errorPayload?.message)
  }

  function readNotificationErrorState(notification: RpcNotification): { message: string } | null {
    if (notification.method !== 'error') return null
    const params = asRecord(notification.params)
    if (params?.willRetry === true) return null
    const message = (
      readString(params?.message) ||
      readString(asRecord(params?.error)?.message)
    )
    if (!message) return null

    return { message }
  }

  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const generation = row.generation
    const rawMethod = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || typeof generation !== 'number' || !Number.isInteger(generation) || !rawMethod) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const method = normalizePendingServerRequestMethod(rawMethod, requestParamRecord)
    const threadId = (
      readString(requestParamRecord?.threadId) ||
      readString(requestParamRecord?.thread_id) ||
      readString(requestParamRecord?.conversationId) ||
      readString(requestParamRecord?.conversation_id) ||
      GLOBAL_SERVER_REQUEST_SCOPE
    )
    const turnId = readString(requestParamRecord?.turnId) || readString(requestParamRecord?.turn_id)
    const itemId = (
      readString(requestParamRecord?.itemId) ||
      readString(requestParamRecord?.item_id) ||
      readString(requestParamRecord?.callId) ||
      readString(requestParamRecord?.call_id)
    )
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      generation,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function normalizePendingServerRequestMethod(
    method: string,
    params: Record<string, unknown> | null,
  ): string {
    const normalized = method.trim()
    if (!normalized) return normalized

    if (
      normalized === 'item/commandExecution/requestApproval' ||
      normalized === 'execCommandApproval' ||
      normalized === 'exec_approval_request' ||
      looksLikeExecApprovalRequest(params)
    ) {
      return 'item/commandExecution/requestApproval'
    }

    if (
      normalized === 'item/fileChange/requestApproval' ||
      normalized === 'applyPatchApproval' ||
      normalized === 'apply_patch_approval_request' ||
      looksLikePatchApprovalRequest(params)
    ) {
      return 'item/fileChange/requestApproval'
    }

    if (
      normalized === 'item/tool/requestUserInput' ||
      normalized === 'request_user_input' ||
      looksLikeToolUserInputRequest(params)
    ) {
      return 'item/tool/requestUserInput'
    }

    if (
      normalized === 'mcpServer/elicitation/request' ||
      normalized === 'elicitation_request' ||
      looksLikeMcpServerElicitationRequest(params)
    ) {
      return 'mcpServer/elicitation/request'
    }

    if (normalized === 'item/permissions/requestApproval' || looksLikePermissionsApprovalRequest(params)) {
      return 'item/permissions/requestApproval'
    }

    if (
      normalized === 'item/tool/call' ||
      normalized === 'dynamic_tool_call_request' ||
      looksLikeToolCallRequest(params)
    ) {
      return 'item/tool/call'
    }

    return normalized
  }

  function looksLikeExecApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const command = params.command
    if (Array.isArray(command) && command.some((part) => typeof part === 'string' && part.trim().length > 0)) {
      return true
    }
    if (typeof command === 'string' && command.trim().length > 0) {
      return true
    }
    return Array.isArray(params.commandActions)
  }

  function looksLikePatchApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) return true
    if (typeof params.grant_root === 'string' && params.grant_root.trim().length > 0) return true
    if (asRecord(params.fileChanges)) return true
    return asRecord(params.changes) !== null
  }

  function looksLikeToolUserInputRequest(params: Record<string, unknown> | null): boolean {
    return Boolean(params && Array.isArray(params.questions))
  }

  function looksLikeToolCallRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.toolName === 'string' ||
      typeof params.tool_name === 'string' ||
      typeof params.name === 'string' ||
      Array.isArray(params.arguments)
    )
  }

  function looksLikeMcpServerElicitationRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const mode = readString(params.mode)
    return (
      typeof params.serverName === 'string' &&
      typeof params.threadId === 'string' &&
      typeof params.message === 'string' &&
      (mode === 'form' || mode === 'url')
    )
  }

  function looksLikePermissionsApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string' &&
      asRecord(params.permissions) !== null
    )
  }

  function readToolRequestUserInputQuestionIds(request: UiServerRequest): string[] {
    if (request.method !== 'item/tool/requestUserInput') return []
    const params = asRecord(request.params)
    const questions = Array.isArray(params?.questions) ? params.questions : []
    const questionIds: string[] = []

    for (const row of questions) {
      const question = asRecord(row)
      const id = readString(question?.id).trim()
      if (id) {
        questionIds.push(id)
      }
    }

    return questionIds
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, request)
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
    applyThreadFlags()
  }

  function removePendingServerRequestById(requestId: number, generation?: number): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId || (generation !== undefined && request.generation !== generation))
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
    applyThreadFlags()
  }

  function replacePendingServerRequests(requests: UiServerRequest[]): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const request of requests) {
      const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
      const current = next[threadId] ?? []
      current.push(request)
      next[threadId] = current
    }

    for (const rows of Object.values(next)) {
      rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
    }

    pendingServerRequestsByThreadId.value = next
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id, typeof row?.generation === 'number' ? row.generation : undefined)
      }
      return true
    }

    if (notification.method === 'server/requests/invalidated') {
      const row = asRecord(notification.params)
      const generation = typeof row?.generation === 'number' && Number.isInteger(row.generation)
        ? row.generation
        : undefined
      const requestIds = Array.isArray(row?.requestIds) ? row.requestIds : []
      for (const requestId of requestIds) {
        if (typeof requestId === 'number' && Number.isInteger(requestId)) {
          removePendingServerRequestById(requestId, generation)
        }
      }
      return true
    }

    return false
  }

  function sanitizeDisplayText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
  }

  function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    if (notification.method === 'turn/started') {
      return {
        threadId,
        activity: {
          label: THINKING_ACTIVITY_LABEL,
          details: [],
        },
      }
    }

    if (notification.method === 'item/started') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const itemType = readString(item?.type).toLowerCase()
      if (itemType === 'reasoning') {
        return {
          threadId,
          activity: {
            label: THINKING_ACTIVITY_LABEL,
            details: [],
          },
        }
      }
      if (itemType === 'agentmessage') {
        return {
          threadId,
          activity: {
            label: 'Writing response',
            details: [],
          },
        }
      }
      if (itemType === 'commandexecution') {
        const cmd = readString(item?.command)
        return {
          threadId,
          activity: {
            label: 'Running command',
            details: cmd ? [cmd] : [],
          },
        }
      }
      if (itemType === 'filechange') {
        const changes = Array.isArray(item?.changes) ? item.changes : []
        const firstChange = changes[0] as Record<string, unknown> | undefined
        const path = readString(firstChange?.path)
        return {
          threadId,
          activity: {
            label: 'Applying changes',
            details: path ? [path] : [],
          },
        }
      }
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Running command',
          details: [],
        },
      }
    }

    if (notification.method === 'item/fileChange/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Applying changes',
          details: [],
        },
      }
    }

    if (
      notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/summaryPartAdded' ||
      notification.method === 'item/reasoning/textDelta'
    ) {
      return {
        threadId,
        activity: {
          label: THINKING_ACTIVITY_LABEL,
          details: [],
        },
      }
    }

    if (notification.method === 'item/agentMessage/delta') {
      return {
        threadId,
        activity: {
          label: 'Writing response',
          details: [],
        },
      }
    }

    return null
  }

  function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
    if (notification.method !== 'turn/started') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    return {
      threadId,
      turnId,
      startedAtMs,
    }
  }

  function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
    if (notification.method !== 'turn/completed') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const completedAtMs =
      parseIsoTimestamp(readString(turnPayload?.completedAt)) ??
      parseIsoTimestamp(readString(params.completedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      undefined

    return {
      threadId,
      turnId,
      completedAtMs,
      startedAtMs,
    }
  }

  function liveReasoningMessageId(reasoningItemId: string): string {
    return `${reasoningItemId}:live-reasoning`
  }

  function inferNextTurnIndex(threadId: string): number {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    let maxTurnIndex = -1
    for (const message of persisted) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        maxTurnIndex = Math.max(maxTurnIndex, message.turnIndex)
      }
    }
    return maxTurnIndex + 1
  }

  function setTurnIndexForThread(threadId: string, turnId: string, turnIndex: number): void {
    if (!threadId || !turnId || !Number.isInteger(turnIndex) || turnIndex < 0) return
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    if (previous[turnId] === turnIndex) return
    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: {
        ...previous,
        [turnId]: turnIndex,
      },
    }
  }

  function replaceTurnIndexLookupForThread(threadId: string, nextLookup: Record<string, number>): void {
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    const previousEntries = Object.entries(previous)
    const nextEntries = Object.entries(nextLookup)
    if (
      previousEntries.length === nextEntries.length
      && previousEntries.every(([turnId, turnIndex]) => nextLookup[turnId] === turnIndex)
    ) {
      return
    }

    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: { ...nextLookup },
    }
  }

  function rebindLiveFileChangeTurnIndices(threadId: string): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return

    const turnIndexByTurnId = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    let changed = false
    const next = current.map((message) => {
      if (typeof message.turnIndex === 'number' || !message.turnId) {
        return message
      }
      const turnIndex = turnIndexByTurnId[message.turnId]
      if (typeof turnIndex !== 'number') return message
      changed = true
      return { ...message, turnIndex }
    })

    if (!changed) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: next,
    }
  }

  function readReasoningStartedItemId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return readString(item.id)
    }

    return ''
  }

  function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический источник дельт для UI — уже нормализованный item/*.
    if (notification.method === 'item/reasoning/summaryTextDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    // codex also emits the full reasoning-chain stream as item/reasoning/textDelta
    // (alongside the summary stream). Without handling it, reasoning text the
    // model streams via this channel is dropped and the UI shows only the
    // summary, making long thinking phases look like a stall.
    if (notification.method === 'item/reasoning/textDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    return null
  }

  function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    // Канонический source для section break — item/*
    if (notification.method === 'item/reasoning/summaryPartAdded') {
      const itemId = readString(params.itemId)
      if (!itemId) return ''
      return liveReasoningMessageId(itemId)
    }

    return ''
  }

  function readReasoningCompletedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return liveReasoningMessageId(readString(item.id))
    }

    return ''
  }

  function readAgentMessageStartedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return ''
      return readString(item.id)
    }

    return ''
  }

  function readAgentMessageDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический live-канал агентского текста.
    if (notification.method === 'item/agentMessage/delta') {
      const messageId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!messageId || !delta) return null
      return { messageId, delta }
    }

    return null
  }

  function readAgentMessageCompleted(notification: RpcNotification): UiMessage | null {
    const params = asRecord(notification.params)
    if (!params) return null

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return null
      const id = readString(item.id)
      const text = readString(item.text)
      if (!id || !text) return null
      return {
        id,
        role: 'assistant',
        text,
        messageType: 'agentMessage.live',
      }
    }

    return null
  }

  function toLocalImageUrl(path: string): string {
    return `/codex-local-image?path=${encodeURIComponent(path)}`
  }

  function toImageGenerationUrl(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (
      trimmed.startsWith('data:') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/codex-local-image?')
    ) {
      return trimmed
    }
    const compact = trimmed.replace(/\s+/gu, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return ''
    return `data:image/png;base64,${compact}`
  }

  function readCompletedImageView(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    const id = readString(item.id)
    if (!id) return null
    if (item.type === 'imageView') {
      const path = readString(item.path)
      if (!path) return null
      return {
        id,
        role: 'assistant',
        text: '',
        images: [toLocalImageUrl(path)],
        messageType: 'imageView',
      }
    }
    if (item.type !== 'imageGeneration' && item.type !== 'image_generation') return null
    const result = readString(item.result)
    const imageUrl = result ? toImageGenerationUrl(result) : ''
    if (!imageUrl) return null
    return {
      id,
      role: 'assistant',
      text: '',
      images: [imageUrl],
      messageType: 'imageView',

    }
  }

  function readCommandExecutionStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCommandOutputDelta(notification: RpcNotification): { itemId: string; delta: string } | null {
    if (notification.method !== 'item/commandExecution/outputDelta') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const delta = readString(params.delta)
    if (!itemId || !delta) return null
    return { itemId, delta }
  }

  function readCommandExecutionCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const statusRaw = readString(item.status)
    const status: CommandExecutionData['status'] =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'declined' ? 'declined' : statusRaw === 'interrupted' ? 'interrupted' : 'completed'
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status, aggregatedOutput, exitCode },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCompletedFileChange(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'fileChange') return null
    const id = readString(item.id)
    if (!id) return null
    const threadId = readString(params?.threadId)
    const turnId = readString(params?.turnId)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined

    const fileChanges = toUiFileChanges(item.changes)
    const fileChangeStatus = normalizeFileChangeStatus(item.status)
    if (fileChanges.length === 0 || fileChangeStatus !== 'completed') return null

    return {
      id,
      role: 'system',
      text: '',
      messageType: 'fileChange',
      fileChangeStatus,
      fileChanges,
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    const previous = liveCommandsByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, msg)
    if (next === previous) return
    liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveCommandsByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map(messageIdentityKey))
    const next = current.filter((message) => !persistedIds.has(messageIdentityKey(message)))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    } else {
      liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveFileChangesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map(messageIdentityKey))
    const persistedTurnIds = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnId === 'string' && message.turnId.length > 0)
        .map((message) => message.turnId as string),
    )
    const persistedTurnIndices = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnIndex === 'number')
        .map((message) => message.turnIndex as number),
    )
    const next = current.filter((message) => (
      !persistedIds.has(messageIdentityKey(message))
      && !(message.turnId && persistedTurnIds.has(message.turnId))
      && !(typeof message.turnIndex === 'number' && persistedTurnIndices.has(message.turnIndex))
    ))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
    } else {
      liveFileChangeMessagesByThreadId.value = { ...liveFileChangeMessagesByThreadId.value, [threadId]: next }
    }
  }

  function isAgentContentEvent(notification: RpcNotification): boolean {
    if (notification.method === 'item/agentMessage/delta') {
      return true
    }

    const params = asRecord(notification.params)
    if (!params) return false

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      return item?.type === 'agentMessage'
    }

    return false
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    if (handleServerRequestNotification(notification)) {
      return
    }

    if (notification.method === 'account/rateLimits/updated') {
      scheduleRateLimitRefresh()
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        threadTitleById.value = { ...threadTitleById.value, [threadId]: threadName }
        applyThreadFlags()
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      setCodexRateLimit(pickCodexRateLimitSnapshot(notification.params))
      return
    }

    const tokenUsageUpdate = readThreadTokenUsageUpdate(notification)
    if (tokenUsageUpdate) {
      setThreadTokenUsage(tokenUsageUpdate.threadId, tokenUsageUpdate.usage)
      return
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn && shouldIgnoreStartedTurn(startedTurn)) return

    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    const notificationParams = asRecord(notification.params)
    const notificationTurnId =
      readString(notificationParams?.turnId)
      || readString(notificationParams?.turn_id)
      || readString(asRecord(notificationParams?.turn)?.id)
      || (notificationThreadId ? activeTurnIdByThreadId.value[notificationThreadId] ?? '' : '')
    const bindNotificationTurn = (message: UiMessage): UiMessage => (
      notificationTurnId && !message.turnId ? { ...message, turnId: notificationTurnId } : message
    )
    const notificationErrorState = readNotificationErrorState(notification)
    if (!notificationErrorState && notificationThreadId) {
      clearTransientTurnErrorForThread(notificationThreadId)
    }

    if (startedTurn) {
      bumpRuntimeStateLifecycleEpoch(startedTurn.threadId)
      liveDeltaBuffer.discardThread(startedTurn.threadId)
      if (startedTurn.threadId in agentProgressByThreadId.value) {
        agentProgressByThreadId.value = omitKey(agentProgressByThreadId.value, startedTurn.threadId)
      }
      invalidateAgentProgressLoadForThread(startedTurn.threadId)
      latestRuntimeStateByThreadId.delete(startedTurn.threadId)
      optimisticTurnStartedAtByThreadId.delete(startedTurn.threadId)
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      if (readThreadHistoryMode(startedTurn.threadId) === 'legacy') {
        setTurnIndexForThread(startedTurn.threadId, startedTurn.turnId, inferNextTurnIndex(startedTurn.threadId))
      }
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [startedTurn.threadId]: startedTurn.turnId,
      }
      maybeUnblockInterruptForActiveTurn(startedTurn.threadId, startedTurn.turnId)
      clearLivePlansForThread(startedTurn.threadId)
      clearLiveFileChangesForThread(startedTurn.threadId)
      setTurnSummaryForThread(startedTurn.threadId, null)
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      scheduleQueueStateRefresh(startedTurn.threadId)
      if (eventUnreadByThreadId.value[startedTurn.threadId]) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = readTurnCompletedInfo(notification)
    const turnErrorMessage = readTurnErrorMessage(notification)
    const completedThreadId = completedTurn?.threadId ?? extractThreadIdFromNotification(notification)
    const completedThreadModelId = completedThreadId ? readModelIdForThread(completedThreadId) : ''
    const shouldRetryWithFallback =
      Boolean(completedThreadId) &&
      Boolean(turnErrorMessage) &&
      completedThreadModelId !== MODEL_FALLBACK_ID &&
      isUnsupportedChatGptModelError(new Error(turnErrorMessage))
    let completionEndsActiveRun = false
    if (completedTurn) {
      recordTerminalTurn(completedTurn.threadId, completedTurn.turnId, completedTurn.completedAtMs)
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
      const activeTurnId = activeTurnIdByThreadId.value[completedTurn.threadId] ?? ''
      const currentProgress = agentProgressByThreadId.value[completedTurn.threadId]
      const hasDifferentRunningProgress = Boolean(
        currentProgress
        && currentProgress.status === 'running'
        && currentProgress.turnId
        && currentProgress.turnId !== completedTurn.turnId,
      )
      const knownRuntimeState = latestRuntimeStateByThreadId.get(completedTurn.threadId)
      const hasDifferentRunningRuntime = Boolean(
        knownRuntimeState?.isRunning
        && knownRuntimeState.turnId
        && knownRuntimeState.turnId !== completedTurn.turnId,
      )
      const correctsInterruptedOverlap = Boolean(
        currentProgress
        && currentProgress.status === 'interrupted'
        && currentProgress.turnId !== completedTurn.turnId
        && (!activeTurnId || currentProgress.turnId === activeTurnId)
        && completedTurn.completedAtMs >= currentProgress.mainLastActivityAtMs
        && !hasDifferentRunningRuntime,
      )
      completionEndsActiveRun = (
        !activeTurnId
        || activeTurnId === completedTurn.turnId
        || correctsInterruptedOverlap
      ) && !hasDifferentRunningProgress && !hasDifferentRunningRuntime
      if (completionEndsActiveRun || correctsInterruptedOverlap) {
        invalidateAgentProgressLoadForThread(completedTurn.threadId)
        optimisticTurnStartedAtByThreadId.delete(completedTurn.threadId)
        setTurnSummaryForThread(completedTurn.threadId, {
          turnId: completedTurn.turnId,
          durationMs,
        })
      }
      if (completionEndsActiveRun && activeTurnId) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, completedTurn.threadId)
      }
      if (completionEndsActiveRun) {
        bumpRuntimeStateLifecycleEpoch(completedTurn.threadId)
        latestRuntimeStateByThreadId.delete(completedTurn.threadId)
        setThreadInProgress(completedTurn.threadId, false)
        setTurnActivityForThread(completedTurn.threadId, null)
      }
      if (currentProgress && (
        !currentProgress.turnId
        || currentProgress.turnId === completedTurn.turnId
        || correctsInterruptedOverlap
      )) {
        const rawStatus = readString(asRecord(asRecord(notification.params)?.turn)?.status).toLowerCase()
        const phase: UiTurnProgress['phase'] = turnErrorMessage || rawStatus.includes('fail') || rawStatus.includes('error')
          ? 'failed'
          : rawStatus.includes('interrupt') || rawStatus.includes('cancel')
            ? 'interrupted'
            : 'completed'
        agentProgressByThreadId.value = {
          ...agentProgressByThreadId.value,
          [completedTurn.threadId]: {
            ...currentProgress,
            turnId: completedTurn.turnId,
            status: phase,
            phase,
            lastActivityAtMs: Math.max(currentProgress.lastActivityAtMs, completedTurn.completedAtMs),
            mainLastActivityAtMs: Math.max(currentProgress.mainLastActivityAtMs, completedTurn.completedAtMs),
            updatedAtMs: Math.max(currentProgress.updatedAtMs, completedTurn.completedAtMs),
          },
        }
      }
      markThreadUnreadByEvent(completedTurn.threadId)
      if (completionEndsActiveRun && !shouldRetryWithFallback) {
        clearPendingTurnRequest(completedTurn.threadId)
        scheduleQueueStateRefresh(completedTurn.threadId)
      }
    }

    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        setTurnErrorForThread(failedThreadId, turnErrorMessage)
      }
      error.value = turnErrorMessage
      if (failedThreadId && shouldRetryWithFallback) {
        void retryPendingTurnWithFallback(failedThreadId)
      }
    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    if (notificationErrorState) {
      const errorThreadId = notificationThreadId
      const errorThreadModelId = errorThreadId ? readModelIdForThread(errorThreadId) : selectedModelId.value.trim()
      if (errorThreadId) {
        setTurnErrorForThread(errorThreadId, notificationErrorState.message)
      }
      error.value = notificationErrorState.message
      if (errorThreadModelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(new Error(notificationErrorState.message))) {
        if (errorThreadId) {
          void retryPendingTurnWithFallback(errorThreadId)
        } else {
          void applyFallbackModelSelection()
        }
      }
    }

    const planUpdate = readPlanUpdate(notification)
    if (planUpdate) {
      const planMessage = bindNotificationTurn(planUpdate.message)
      upsertLivePlanMessage(planUpdate.threadId, planMessage)
      setTurnActivityForThread(planUpdate.threadId, {
        label: 'Planning',
        details: planMessage.plan?.steps.map((step) => step.step).slice(0, 2) ?? [],
      })
    }

    const planDelta = readPlanDelta(notification)
    if (planDelta) {
      upsertLivePlanMessage(planDelta.threadId, bindNotificationTurn(planDelta.message))
      setTurnActivityForThread(planDelta.threadId, {
        label: 'Planning',
        details: [],
      })
    }

    if (!notificationThreadId) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      liveDeltaBuffer.queueAgentText(
        notificationThreadId,
        liveAgentMessageDelta.messageId,
        liveAgentMessageDelta.delta,
      )
    }

    const completedAgentMessage = readAgentMessageCompleted(notification)
    if (completedAgentMessage) {
      liveDeltaBuffer.flush(notificationThreadId, completedAgentMessage.id)
      upsertLiveAgentMessage(notificationThreadId, bindNotificationTurn(completedAgentMessage))
    }

    const completedImageView = readCompletedImageView(notification)
    if (completedImageView) {
      upsertLiveAgentMessage(notificationThreadId, bindNotificationTurn(completedImageView))

    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      activeReasoningItemIdByThreadId.set(notificationThreadId, startedReasoningItemId)
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      liveDeltaBuffer.flush(notificationThreadId, notificationThreadId)
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemIdByThreadId.get(notificationThreadId) ?? '')) {
        activeReasoningItemIdByThreadId.delete(notificationThreadId)
      }
    }

    const commandStarted = readCommandExecutionStarted(notification)
    if (commandStarted) {
      upsertLiveCommand(notificationThreadId, bindNotificationTurn(commandStarted))
      setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      liveDeltaBuffer.queueCommandOutput(
        notificationThreadId,
        commandDelta.itemId,
        commandDelta.delta,
      )
    }

    const commandCompleted = readCommandExecutionCompleted(notification)
    if (commandCompleted) {
      liveDeltaBuffer.flush(notificationThreadId, commandCompleted.id)
      upsertLiveCommand(notificationThreadId, bindNotificationTurn(commandCompleted))
    }

    const completedFileChange = readCompletedFileChange(notification)
    if (completedFileChange) {
      upsertLiveFileChangeMessage(notificationThreadId, bindNotificationTurn(completedFileChange))
    }

    if (isAgentContentEvent(notification)) {
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
      liveDeltaBuffer.discardReasoningForThread(notificationThreadId)
      clearLiveReasoningForThread(notificationThreadId)
    }

    if (notification.method === 'turn/completed' && completionEndsActiveRun) {
      liveDeltaBuffer.flush(notificationThreadId)
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
      shouldAutoScrollOnNextAgentEvent = false
      clearLiveReasoningForThread(notificationThreadId)
      if (liveCommandsByThreadId.value[notificationThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, notificationThreadId)
      }
      const completedThreadId = extractThreadIdFromNotification(notification)
      if (completedThreadId) {
        clearDelayedTurnSync(completedThreadId)
        setThreadInProgress(completedThreadId, false)
        setTurnActivityForThread(completedThreadId, null)
        markThreadUnreadByEvent(completedThreadId)
        if (!shouldRetryWithFallback) {
          clearPendingTurnRequest(completedThreadId)
          scheduleQueueStateRefresh(completedThreadId)
        }
      }
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (notification.method === 'thread/tokenUsage/updated') return

    const method = notification.method
    const shouldRefreshMessages =
      method === 'turn/started' ||
      method === 'turn/completed' ||
      method === 'error'
    const shouldRefreshThreads =
      method.startsWith('thread/') ||
      method === 'turn/completed'

    if (!shouldRefreshMessages && !shouldRefreshThreads) return

    const threadId = extractThreadIdFromNotification(notification)
    if (threadId && shouldRefreshMessages) {
      const completedTurn = method === 'turn/completed' ? readTurnCompletedInfo(notification) : null
      if (completedTurn && readThreadHistoryMode(threadId) === 'paginated') {
        const pending = pendingCompletedTurnReconciliationByThreadId.get(threadId) ?? new Set<string>()
        pending.add(completedTurn.turnId)
        pendingCompletedTurnReconciliationByThreadId.set(threadId, pending)
      } else {
        pendingThreadMessageRefresh.add(threadId)
      }
    }

    if (shouldRefreshThreads) {
      pendingThreadsRefresh = true
      pendingThreadsRefreshForce = true
    }

    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
    }, EVENT_SYNC_DEBOUNCE_MS)
  }

  async function hydrateWorkspaceRootsStateIfNeeded(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): Promise<void> {
    if (hasHydratedWorkspaceRootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      if (!rootsState) return
      const hydratedOrder: string[] = []
      for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (hydratedOrder.includes(projectName)) continue
        hydratedOrder.push(projectName)
      }

      if (hydratedOrder.length > 0) {
        const mergedOrder = rootsState.projectOrder.length > 0
          ? mergeProjectOrder(hydratedOrder, groups)
          : mergeProjectOrder(projectOrder.value, groups)
        if (!areStringArraysEqual(projectOrder.value, mergedOrder)) {
          projectOrder.value = mergedOrder
        }
      }

      if (Object.keys(rootsState.labels).length > 0 || (rootsState.remoteProjects ?? []).length > 0) {
        const nextLabels = { ...projectDisplayNameById.value }
        let changed = false
        for (const [rootPath, label] of Object.entries(rootsState.labels)) {
          const normalizedRootPath = normalizePathForUi(rootPath).trim()
          const projectNames = [toProjectNameFromWorkspaceRoot(rootPath)]
          if (normalizedRootPath) projectNames.push(normalizedRootPath)
          for (const projectName of projectNames) {
            if (nextLabels[projectName] === label) continue
            nextLabels[projectName] = label
            changed = true
          }
        }
        for (const rootPath of rootsState.order) {
          const leafName = toProjectNameFromWorkspaceRoot(rootPath)
          const parentLeafName = toProjectName(getPathParent(rootPath))
          if (!parentLeafName.startsWith('.') || parentLeafName === leafName) continue
          const displayName = `${leafName} ${parentLeafName}`
          if (nextLabels[leafName] !== undefined || nextLabels[leafName] === displayName) continue
          nextLabels[leafName] = displayName
          changed = true
        }
        for (const remoteProject of rootsState.remoteProjects ?? []) {
          const label = getRemoteProjectDisplayName(remoteProject)
          if (nextLabels[remoteProject.id] === label) continue
          nextLabels[remoteProject.id] = label
          changed = true
        }
        if (changed) {
          projectDisplayNameById.value = nextLabels
        }
      }
    } catch {
      // Keep local storage fallback when global state is unavailable.
    }
  }

  async function loadThreadTitleCacheIfNeeded(options: { force?: boolean } = {}): Promise<void> {
    if (options.force !== true && Object.keys(threadTitleById.value).length > 0) return
    try {
      const cache = await getThreadTitleCache()
      if (Object.keys(cache.titles).length > 0) {
        threadTitleById.value = cache.titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function loadWorkspaceRootsStateForThreadList(): Promise<WorkspaceRootsState | null> {
    try {
      return await getWorkspaceRootsState()
    } catch {
      return null
    }
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null): Promise<void> {
    if (threadTitleById.value[threadId]) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    const truncated = trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed
    try {
      const title = await generateThreadTitle(truncated, cwd)
      if (!title || threadTitleById.value[threadId]) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      applyThreadFlags()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
    }
  }

  function filterGroupsByWorkspaceRoots(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): UiProjectGroup[] {
    const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
    const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
    const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
    if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
    const allowedProjectNames = new Set<string>()
    for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
      allowedProjectNames.add(projectName)
    }
    const filteredGroups = groupsWithWorkspaceRoots.filter((group) => {
      if (allowedProjectNames.has(group.projectName)) return true
      return isProjectlessGroup(group)
    })
    return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
  }

  function applyThreadGroups(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): void {
    const visibleGroups = filterGroupsByWorkspaceRoots(groups, rootsState)
    const hasWorkspaceRootsState = Boolean(
      rootsState && (rootsState.order.length > 0 || rootsState.projectOrder.length > 0 || (rootsState.remoteProjects ?? []).length > 0),
    )

    const nextProjectOrder = rootsState?.projectOrder.length
      ? mergeProjectOrder(
        getWorkspaceProjectOrderNames(rootsState, collectDuplicateProjectLeafNames(groups, rootsState)),
        visibleGroups,
      )
      : mergeProjectOrder(projectOrder.value, visibleGroups)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      if (!hasWorkspaceRootsState) {
        saveProjectOrder(projectOrder.value)
      }
    }

    const orderedGroups = orderGroupsByProjectOrder(visibleGroups, projectOrder.value)
    const orderedThreadIds = new Set(flattenThreads(orderedGroups).map((thread) => thread.id))
    markServerListedThreads(orderedThreadIds)
    let nextInProgress = syncIncomingInProgressState(inProgressById.value, orderedGroups)
    let copiedForActiveTurns = false
    for (const [threadId, turnId] of Object.entries(activeTurnIdByThreadId.value)) {
      if (!turnId || nextInProgress[threadId] === true) continue
      if (!copiedForActiveTurns) {
        nextInProgress = { ...nextInProgress }
        copiedForActiveTurns = true
      }
      nextInProgress[threadId] = true
    }
    inProgressById.value = nextInProgress
    for (const [threadId, runtimeState] of latestRuntimeStateByThreadId) {
      if (!orderedThreadIds.has(threadId) && threadId !== selectedThreadId.value) continue
      if (runtimeState.isRunning) {
        if (inProgressById.value[threadId] !== true) {
          inProgressById.value = { ...inProgressById.value, [threadId]: true }
        }
      } else if (inProgressById.value[threadId] === true) {
        inProgressById.value = omitKey(inProgressById.value, threadId)
      }
    }
    const mergedWithInProgress = mergeIncomingWithLocalInProgressThreads(
      sourceGroups.value,
      orderedGroups,
      inProgressById.value,
    )
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, mergedWithInProgress)
    inProgressById.value = pruneThreadStateMap(
      inProgressById.value,
      new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)),
    )
    applyThreadFlags()
  }

  function normalizeQueueStateForPersistence(state: Record<string, QueuedMessage[]>): ThreadQueueState {
    const next: ThreadQueueState = {}
    for (const [threadId, queue] of Object.entries(state)) {
      const normalizedThreadId = threadId.trim()
      if (!normalizedThreadId || queue.length === 0) continue
      next[normalizedThreadId] = queue.map((message) => ({
        id: message.id,
        text: message.text,
        imageUrls: [...message.imageUrls],
        skills: message.skills.map((skill) => ({ name: skill.name, path: skill.path })),
        fileAttachments: message.fileAttachments.map((attachment) => ({
          label: attachment.label,
          path: attachment.path,
          fsPath: attachment.fsPath,
        })),
        collaborationMode: message.collaborationMode,
        ...(message.speedMode ? { speedMode: message.speedMode } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
      }))
    }
    return next
  }

  function persistQueueState(): void {
    void setThreadQueueState(normalizeQueueStateForPersistence(queuedMessagesByThreadId.value)).catch(() => {
      // Queue persistence is best-effort; keep the current in-memory queue usable.
    })
  }

  async function loadPersistedQueueStateIfNeeded(): Promise<void> {
    if (hasLoadedPersistedQueueState) return
    hasLoadedPersistedQueueState = true
    try {
      queuedMessagesByThreadId.value = await getThreadQueueState()
    } catch {
      // Backend queue state is optional during startup.
    }
  }

  function hasActiveInProgressThreads(): boolean {
    return Object.values(inProgressById.value).some((value) => value === true)
  }

  function afterPrimaryThreadPageApplied(): void {
    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

    if (!currentExists && !selectedThreadId.value) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
    }
  }

  const threadListLoader = createThreadListLoader({
    fetchPage: getThreadGroupsPage,
    getBackgroundPageLimit: getBackgroundThreadListLimit,
    loadRootsState: loadWorkspaceRootsStateForThreadList,
    loadTitleCache: loadThreadTitleCacheIfNeeded,
    hydrateRootsState: hydrateWorkspaceRootsStateIfNeeded,
    applyGroups: applyThreadGroups,
    hasLoadedThreads: () => hasLoadedThreads.value,
    setThreadsLoading: (loading) => {
      isLoadingThreads.value = loading
    },
    markThreadsLoaded: () => {
      hasLoadedThreads.value = true
    },
    hasActiveThreads: hasActiveInProgressThreads,
    afterPrimaryPageApplied: afterPrimaryThreadPageApplied,
  })

  function removeArchivedThreadFromLoadedLists(threadId: string): void {
    threadListLoader.removeThread(threadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, threadId)
    inProgressById.value = omitKey(inProgressById.value, threadId)
    applyThreadFlags()
  }

  function loadThreads(options: { force?: boolean } = {}): Promise<void> {
    return threadListLoader.load(options)
  }

  async function loadMessages(threadId: string, options: { silent?: boolean; force?: boolean } = {}) {
    if (!threadId) {
      return
    }
    const recentLoadFailure =
      Date.now() - (lastMessageLoadFailureAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
    if (turnErrorByThreadId.value[threadId]?.transient && (options.silent === true || recentLoadFailure)) {
      return
    }

    const existingLoad = loadMessagePromiseByThreadId.get(threadId)
    if (existingLoad) {
      const existingLoadIsForced = forcedMessageLoadPromiseByThreadId.get(threadId) === existingLoad
      await existingLoad
      if (!options.force || existingLoadIsForced) return
      const newerLoad = loadMessagePromiseByThreadId.get(threadId)
      if (newerLoad) {
        await newerLoad
        return
      }
    }

    const hadLoadedMessages = loadedMessagesByThreadId.value[threadId] === true
    const shouldShowLoading = options.silent !== true && !hadLoadedMessages
    if (shouldShowLoading) {
      visibleMessageLoadOwnerThreadId = threadId
      isLoadingMessages.value = true
    }

    const loadGeneration = messageLoadGeneration
    const loadPromise = (async () => {
      try {
      const historyMode = await resolveThreadHistoryMode(threadId)
      if (loadGeneration !== messageLoadGeneration) return
      invalidateThreadHistoryCache(threadId, historyMode)
      const alreadyLoaded = loadedMessagesByThreadId.value[threadId] === true
      const version = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const loadedRecently =
        Date.now() - (lastMessageLoadAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
      const canReuseLoadedMessages =
        !options.force &&
        alreadyLoaded &&
        (
          loadedRecently ||
          (
            (version.length === 0 || loadedVersion === version) &&
            inProgressById.value[threadId] !== true
          )
        )

      if (canReuseLoadedMessages) {
        touchThreadHistoryCache(threadId)
        markThreadAsRead(threadId)
        return
      }

      const currentHistoryState = threadHistoryStateById.value[threadId]
      const detail = historyMode === 'paginated' && currentHistoryState?.initialized === true
        ? {
            ...(await getOlderThreadHistoryPage(threadId, {
              historyMode: 'paginated',
              cursor: null,
            })),
            model: '',
            modelProvider: '',
            resumed: false,
            materialized: currentHistoryState.materialized,
          }
        : await getThreadHistoryDetail(threadId, historyMode)

      if (loadGeneration !== messageLoadGeneration) return

      if (detail.modelProvider) {
        setThreadModelProviderId(threadId, detail.modelProvider)
      }
      if (detail.model && !readThreadModelPreference(threadId) && !hasCachedThreadModelSelection(threadId)) {
        setThreadModelId(threadId, detail.model.trim())
      }
      const previousHistoryState = threadHistoryStateById.value[threadId]
      const loadedTurnIds = mergeTurnIds(
        previousHistoryState?.mode === detail.historyMode ? previousHistoryState.loadedTurnIds : [],
        detail.turnIds,
      )
      threadHistoryStateById.value = {
        ...threadHistoryStateById.value,
        [threadId]: {
          mode: detail.historyMode,
          initialized: true,
          materialized: detail.materialized || previousHistoryState?.materialized === true,
          olderCursor: detail.olderCursor,
          hasMoreOlder: detail.hasMoreOlder,
          loadedTurnIds,
        },
      }
      if (detail.materialized) {
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }
      const { messages: nextMessages, inProgress, activeTurnId, turnIndexByTurnId } = detail
      const knownRuntimeState = latestRuntimeStateByThreadId.get(threadId)
      const hasOptimisticTurnStart = optimisticTurnStartedAtByThreadId.has(threadId)
      const currentActiveTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
      const resolvedInProgress = hasOptimisticTurnStart || Boolean(currentActiveTurnId)
        ? true
        : (knownRuntimeState ? knownRuntimeState.isRunning : inProgress)
      const resolvedActiveTurnId = currentActiveTurnId || (
        knownRuntimeState?.isRunning && knownRuntimeState.turnId
          ? knownRuntimeState.turnId
          : (resolvedInProgress ? activeTurnId : '')
      )
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: detail.hasMoreOlder === true,
      }
      markThreadMessagesPersisted(threadId, nextMessages)
      replaceTurnIndexLookupForThread(threadId, turnIndexByTurnId)
      rebindLiveFileChangeTurnIndices(threadId)
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
        preserveMissing:
          detail.historyMode === 'paginated'
          || options.silent === true
          || hasOptimisticUserMessages(previousPersisted),
      })
      setPersistedMessagesForThread(threadId, mergedMessages)

      const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
      if (resolvedInProgress) {
        const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
        setLiveAgentMessagesForThread(threadId, nextLiveAgent)
      } else {
        clearLiveAgentMessagesForThread(threadId)
      }
      removeLiveCommandsPersistedIn(threadId, nextMessages)
      removeLiveFileChangesPersistedIn(threadId, nextMessages)

      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [threadId]: true,
      }
      lastMessageLoadAtByThreadId.set(threadId, Date.now())
      lastMessageLoadFailureAtByThreadId.delete(threadId)

      if (version) {
        loadedVersionByThreadId.value = {
          ...loadedVersionByThreadId.value,
          [threadId]: version,
        }
      }
      touchThreadHistoryCache(threadId)
      setThreadInProgress(threadId, resolvedInProgress)
      clearTransientTurnErrorForThread(threadId)
      if (resolvedActiveTurnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: resolvedActiveTurnId,
        }
      } else if (activeTurnIdByThreadId.value[threadId]) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
      }
      if (!resolvedInProgress) {
        clearCompletedTurnLiveState(threadId)
      }
      markThreadAsRead(threadId)
      if (selectedThreadId.value === threadId && !agentProgressByThreadId.value[threadId]) {
        void loadAgentProgressSnapshot(threadId)
      }
      } catch (unknownError) {
        if (loadGeneration !== messageLoadGeneration) return
        const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        if (selectedThreadId.value === threadId) {
          setTurnErrorForThread(threadId, message, { transient: true })
        }
        lastMessageLoadFailureAtByThreadId.set(threadId, Date.now())
        throw unknownError
      } finally {
      if (shouldShowLoading && visibleMessageLoadOwnerThreadId === threadId) {
        visibleMessageLoadOwnerThreadId = ''
        isLoadingMessages.value = false
      }
      }
    })().finally(() => {
      if (loadMessagePromiseByThreadId.get(threadId) === loadPromise) {
        loadMessagePromiseByThreadId.delete(threadId)
      }
      if (forcedMessageLoadPromiseByThreadId.get(threadId) === loadPromise) {
        forcedMessageLoadPromiseByThreadId.delete(threadId)
      }
      enforceThreadHistoryCacheLimit()
    })

    loadMessagePromiseByThreadId.set(threadId, loadPromise)
    if (options.force === true) {
      forcedMessageLoadPromiseByThreadId.set(threadId, loadPromise)
    }
    await loadPromise
  }

  async function loadOlderMessages(threadId: string = selectedThreadId.value): Promise<void> {
    if (!threadId) return
    if (loadingOlderMessagesByThreadId.value[threadId] === true) return
    if (hasMoreOlderMessagesByThreadId.value[threadId] !== true) return

    const historyMode = readThreadHistoryMode(threadId)
    const historyState = threadHistoryStateById.value[threadId]
    const beforeTurnId = historyMode === 'legacy' ? getFirstPersistedTurnId(threadId) : ''
    const cursor = historyMode === 'paginated' ? historyState?.olderCursor ?? null : null
    if ((historyMode === 'legacy' && !beforeTurnId) || (historyMode === 'paginated' && !cursor)) {
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: false,
      }
      return
    }

    loadingOlderMessagesByThreadId.value = {
      ...loadingOlderMessagesByThreadId.value,
      [threadId]: true,
    }

    const loadGeneration = messageLoadGeneration
    try {
      const page = await getOlderThreadHistoryPage(threadId, {
        historyMode,
        cursor,
        beforeTurnId,
      })
      if (loadGeneration !== messageLoadGeneration || readThreadHistoryMode(threadId) !== page.historyMode) return
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(page.messages, previousPersisted, { preserveMissing: true })
      setPersistedMessagesForThread(threadId, mergedMessages)
      replaceTurnIndexLookupForThread(threadId, {
        ...(turnIndexByTurnIdByThreadId.value[threadId] ?? {}),
        ...page.turnIndexByTurnId,
      })
      rebindLiveFileChangeTurnIndices(threadId)
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: page.hasMoreOlder,
      }
      const previousHistoryState = threadHistoryStateById.value[threadId]
      threadHistoryStateById.value = {
        ...threadHistoryStateById.value,
        [threadId]: {
          mode: page.historyMode,
          initialized: true,
          materialized: previousHistoryState?.materialized === true,
          olderCursor: page.olderCursor,
          hasMoreOlder: page.hasMoreOlder,
          loadedTurnIds: mergeTurnIds(page.turnIds, previousHistoryState?.loadedTurnIds ?? []),
        },
      }
      touchThreadHistoryCache(threadId)
    } catch (loadError) {
      if (loadGeneration !== messageLoadGeneration) return
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load earlier messages'
      throw loadError
    } finally {
      if (loadGeneration === messageLoadGeneration) {
        loadingOlderMessagesByThreadId.value = {
          ...loadingOlderMessagesByThreadId.value,
          [threadId]: false,
        }
      }
    }
  }

  async function reconcilePaginatedTurnItemsNow(threadId: string, turnId: string): Promise<boolean> {
    if (!threadId || !turnId || readThreadHistoryMode(threadId) !== 'paginated') return false

    const loadGeneration = messageLoadGeneration
    const collectedMessages: UiMessage[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let fullyLoaded = false

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = await getThreadTurnItemsPage(threadId, turnId, cursor)
      if (loadGeneration !== messageLoadGeneration || readThreadHistoryMode(threadId) !== 'paginated') {
        return false
      }
      if (!page) return false
      const mergedPage = mergeMessages(collectedMessages, page.messages, { preserveMissing: true })
      collectedMessages.splice(0, collectedMessages.length, ...mergedPage)
      if (!page.nextCursor) {
        fullyLoaded = true
        break
      }
      if (seenCursors.has(page.nextCursor)) break
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }

    if (!fullyLoaded) return false

    const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
    let nextPersisted: UiMessage[]
    if (fullyLoaded) {
      const firstTurnMessageIndex = previousPersisted.findIndex((message) => message.turnId === turnId)
      const collectedIdentities = new Set(collectedMessages.map(messageIdentityKey))
      const preservedTurnMetadata = previousPersisted.filter((message) => (
        message.turnId === turnId
        && isNonItemTurnMetadataMessage(message)
        && !collectedIdentities.has(messageIdentityKey(message))
      ))
      const replacementMessages = [...collectedMessages, ...preservedTurnMetadata]
      const withoutTurn = previousPersisted.filter((message) => message.turnId !== turnId)
      const insertAt = firstTurnMessageIndex >= 0
        ? Math.min(firstTurnMessageIndex, withoutTurn.length)
        : withoutTurn.length
      nextPersisted = [
        ...withoutTurn.slice(0, insertAt),
        ...replacementMessages,
        ...withoutTurn.slice(insertAt),
      ]
      nextPersisted = nextPersisted.filter((message) => (
        !isOptimisticUserMessage(message) || !hasEquivalentUserMessage(message, nextPersisted)
      ))
    } else {
      nextPersisted = mergeMessages(previousPersisted, collectedMessages, { preserveMissing: true })
    }

    markThreadMessagesPersisted(threadId, collectedMessages)
    setPersistedMessagesForThread(threadId, nextPersisted)
    const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    setLiveAgentMessagesForThread(threadId, removeRedundantLiveAgentMessages(previousLiveAgent, collectedMessages))
    const previousLivePlans = livePlanMessagesByThreadId.value[threadId] ?? []
    setLivePlanMessagesForThread(
      threadId,
      previousLivePlans.filter((message) => message.turnId !== turnId),
    )
    removeLiveCommandsPersistedIn(threadId, collectedMessages)
    removeLiveFileChangesPersistedIn(threadId, collectedMessages)
    loadedMessagesByThreadId.value = {
      ...loadedMessagesByThreadId.value,
      [threadId]: true,
    }
    lastMessageLoadAtByThreadId.set(threadId, Date.now())
    touchThreadHistoryCache(threadId)
    return refreshLoadedThreadVersionAfterReconciliation(threadId, true)
  }

  function refreshLoadedThreadVersionAfterReconciliation(threadId: string, reconciled: boolean): boolean {
    if (!reconciled) return false
    const version = currentThreadVersion(threadId)
    if (version) {
      loadedVersionByThreadId.value = {
        ...loadedVersionByThreadId.value,
        [threadId]: version,
      }
    }
    return true
  }

  function reconcilePaginatedTurnItems(threadId: string, turnId: string): Promise<boolean> {
    const key = `${threadId}\u0000${turnId}`
    const now = Date.now()
    pruneRecentPaginatedTurnReconciliations(now)
    const existing = paginatedTurnReconcileByKey.get(key)
    if (existing && (!existing.settled || now - existing.createdAt < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS)) {
      return existing.promise.then((reconciled) => (
        refreshLoadedThreadVersionAfterReconciliation(threadId, reconciled)
      ))
    }

    const promise = reconcilePaginatedTurnItemsNow(threadId, turnId)
    const entry = { promise, createdAt: now, settled: false }
    paginatedTurnReconcileByKey.set(key, entry)
    void promise.then(
      () => {
        entry.settled = true
        pruneRecentPaginatedTurnReconciliations()
        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            if (paginatedTurnReconcileByKey.get(key) === entry) {
              paginatedTurnReconcileByKey.delete(key)
              enforceThreadHistoryCacheLimit()
            }
          }, RECENT_THREAD_MESSAGE_LOAD_REUSE_MS)
        }
      },
      () => {
        if (paginatedTurnReconcileByKey.get(key)?.promise === promise) {
          paginatedTurnReconcileByKey.delete(key)
        }
      },
    )
    return promise.then((reconciled) => (
      refreshLoadedThreadVersionAfterReconciliation(threadId, reconciled)
    ))
  }

  async function ensureThreadMessagesLoaded(threadId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (loadedMessagesByThreadId.value[threadId] === true) return
    if (options.silent === true && turnErrorByThreadId.value[threadId]?.transient) return
    await loadMessages(threadId, options)
  }

  async function refreshSkills(options: { force?: boolean } = {}): Promise<void> {
    const selectedCwd = selectedThread.value?.cwd?.trim() ?? ''
    const skillsLoadKey = selectedCwd || '__global__'
    if (refreshSkillsPromise) {
      await refreshSkillsPromise
      return
    }
    if (
      options.force !== true &&
      hasLoadedSkills &&
      lastSkillsLoadKey === skillsLoadKey &&
      Date.now() - lastSkillsLoadAt < RECENT_SKILLS_LOAD_REUSE_MS
    ) {
      return
    }

    refreshSkillsPromise = (async () => {
      try {
        installedSkills.value = await getSkillsList(selectedCwd ? [selectedCwd] : undefined)
        hasLoadedSkills = true
        lastSkillsLoadAt = Date.now()
        lastSkillsLoadKey = skillsLoadKey
      } catch {
        // keep previous skills on failure
      } finally {
        refreshSkillsPromise = null
      }
    })()

    await refreshSkillsPromise
  }

  async function refreshAncillaryState(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): Promise<void> {
    await Promise.allSettled([
      refreshModelPreferences({
        providerChanged: options.providerChanged,
        includeProviderModels: options.includeProviderModels,
      }),
      refreshRateLimits(),
      refreshCollaborationModes(),
      refreshSkills(),
    ])
  }

  function scheduleAncillaryStateRefresh(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): void {
    const run = () => {
      void refreshAncillaryState(options)
    }

    if (typeof window === 'undefined') {
      run()
      return
    }

    window.setTimeout(run, 0)
  }

  async function refreshAll(
    options: { includeSelectedThreadMessages?: boolean; awaitAncillaryRefreshes?: boolean; providerChanged?: boolean; forceThreadRefresh?: boolean } = {},
  ) {
    error.value = ''
    codexCliMissingError.value = ''
    const includeSelectedThreadMessages = options.includeSelectedThreadMessages !== false
    const awaitAncillaryRefreshes = options.awaitAncillaryRefreshes === true

    try {
      await refreshCodexRuntimeConfig()
      await loadPersistedQueueStateIfNeeded()
      await loadThreadModelPreferencesIfNeeded()
      await loadThreads({ force: options.forceThreadRefresh === true })
      if (includeSelectedThreadMessages) {
        try {
          await loadMessages(selectedThreadId.value)
        } catch (unknownError) {
          error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        }
      }
      if (awaitAncillaryRefreshes) {
        await refreshAncillaryState({
          providerChanged: options.providerChanged,
          includeProviderModels: options.providerChanged === true || awaitAncillaryRefreshes,
        })
      } else {
        scheduleAncillaryStateRefresh({
          providerChanged: options.providerChanged,
          includeProviderModels: false,
        })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
    }
  }

  async function selectThread(threadId: string): Promise<SelectThreadResult> {
    setSelectedThreadId(threadId)

    try {
      await loadMessages(threadId)
      await refreshModelPreferences({ includeProviderModels: true })
      void refreshSkills()
      return 'ok'
    } catch (unknownError) {
      if (selectedThreadId.value !== threadId) {
        return 'ok'
      }
      const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      error.value = message
      const result = isThreadNotFoundError(unknownError) ? 'not-found' : 'error'
      if (threadId.trim()) {
        setTurnErrorForThread(threadId, message, { transient: true })
      }
      return result
    }
  }

  async function archiveThreadById(threadId: string) {
    const wasSelectedThread = selectedThreadId.value === threadId
    const nextSelectedThreadId = wasSelectedThread
      ? findAdjacentThreadId(flattenThreads(projectGroups.value), threadId)
      : ''

    if (wasSelectedThread) {
      setSelectedThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void loadMessages(nextSelectedThreadId, { silent: true })
      }
    }

    try {
      await archiveThread(threadId)
      removeArchivedThreadFromLoadedLists(threadId)
      await loadThreads()

      if (wasSelectedThread && nextSelectedThreadId && selectedThreadId.value === nextSelectedThreadId) {
        await ensureThreadMessagesLoaded(nextSelectedThreadId, { silent: true })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function permanentlyDeleteThreadById(threadId: string): Promise<boolean> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return false

    const nextSelectedThreadId = findAdjacentThreadId(flattenThreads(projectGroups.value), normalizedThreadId)

    try {
      await permanentlyDeleteThread(normalizedThreadId)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return false
    }

    removeArchivedThreadFromLoadedLists(normalizedThreadId)
    if (selectedThreadId.value === normalizedThreadId) {
      setSelectedThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void loadMessages(nextSelectedThreadId, { silent: true })
      }
    }
    pruneThreadScopedState(flattenThreads(projectGroups.value))
    return true
  }

  async function renameThreadById(threadId: string, threadName: string) {
    const normalizedName = threadName.trim()
    if (!threadId || !normalizedName) return

    try {
      await renameThread(threadId, normalizedName)
      threadTitleById.value = { ...threadTitleById.value, [threadId]: normalizedName }
      applyThreadFlags()
      void persistThreadTitle(threadId, normalizedName)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    const sourceThreadId = threadId.trim()
    if (!sourceThreadId) return ''
    if (readThreadHistoryMode(sourceThreadId) === 'paginated') {
      error.value = 'Codex does not support forking paginated threads yet.'
      return ''
    }

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === sourceThreadId)
    const sourceCwd = sourceThread?.cwd?.trim() ?? ''
    const sourceTitle = sourceThread?.title?.trim() ?? 'Forked chat'
    const selectedModel = readModelIdForThread(sourceThreadId)
    const selectedReasoningEffort = readReasoningEffortForThread(sourceThreadId) || runtimeDefaultReasoningEffort
    error.value = ''

    try {
      const forkedThread = await forkThread(sourceThreadId, sourceCwd || undefined, selectedModel || undefined)
      const nextThreadId = forkedThread.threadId.trim()
      if (!nextThreadId) return ''

      insertOptimisticThread(nextThreadId, sourceCwd, sourceTitle)
      setThreadModelId(nextThreadId, forkedThread.model)
      const forkedModel = forkedThread.model.trim() || selectedModel
      if (forkedModel && selectedReasoningEffort) {
        cacheThreadModelPreference(nextThreadId, {
          model: forkedModel,
          reasoningEffort: selectedReasoningEffort,
        })
        void queueThreadModelPreferenceWrite(nextThreadId)
      }
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [nextThreadId]: true,
      }
      setSelectedThreadId(nextThreadId)
      await loadThreads()
      await loadMessages(nextThreadId)
      return nextThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function forkThreadFromTurn(threadId: string, turnIndex: number): Promise<string> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !Number.isInteger(turnIndex) || turnIndex < 0) return ''
    if (readThreadHistoryMode(normalizedThreadId) === 'paginated') {
      error.value = 'Codex does not support forking paginated threads yet.'
      return ''
    }

    if (inProgressById.value[normalizedThreadId] === true) {
      error.value = 'Finish the current turn before forking from a response.'
      return ''
    }

    if (loadedMessagesByThreadId.value[normalizedThreadId] !== true) {
      try {
        await loadMessages(normalizedThreadId)
      } catch (unknownError) {
        error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        return ''
      }
    }

    const sourceMessages = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
    let lastTurnIndex = -1
    for (const message of sourceMessages) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        lastTurnIndex = Math.max(lastTurnIndex, message.turnIndex)
      }
    }

    if (lastTurnIndex >= 0 && turnIndex > lastTurnIndex) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === normalizedThreadId) ?? null
    const sourceReasoningEffort = readReasoningEffortForThread(normalizedThreadId) || runtimeDefaultReasoningEffort

    try {
      error.value = ''
      const forked = await forkThread(normalizedThreadId)
      const forkedThreadId = forked.threadId.trim()
      if (!forkedThreadId) return ''

      const forkedCwd = forked.cwd.trim() || sourceThread?.cwd?.trim() || ''
      const forkedThreadTitle = toForkedThreadTitle(sourceThread?.title || sourceThread?.preview || 'Untitled thread')
      insertOptimisticThread(forkedThreadId, forkedCwd, forkedThreadTitle)
      setThreadModelId(forkedThreadId, forked.model)
      const forkedModel = forked.model.trim() || readModelIdForThread(normalizedThreadId)
      if (forkedModel && sourceReasoningEffort) {
        cacheThreadModelPreference(forkedThreadId, {
          model: forkedModel,
          reasoningEffort: sourceReasoningEffort,
        })
        void queueThreadModelPreferenceWrite(forkedThreadId)
      }
      setPersistedMessagesForThread(forkedThreadId, forked.messages)
      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [forkedThreadId]: true,
      }
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [forkedThreadId]: true,
      }
      clearLivePlansForThread(forkedThreadId)
      setLiveAgentMessagesForThread(forkedThreadId, [])
      clearLiveReasoningForThread(forkedThreadId)
      if (liveCommandsByThreadId.value[forkedThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, forkedThreadId)
      }
      setTurnSummaryForThread(forkedThreadId, null)
      setTurnActivityForThread(forkedThreadId, null)
      setTurnErrorForThread(forkedThreadId, null)
      setThreadInProgress(forkedThreadId, false)

      const turnsToRollback = lastTurnIndex - turnIndex
      if (turnsToRollback > 0) {
        const rolledBackMessages = await rollbackThread(forkedThreadId, turnsToRollback)
        setPersistedMessagesForThread(forkedThreadId, rolledBackMessages)
      }

      await renameThreadById(forkedThreadId, forkedThreadTitle)
      setSelectedThreadId(forkedThreadId)
      void loadThreads().catch(() => {})
      return forkedThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function maybeReplyToPendingUserInputRequest(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<boolean> {
    if (!threadId || !text.trim()) return false
    if (imageUrls.length > 0 || skills.length > 0 || fileAttachments.length > 0) return false

    const requests = pendingServerRequestsByThreadId.value[threadId] ?? []
    const userInputRequests = requests.filter((request) => request.method === 'item/tool/requestUserInput')
    if (userInputRequests.length !== 1) return false

    const [request] = userInputRequests
    const questionIds = readToolRequestUserInputQuestionIds(request)
    if (questionIds.length !== 1) return false

    return respondToPendingServerRequest({
      id: request.id,
      generation: request.generation,
      result: {
        answers: {
          [questionIds[0]]: {
            answers: [text.trim()],
          },
        },
      },
    })
  }

  async function sendMessageToSelectedThread(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'steer',
    fileAttachments: FileAttachment[] = [],
    queueInsertIndex?: number,
    collaborationModeOverride?: CollaborationModeKind,
    speedModeOverride?: SpeedMode,
  ): Promise<void> {
    if (isUpdatingSpeedMode.value) return

    const threadId = selectedThreadId.value
    const nextText = text.trim()
    if (!threadId || (!nextText && imageUrls.length === 0 && fileAttachments.length === 0)) return
    const speedMode = speedModeOverride ?? selectedSpeedMode.value

    if (await maybeReplyToPendingUserInputRequest(threadId, nextText, imageUrls, skills, fileAttachments)) {
      return
    }

    const isInProgress = inProgressById.value[threadId] === true

    if (isInProgress && mode === 'queue') {
      const queue = queuedMessagesByThreadId.value[threadId] ?? []
      const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const nextQueue = [...queue]
      const insertIndex = typeof queueInsertIndex === 'number'
        ? Math.max(0, Math.min(queueInsertIndex, nextQueue.length))
        : nextQueue.length
      nextQueue.splice(insertIndex, 0, {
        id,
        text: nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationMode: collaborationModeOverride === 'plan'
          ? 'plan'
          : collaborationModeOverride === 'default'
            ? 'default'
            : selectedCollaborationMode.value,
        speedMode,
        model: readModelIdForThread(threadId),
        reasoningEffort: readReasoningEffortForThread(threadId) || undefined,
      })
      queuedMessagesByThreadId.value = {
        ...queuedMessagesByThreadId.value,
        [threadId]: nextQueue,
      }
      persistQueueState()
      return
    }

    visibleMessageLoadOwnerThreadId = ''
    isLoadingMessages.value = false
    appendOptimisticUserMessage(threadId, nextText, imageUrls, skills, fileAttachments)

    if (isInProgress) {
      shouldAutoScrollOnNextAgentEvent = true
      void startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
        speedMode,
      ).catch((unknownError) => {
        const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        setTurnErrorForThread(threadId, errorMessage)
        error.value = errorMessage
      })
      return
    }

    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    latestRuntimeStateByThreadId.delete(threadId)
    invalidateAgentProgressLoadForThread(threadId)
    if (threadId in agentProgressByThreadId.value) {
      agentProgressByThreadId.value = omitKey(agentProgressByThreadId.value, threadId)
    }
    optimisticTurnStartedAtByThreadId.set(threadId, Date.now())
    setTurnSummaryForThread(threadId, null)
    setTurnActivityForThread(
      threadId,
      {
        label: THINKING_ACTIVITY_LABEL,
        details: buildPendingTurnDetails(
          readModelIdForThread(threadId),
          selectedReasoningEffort.value,
          collaborationModeOverride === 'plan'
            ? 'plan'
            : collaborationModeOverride === 'default'
              ? 'default'
              : selectedCollaborationMode.value,
        ),
      },
    )
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)

    try {
      await startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
        speedMode,
      )
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      optimisticTurnStartedAtByThreadId.delete(threadId)
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    }
  }

  async function sendMessageToNewThread(
    text: string,
    cwd: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<string> {
    if (isUpdatingSpeedMode.value) return ''

    const nextText = text.trim()
    const targetCwd = cwd.trim()
    const selectedModel = readModelIdForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT).trim()
    let selectedEffort = selectedReasoningEffort.value
    const selectedMode = selectedCollaborationMode.value
    const speedMode = selectedSpeedMode.value
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) return ''

    beginPendingNewThreadPreview(nextText, imageUrls, skills, fileAttachments)
    isSendingMessage.value = true
    error.value = ''
    let threadId = ''

    try {
      let startedTurnId = ''
      try {
        const startedThread = await startThreadWithTurn(
          targetCwd || undefined,
          nextText,
          imageUrls,
          selectedModel || undefined,
          selectedEffort || undefined,
          skills.length > 0 ? skills : undefined,
          fileAttachments,
          selectedMode,
          serviceTierForSpeedMode(speedMode, selectedModel),
        )
        threadId = startedThread.threadId
        startedTurnId = startedThread.turnId
        setThreadModelId(threadId, startedThread.model)
        setThreadModelProviderId(threadId, startedThread.modelProvider || activeProviderId.value)
        const resolvedModel = startedThread.model.trim() || selectedModel
        if (resolvedModel && selectedEffort) {
          cacheThreadModelPreference(threadId, {
            model: resolvedModel,
            reasoningEffort: selectedEffort,
          })
          void queueThreadModelPreferenceWrite(threadId)
        }
        setSelectedCollaborationModeForThread(threadId, selectedMode)
      } catch (unknownError) {
        if (selectedModel && selectedModel !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection()
          selectedEffort = selectedReasoningEffort.value
          const fallbackThread = await startThreadWithTurn(
            targetCwd || undefined,
            nextText,
            imageUrls,
            MODEL_FALLBACK_ID,
            selectedEffort || undefined,
            skills.length > 0 ? skills : undefined,
            fileAttachments,
            selectedMode,
            serviceTierForSpeedMode(speedMode, MODEL_FALLBACK_ID),
          )
          threadId = fallbackThread.threadId
          startedTurnId = fallbackThread.turnId
          setThreadModelId(threadId, fallbackThread.model)
          setThreadModelProviderId(threadId, fallbackThread.modelProvider || activeProviderId.value)
          const fallbackModel = fallbackThread.model.trim() || MODEL_FALLBACK_ID
          if (selectedEffort) {
            cacheThreadModelPreference(threadId, {
              model: fallbackModel,
              reasoningEffort: selectedEffort,
            })
            void queueThreadModelPreferenceWrite(threadId)
          }
          setSelectedCollaborationModeForThread(threadId, selectedMode)
        } else {
          throw unknownError
        }
      }
      if (!threadId) return ''

      insertOptimisticThread(threadId, targetCwd, nextText || '[Image]')
      appendOptimisticUserMessage(threadId, nextText, imageUrls, skills, fileAttachments)
      setPendingTurnRequest(threadId, {
        text: nextText,
        imageUrls: [...imageUrls],
        skills: skills.map((skill) => ({ name: skill.name, path: skill.path })),
        fileAttachments: fileAttachments.map((file) => ({ ...file })),
        effort: selectedEffort,
        collaborationMode: selectedMode,
        speedMode,
        fallbackRetried: false,
      })
      blockInterruptUntilThreadIsPersisted(threadId)
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      setSelectedThreadId(threadId)
      newThreadSelectionInitialized = false
      newThreadDraftModelId = ''
      shouldAutoScrollOnNextAgentEvent = true
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(
        threadId,
        {
          label: THINKING_ACTIVITY_LABEL,
          details: buildPendingTurnDetails(
            readModelIdForThread(threadId),
            selectedEffort,
            selectedMode,
            speedMode,
          ),
        },
      )
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      if (startedTurnId) {
        bumpRuntimeStateLifecycleEpoch(threadId)
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: startedTurnId,
        }
        maybeUnblockInterruptForActiveTurn(threadId, startedTurnId)
      }
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = nextText
      pendingThreadMessageRefresh.add(threadId)
      void syncFromNotifications()
      scheduleDelayedTurnSync(threadId)
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
      isSendingMessage.value = false
      return threadId
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      if (threadId) {
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      pendingNewThreadPreviewError.value = errorMessage
      if (threadId) {
        setTurnErrorForThread(threadId, errorMessage)
      }
      error.value = errorMessage
      isSendingMessage.value = false
      throw unknownError
    }
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    collaborationModeOverride?: CollaborationModeKind,
    speedModeOverride?: SpeedMode,
  ): Promise<void> {
    const reasoningEffort = selectedReasoningEffort.value
    const speedMode = speedModeOverride ?? selectedSpeedMode.value
    const collaborationMode = collaborationModeOverride === 'plan' ? 'plan' : collaborationModeOverride === 'default'
      ? 'default'
      : selectedCollaborationMode.value
    const normalizedText = nextText.trim()
    const normalizedImageUrls = [...imageUrls]
    if (
      normalizedImageUrls.length === 0
      && shouldReuseAttachedImageFromPrompt(normalizedText)
    ) {
      const latestAttachedImageUrl = findLatestUserLocalImageUrl(threadId)
      if (latestAttachedImageUrl) {
        normalizedImageUrls.push(latestAttachedImageUrl)
      }
    }
    const normalizedSkills = skills.map((skill) => ({ name: skill.name, path: skill.path }))
    const normalizedFileAttachments = fileAttachments.map((file) => ({ ...file }))

    setPendingTurnRequest(threadId, {
      text: normalizedText,
      imageUrls: [...normalizedImageUrls],
      skills: normalizedSkills,
      fileAttachments: normalizedFileAttachments,
      effort: reasoningEffort,
      collaborationMode,
      speedMode,
      fallbackRetried: false,
    })

    try {
      const pendingMessageLoad = loadMessagePromiseByThreadId.get(threadId)
      if (pendingMessageLoad) {
        try {
          await pendingMessageLoad
        } catch {
          // A failed history read does not prevent the explicit resume below.
        }
      }
      if (resumedThreadById.value[threadId] !== true) {
        const resumedThread = await resumeThread(threadId)
        if (resumedThread.model && !readThreadModelPreference(threadId) && !hasCachedThreadModelSelection(threadId)) {
          setThreadModelId(threadId, resumedThread.model.trim())
        }
        if (resumedThread.modelProvider) {
          setThreadModelProviderId(threadId, resumedThread.modelProvider)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }
      const modelId = readModelIdForThread(threadId)

      let startedTurnId = ''
      try {
        startedTurnId = await startThreadTurn(
          threadId,
          nextText,
          normalizedImageUrls,
          modelId || undefined,
          reasoningEffort || undefined,
          skills.length > 0 ? skills : undefined,
          fileAttachments,
          collaborationMode,
          serviceTierForSpeedMode(speedMode, modelId),
        )
      } catch (unknownError) {
        if (modelId && modelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection(threadId)
          setPendingTurnRequest(threadId, {
            text: normalizedText,
            imageUrls: [...normalizedImageUrls],
            skills: normalizedSkills,
            fileAttachments: normalizedFileAttachments,
            effort: reasoningEffort,
            collaborationMode,
            speedMode,
            fallbackRetried: true,
          })
          startedTurnId = await startThreadTurn(
            threadId,
            nextText,
            normalizedImageUrls,
            MODEL_FALLBACK_ID,
            reasoningEffort || undefined,
            skills.length > 0 ? skills : undefined,
            fileAttachments,
            collaborationMode,
            serviceTierForSpeedMode(speedMode, MODEL_FALLBACK_ID),
          )
        } else {
          throw unknownError
        }
      }

      if (startedTurnId) {
        bumpRuntimeStateLifecycleEpoch(threadId)
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: startedTurnId,
        }
        maybeUnblockInterruptForActiveTurn(threadId, startedTurnId)
      }

      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
      scheduleDelayedTurnSync(threadId)
    } catch (unknownError) {
      throw unknownError
    }
  }

  async function processQueuedMessages(threadId: string): Promise<void> {
    if (queueProcessingByThreadId.value[threadId] === true) return
    queueProcessingByThreadId.value = {
      ...queueProcessingByThreadId.value,
      [threadId]: true,
    }
    try {
      queuedMessagesByThreadId.value = await getThreadQueueState()
    } catch {
      // Backend queue state is optional during transient bridge failures.
    } finally {
      queueProcessingByThreadId.value = omitKey(queueProcessingByThreadId.value, threadId)
    }
  }

  function scheduleQueueStateRefresh(threadId: string): void {
    void processQueuedMessages(threadId)
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      void processQueuedMessages(threadId)
    }, 650)
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] === true) return
    let turnId = activeTurnIdByThreadId.value[threadId]
    if (!turnId) {
      const pendingMessageLoad = loadMessagePromiseByThreadId.get(threadId)
      if (pendingMessageLoad) {
        try {
          await pendingMessageLoad
        } catch {
          // The mode-safe lookup below remains available after a failed load.
        }
        turnId = activeTurnIdByThreadId.value[threadId]
      }
    }
    if (!turnId) {
      try {
        const historyMode = await resolveThreadHistoryMode(threadId)
        if (historyMode === 'paginated') {
          const previousHistoryState = threadHistoryStateById.value[threadId]
          const page = previousHistoryState?.initialized === true
            ? await getOlderThreadHistoryPage(threadId, { historyMode: 'paginated', cursor: null })
            : await getThreadHistoryDetail(threadId, 'paginated')
          turnId = page.activeTurnId
          threadHistoryStateById.value = {
            ...threadHistoryStateById.value,
            [threadId]: {
              mode: 'paginated',
              initialized: true,
              materialized: previousHistoryState?.materialized === true || ('materialized' in page && page.materialized === true),
              olderCursor: page.olderCursor,
              hasMoreOlder: page.hasMoreOlder,
              loadedTurnIds: mergeTurnIds(previousHistoryState?.loadedTurnIds ?? [], page.turnIds),
            },
          }
        } else {
          const detail = await getThreadDetail(threadId)
          turnId = detail.activeTurnId
        }
        if (turnId) {
          activeTurnIdByThreadId.value = {
            ...activeTurnIdByThreadId.value,
            [threadId]: turnId,
          }
        }
      } catch {
        // Runtime reconciliation below handles stale or externally-owned turns.
      }
    }
    if (!turnId) {
      const runtimeState = await reconcileThreadRuntimeState(threadId)
      if (runtimeState && !runtimeState.isRunning) {
        error.value = ''
        return
      }
      error.value = 'Could not determine active turn id for interrupt'
      return
    }

    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId, turnId)
      const currentActiveTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
      if (!currentActiveTurnId || currentActiveTurnId === turnId) {
        const interruptedAtMs = Date.now()
        bumpRuntimeStateLifecycleEpoch(threadId)
        invalidateAgentProgressLoadForThread(threadId)
        latestRuntimeStateByThreadId.delete(threadId)
        markTurnProgressInterrupted(threadId, turnId, interruptedAtMs)
        recordTerminalTurn(threadId, turnId, interruptedAtMs)
        optimisticTurnStartedAtByThreadId.delete(threadId)
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
        setTurnErrorForThread(threadId, null)
        if (activeTurnIdByThreadId.value[threadId]) {
          activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
        }
      }
      pendingThreadMessageRefresh.add(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      if (isNoActiveTurnError(unknownError)) {
        const runtimeState = await reconcileThreadRuntimeState(threadId)
        if (runtimeState && !runtimeState.isRunning) {
          setThreadInProgress(threadId, false)
          clearCompletedTurnLiveState(threadId)
          setTurnActivityForThread(threadId, null)
          setTurnErrorForThread(threadId, null)
          error.value = ''
          return
        }
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  async function rollbackSelectedThread(turnId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (isRollingBack.value) return
    if (!turnId.trim()) return
    if (readThreadHistoryMode(threadId) === 'paginated') {
      error.value = 'Codex does not support editing or rolling back messages in paginated threads yet.'
      return
    }

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const matchedMessage = persisted.find((message) => message.turnId === turnId)
    const turnIndex = typeof matchedMessage?.turnIndex === 'number' ? matchedMessage.turnIndex : -1
    if (turnIndex < 0) return
    const maxTurnIndex = persisted.reduce((max, m) => (typeof m.turnIndex === 'number' && m.turnIndex > max ? m.turnIndex : max), -1)
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return

    isRollingBack.value = true
    error.value = ''
    try {
      const threadCwd = selectedThread.value?.cwd?.trim() ?? ''
      if (threadCwd) {
        await revertThreadFileChanges(threadId, turnId, threadCwd)
      }
      const nextMessages = await rollbackThread(threadId, numTurns)
      setPersistedMessagesForThread(threadId, nextMessages)
      setLiveAgentMessagesForThread(threadId, [])
      clearLiveReasoningForThread(threadId)
      if (liveCommandsByThreadId.value[threadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
      }
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread'
    } finally {
      isRollingBack.value = false
    }
  }

  let renameProjectTimer: ReturnType<typeof setTimeout> | null = null

  async function persistProjectLabelToGlobalState(projectName: string, displayName: string): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextLabels = { ...rootsState.labels }
      let changed = false
      for (const rootPath of rootsState.order) {
        if (!matchesWorkspaceRootProject(rootPath, projectName)) continue
        const trimmed = displayName.trim()
        if (trimmed.length === 0) {
          if (nextLabels[rootPath] !== undefined) {
            delete nextLabels[rootPath]
            changed = true
          }
        } else if (nextLabels[rootPath] !== trimmed) {
          nextLabels[rootPath] = trimmed
          changed = true
        }
      }
      if (changed) {
        await setWorkspaceRootsState({
          order: rootsState.order,
          labels: nextLabels,
          active: rootsState.active,
          projectOrder: rootsState.projectOrder,
        })
      }
    } catch {
      // Keep localStorage-only rename when global state is unavailable.
    }
  }

  function renameProject(projectName: string, displayName: string): void {
    if (projectName.length === 0) return

    const currentValue = projectDisplayNameById.value[projectName] ?? ''
    if (currentValue === displayName) return

    projectDisplayNameById.value = {
      ...projectDisplayNameById.value,
      [projectName]: displayName,
    }
    saveProjectDisplayNames(projectDisplayNameById.value)

    if (renameProjectTimer !== null) clearTimeout(renameProjectTimer)
    renameProjectTimer = setTimeout(() => {
      renameProjectTimer = null
      void persistProjectLabelToGlobalState(projectName, displayName)
    }, 500)
  }

  async function removeProject(projectName: string): Promise<void> {
    if (projectName.length === 0) return

    const nextProjectOrder = projectOrder.value.filter((name) => name !== projectName)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }

    sourceGroups.value = sourceGroups.value.filter((group) => group.projectName !== projectName)

    if (projectDisplayNameById.value[projectName] !== undefined) {
      const nextDisplayNames = { ...projectDisplayNameById.value }
      delete nextDisplayNames[projectName]
      projectDisplayNameById.value = nextDisplayNames
      saveProjectDisplayNames(nextDisplayNames)
    }

    applyThreadFlags()

    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)
    if (!currentExists) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
    }

    const removedRootPaths = new Set<string>()
    try {
      const rootsState = await getWorkspaceRootsState()
      collectWorkspaceRootPathsForProjectRemoval(rootsState, projectName).forEach((rootPath) => {
        removedRootPaths.add(rootPath)
      })
    } catch {
      // Keep local-only removal when global state is unavailable.
    }

    if (removedRootPaths.size > 0) {
      try {
        const rootsState = await getWorkspaceRootsState()
        const nextOrder = rootsState.order.filter((rootPath) => !removedRootPaths.has(rootPath))
        const nextActive = rootsState.active.filter((rootPath) => !removedRootPaths.has(rootPath))
        const fallbackActive = nextActive.length === 0 && nextOrder.length > 0
          ? [nextOrder[0]]
          : nextActive
        await setWorkspaceRootsState({
          order: nextOrder,
          labels: omitKeys(rootsState.labels, removedRootPaths),
          active: fallbackActive,
          projectOrder: rootsState.projectOrder.filter((item) => item !== projectName && !removedRootPaths.has(item)),
        })
        return
      } catch {
        // Fall back to order-only persistence if direct removal fails.
      }
    }

    await persistProjectOrderToWorkspaceRoots()
  }

  function reorderProject(projectName: string, toIndex: number): void {
    if (projectName.length === 0) return
    if (sourceGroups.value.length === 0) return

    const visibleOrder = sourceGroups.value.map((group) => group.projectName)
    const fromIndex = visibleOrder.indexOf(projectName)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, visibleOrder.length - 1))
    const reorderedVisibleOrder = reorderStringArray(visibleOrder, fromIndex, clampedToIndex)
    if (reorderedVisibleOrder === visibleOrder) return

    const normalizedProjectOrder = mergeProjectOrder(reorderedVisibleOrder, sourceGroups.value)
    projectOrder.value = normalizedProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  function pinProjectToTop(projectName: string): void {
    const normalizedName = projectName.trim()
    if (!normalizedName) return
    const nextOrder = [normalizedName, ...projectOrder.value.filter((name) => name !== normalizedName)]
    if (areStringArraysEqual(projectOrder.value, nextOrder)) return
    projectOrder.value = nextOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  async function persistProjectOrderToWorkspaceRoots(): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextState = buildWorkspaceRootsProjectOrderState(rootsState, projectOrder.value, sourceGroups.value)

      await setWorkspaceRootsState({
        order: nextState.order,
        labels: rootsState.labels,
        active: nextState.active,
        projectOrder: nextState.projectOrder,
      })
    } catch {
      // Keep local project order when global state persistence is unavailable.
    }
  }

  function shouldIgnoreOlderTerminalRuntimeState(state: ThreadRuntimeState): boolean {
    return shouldIgnoreOlderRuntimeState({
      state,
      optimisticStartedAtMs: optimisticTurnStartedAtByThreadId.get(state.threadId),
      currentTurnId: activeTurnIdByThreadId.value[state.threadId] ?? '',
      nowMs: Date.now(),
    })
  }

  function recordTerminalTurn(threadId: string, turnId: string, terminalAtMs: number): void {
    if (!threadId || !turnId || !Number.isFinite(terminalAtMs)) return
    const existing = terminalTurnAtMsByThreadId.get(threadId) ?? new Map<string, number>()
    existing.delete(turnId)
    existing.set(turnId, terminalAtMs)
    while (existing.size > 32) {
      const oldestTurnId = existing.keys().next().value
      if (typeof oldestTurnId !== 'string') break
      existing.delete(oldestTurnId)
    }
    terminalTurnAtMsByThreadId.set(threadId, existing)
  }

  function shouldIgnoreStartedTurn(startedTurn: TurnStartedInfo): boolean {
    if (terminalTurnAtMsByThreadId.get(startedTurn.threadId)?.has(startedTurn.turnId)) return true
    const activeTurnId = activeTurnIdByThreadId.value[startedTurn.threadId] ?? ''
    if (activeTurnId === startedTurn.turnId && inProgressById.value[startedTurn.threadId] === true) return true
    const currentProgress = agentProgressByThreadId.value[startedTurn.threadId]
    const progressIsTerminal = currentProgress?.status === 'completed'
      || currentProgress?.status === 'interrupted'
      || currentProgress?.status === 'failed'
    if (
      progressIsTerminal
      && startedTurn.startedAtMs <= currentProgress.mainLastActivityAtMs
    ) return true
    const runtimeState = latestRuntimeStateByThreadId.get(startedTurn.threadId)
    if (runtimeState && !runtimeState.isRunning) {
      const runtimeTerminalAtMs = runtimeState.completedAtIso
        ? Date.parse(runtimeState.completedAtIso)
        : runtimeState.startedAtIso
          ? Date.parse(runtimeState.startedAtIso)
          : NaN
      if (Number.isFinite(runtimeTerminalAtMs) && startedTurn.startedAtMs <= runtimeTerminalAtMs) return true
    }
    return false
  }

  function bumpRuntimeStateLifecycleEpoch(threadId: string): void {
    if (!threadId) return
    runtimeStateLifecycleEpochByThreadId.set(
      threadId,
      (runtimeStateLifecycleEpochByThreadId.get(threadId) ?? 0) + 1,
    )
  }

  async function fetchThreadRuntimeStates(threadIds: string[]): Promise<ThreadRuntimeState[]> {
    const requestSequence = ++runtimeRequestSequence
    const generation = runtimeRequestGeneration
    const lifecycleEpochByThreadId = new Map(threadIds.map((threadId) => [
      threadId,
      runtimeStateLifecycleEpochByThreadId.get(threadId) ?? 0,
    ]))
    const states = await getThreadRuntimeStates(threadIds)
    return states.map((state) => {
      const taggedState = { ...state }
      runtimeRequestContextByState.set(taggedState, {
        generation,
        requestSequence,
        lifecycleEpoch: lifecycleEpochByThreadId.get(state.threadId) ?? 0,
      })
      return taggedState
    })
  }

  function isRuntimeStateRequestCurrent(state: ThreadRuntimeState): boolean {
    const requestContext = runtimeRequestContextByState.get(state)
    if (!requestContext) return true
    if (requestContext.generation !== runtimeRequestGeneration) return false
    if (
      requestContext.lifecycleEpoch
      !== (runtimeStateLifecycleEpochByThreadId.get(state.threadId) ?? 0)
    ) return false
    return requestContext.requestSequence >= (lastAppliedRuntimeRequestByThreadId.get(state.threadId) ?? 0)
  }

  function hasDifferentConcreteActiveTurn(state: ThreadRuntimeState): boolean {
    const activeTurnId = activeTurnIdByThreadId.value[state.threadId] ?? ''
    if (!activeTurnId || activeTurnId.startsWith('pending:')) return false
    return !state.turnId || activeTurnId !== state.turnId
  }

  function terminalRuntimeRefreshWasSuperseded(state: ThreadRuntimeState): boolean {
    if (hasDifferentConcreteActiveTurn(state)) return true
    return latestRuntimeStateByThreadId.get(state.threadId)?.isRunning === true
  }

  function refreshTerminalThreadFromServer(state: ThreadRuntimeState): void {
    const threadId = state.threadId
    if (!threadId || terminalRuntimeRefreshThreadIds.has(threadId)) return
    terminalRuntimeRefreshThreadIds.add(threadId)
    void (async () => {
      try {
        const reconciledPaginatedTurn = state.turnId && readThreadHistoryMode(threadId) === 'paginated'
          ? await reconcilePaginatedTurnItems(threadId, state.turnId)
          : false
        if (!reconciledPaginatedTurn) {
          await loadMessages(threadId, { silent: true, force: true })
        }
        if (terminalRuntimeRefreshWasSuperseded(state)) return
        if (!shouldIgnoreOlderTerminalRuntimeState(state)) {
          setThreadInProgress(threadId, false)
          clearCompletedTurnLiveState(threadId)
        }
        await loadThreads({ force: true })
        if (reconciledPaginatedTurn) {
          refreshLoadedThreadVersionAfterReconciliation(threadId, true)
        }
        if (terminalRuntimeRefreshWasSuperseded(state)) return
        if (!shouldIgnoreOlderTerminalRuntimeState(state)) {
          setThreadInProgress(threadId, false)
          clearCompletedTurnLiveState(threadId)
        }
        await loadPendingServerRequestsFromBridge()
      } catch {
        pendingThreadMessageRefresh.add(threadId)
        pendingThreadsRefresh = true
      } finally {
        terminalRuntimeRefreshThreadIds.delete(threadId)
      }
    })()
  }

  function applyThreadRuntimeStates(states: ThreadRuntimeState[]): void {
    for (const state of states) {
      const threadId = state.threadId
      if (!threadId) continue
      const requestContext = runtimeRequestContextByState.get(state)
      if (requestContext) {
        if (!isRuntimeStateRequestCurrent(state)) continue
        lastAppliedRuntimeRequestByThreadId.set(threadId, requestContext.requestSequence)
      }

      if (state.isRunning && state.state === 'running') {
        const currentProgress = agentProgressByThreadId.value[threadId]
        const terminalSummary = turnSummaryByThreadId.value[threadId]
        const sameTurnHasConfirmedTerminal = Boolean(
          state.turnId
          && (
            terminalSummary?.turnId === state.turnId
            || (
              currentProgress?.turnId === state.turnId
              && (currentProgress.status === 'completed' || currentProgress.status === 'failed')
            )
          ),
        )
        if (sameTurnHasConfirmedTerminal) continue
        latestRuntimeStateByThreadId.set(threadId, state)
        optimisticTurnStartedAtByThreadId.delete(threadId)
        setThreadInProgress(threadId, true, { requestRuntimeReconcile: false })
        const runtimeTurnChanged = Boolean(
          state.turnId
          && currentProgress
          && state.turnId !== currentProgress.turnId,
        )
        const revivesInterruptedTurn = Boolean(
          currentProgress
          && currentProgress.status === 'interrupted'
          && (!state.turnId || !currentProgress.turnId || state.turnId === currentProgress.turnId),
        )
        if (runtimeTurnChanged) {
          invalidateAgentProgressLoadForThread(threadId)
          agentProgressByThreadId.value = omitKey(agentProgressByThreadId.value, threadId)
        } else if (currentProgress && revivesInterruptedTurn) {
          const runtimeStartedAtMs = state.startedAtIso ? Date.parse(state.startedAtIso) : NaN
          setAgentProgressSnapshot({
            ...currentProgress,
            turnId: state.turnId || currentProgress.turnId,
            status: 'running',
            phase: 'preparing',
            lastActivityAtMs: Number.isFinite(runtimeStartedAtMs)
              ? Math.max(currentProgress.lastActivityAtMs, runtimeStartedAtMs)
              : currentProgress.lastActivityAtMs,
          }, { authoritativeRuntime: true })
          invalidateAgentProgressLoadForThread(threadId)
        }
        if (threadId === selectedThreadId.value && (!currentProgress || runtimeTurnChanged || revivesInterruptedTurn)) {
          void loadAgentProgressSnapshot(threadId, { force: runtimeTurnChanged || revivesInterruptedTurn })
        }
        if (state.turnId && !state.turnId.startsWith('pending:')) {
          activeTurnIdByThreadId.value = {
            ...activeTurnIdByThreadId.value,
            [threadId]: state.turnId,
          }
          maybeUnblockInterruptForActiveTurn(threadId, state.turnId)
        }
        appliedRuntimeStateSnapshots.add(state)
        continue
      }

      const currentProgress = agentProgressByThreadId.value[threadId]
      const runtimeTerminalAtMs = state.completedAtIso
        ? Date.parse(state.completedAtIso)
        : state.startedAtIso
          ? Date.parse(state.startedAtIso)
          : Date.now()
      if (state.turnId) recordTerminalTurn(threadId, state.turnId, runtimeTerminalAtMs)
      const activeTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
      const knownRuntimeState = latestRuntimeStateByThreadId.get(threadId)
      const hasDifferentActiveTurn = Boolean(
        activeTurnId
        && !activeTurnId.startsWith('pending:')
        && (!state.turnId || activeTurnId !== state.turnId),
      )
      const replacesKnownRunningRuntime = Boolean(
        hasDifferentActiveTurn
        && knownRuntimeState?.isRunning
        && knownRuntimeState.turnId === activeTurnId,
      )
      const activeTurnHasTerminalProgress = Boolean(
        hasDifferentActiveTurn
        && currentProgress?.turnId === activeTurnId
        && currentProgress.status !== 'running'
        && currentProgress.status !== 'idle',
      )
      const terminalLifecycleSupersedesActiveTurn = Boolean(
        hasDifferentActiveTurn
        && (replacesKnownRunningRuntime || activeTurnHasTerminalProgress)
        && (
          !currentProgress
          || (
            Number.isFinite(runtimeTerminalAtMs)
            && runtimeTerminalAtMs >= currentProgress.mainLastActivityAtMs
          )
        ),
      )
      if (shouldIgnoreOlderTerminalRuntimeState(state) && !terminalLifecycleSupersedesActiveTurn) continue
      if (hasDifferentActiveTurn && !replacesKnownRunningRuntime && !activeTurnHasTerminalProgress) continue
      if (
        hasDifferentActiveTurn
        && currentProgress
        && Number.isFinite(runtimeTerminalAtMs)
        && runtimeTerminalAtMs < currentProgress.mainLastActivityAtMs
      ) continue
      latestRuntimeStateByThreadId.set(threadId, state)
      appliedRuntimeStateSnapshots.add(state)
      const sameProgressTurn = Boolean(
        currentProgress
        && (!currentProgress.turnId || !state.turnId || currentProgress.turnId === state.turnId),
      )
      const newerOverlappingTerminal = Boolean(
        currentProgress
        && !sameProgressTurn
        && Number.isFinite(runtimeTerminalAtMs)
        && runtimeTerminalAtMs >= currentProgress.mainLastActivityAtMs,
      )
      const runtimeProgressStatus = state.state === 'completed'
        ? 'completed'
        : state.state === 'interrupted'
          ? 'interrupted'
          : null
      const fillsMissingProgressTurnId = Boolean(currentProgress && state.turnId && !currentProgress.turnId)
      const sameTurnTerminalCorrection = Boolean(
        currentProgress
        && sameProgressTurn
        && runtimeProgressStatus
        && (
          runtimeProgressStatus === 'completed'
            ? currentProgress.status === 'running'
              || currentProgress.status === 'interrupted'
              || currentProgress.status === 'idle'
            : currentProgress.status === 'running'
              || currentProgress.status === 'idle'
              || (
                fillsMissingProgressTurnId
                && Number.isFinite(runtimeTerminalAtMs)
                && runtimeTerminalAtMs >= currentProgress.mainLastActivityAtMs
              )
        )
      )
      const correctsProgress = Boolean(
        currentProgress
        && runtimeProgressStatus
        && (
          sameTurnTerminalCorrection
          || (
            newerOverlappingTerminal
            && (
              currentProgress.status !== runtimeProgressStatus
              || currentProgress.phase !== runtimeProgressStatus
              || Boolean(state.turnId && currentProgress.turnId !== state.turnId)
            )
          )
        )
      )
      const shouldRefreshCorrectedProgress = correctsProgress && threadId === selectedThreadId.value
      if (currentProgress && runtimeProgressStatus && (correctsProgress || fillsMissingProgressTurnId)) {
        setAgentProgressSnapshot({
          ...currentProgress,
          turnId: state.turnId || currentProgress.turnId,
          status: correctsProgress ? runtimeProgressStatus : currentProgress.status,
          phase: correctsProgress ? runtimeProgressStatus : currentProgress.phase,
          lastActivityAtMs: Number.isFinite(runtimeTerminalAtMs)
            ? Math.max(currentProgress.lastActivityAtMs, runtimeTerminalAtMs)
            : currentProgress.lastActivityAtMs,
          mainLastActivityAtMs: Number.isFinite(runtimeTerminalAtMs)
            ? Math.max(currentProgress.mainLastActivityAtMs, runtimeTerminalAtMs)
            : currentProgress.mainLastActivityAtMs,
          updatedAtMs: Number.isFinite(runtimeTerminalAtMs)
            ? Math.max(currentProgress.updatedAtMs, runtimeTerminalAtMs)
            : currentProgress.updatedAtMs,
        }, { authoritativeRuntime: true })
        if (correctsProgress) {
          invalidateAgentProgressLoadForThread(threadId)
        }
      }
      const hadRuntimeState = inProgressById.value[threadId] === true || Boolean(activeTurnId) || correctsProgress
      if (!hadRuntimeState) continue

      optimisticTurnStartedAtByThreadId.delete(threadId)
      clearDelayedTurnSync(threadId)
      if (state.turnId) pendingTurnStartsById.delete(state.turnId)
      setThreadInProgress(threadId, false)
      clearCompletedTurnLiveState(threadId)
      setTurnActivityForThread(threadId, null)
      if (state.state === 'completed') markThreadUnreadByEvent(threadId)
      if (shouldRefreshCorrectedProgress) {
        void loadAgentProgressSnapshot(threadId, { force: true, preserveOnNull: true })
      }
      refreshTerminalThreadFromServer(state)
    }
  }

  const threadRuntimePolling = createThreadRuntimePollingController({
    collectThreadIds: () => collectThreadRuntimeStateIds(
      allThreads.value,
      inProgressById.value,
      selectedThreadId.value,
    ),
    hasActiveThreads: hasActiveInProgressThreads,
    fetchStates: fetchThreadRuntimeStates,
    applyStates: applyThreadRuntimeStates,
  })

  async function reconcileThreadRuntimeState(threadId: string): Promise<ThreadRuntimeState | null> {
    const state = await threadRuntimePolling.reconcile(threadId)
    if (!state || !appliedRuntimeStateSnapshots.has(state) || !isRuntimeStateRequestCurrent(state)) return null
    return state
  }

  async function syncThreadStatus(): Promise<void> {
    if (isPolling.value) return
    isPolling.value = true

    try {
      await loadThreads()

      if (!selectedThreadId.value) return

      const threadId = selectedThreadId.value
      const currentVersion = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
      const isInProgress = inProgressById.value[threadId] === true

      if (isInProgress || hasVersionChange) {
        await loadMessages(threadId, { silent: true })
      }
    } catch {
      // ignore poll failures and keep last known state
    } finally {
      isPolling.value = false
    }
  }

  async function syncFromNotifications(): Promise<void> {
    pruneRecentPaginatedTurnReconciliations()
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true
    const shouldRefreshThreads = pendingThreadsRefresh
    const shouldForceThreadRefresh = pendingThreadsRefreshForce
    const threadIdsToRefresh = new Set(pendingThreadMessageRefresh)
    const completedTurnsToReconcile = new Map<string, Set<string>>()
    for (const [threadId, turnIds] of pendingCompletedTurnReconciliationByThreadId) {
      completedTurnsToReconcile.set(threadId, new Set(turnIds))
    }
    pendingThreadsRefresh = false
    pendingThreadsRefreshForce = false
    pendingThreadMessageRefresh.clear()
    pendingCompletedTurnReconciliationByThreadId.clear()
    let syncFailed = false

    try {
      if (shouldRefreshThreads) {
        await loadThreads({ force: shouldForceThreadRefresh })
      }

      for (const [threadId, turnIds] of completedTurnsToReconcile) {
        for (const turnId of turnIds) {
          const reconciled = await reconcilePaginatedTurnItems(threadId, turnId)
          if (!reconciled) threadIdsToRefresh.add(threadId)
        }
      }

      const activeThreadId = selectedThreadId.value
      if (activeThreadId) {
        const isInProgress = inProgressById.value[activeThreadId] === true
        const currentVersion = currentThreadVersion(activeThreadId)
        const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
        const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
        const hasPendingMessageLoad = loadMessagePromiseByThreadId.has(activeThreadId)
        if (
          (hasVersionChange || isInProgress || loadedMessagesByThreadId.value[activeThreadId] !== true)
          && (shouldForceThreadRefresh || !hasPendingMessageLoad)
        ) {
          threadIdsToRefresh.add(activeThreadId)
        }
      }

      for (const threadId of threadIdsToRefresh) {
        await loadMessages(threadId, { silent: true, force: true })
      }
    } catch {
      syncFailed = true
      if (shouldRefreshThreads) pendingThreadsRefresh = true
      if (shouldForceThreadRefresh) pendingThreadsRefreshForce = true
      for (const threadId of threadIdsToRefresh) pendingThreadMessageRefresh.add(threadId)
      for (const [threadId, turnIds] of completedTurnsToReconcile) {
        const pending = pendingCompletedTurnReconciliationByThreadId.get(threadId) ?? new Set<string>()
        for (const turnId of turnIds) pending.add(turnId)
        pendingCompletedTurnReconciliationByThreadId.set(threadId, pending)
      }
    } finally {
      isPolling.value = false
      if (
        (
          pendingThreadsRefresh
          || pendingThreadMessageRefresh.size > 0
          || pendingCompletedTurnReconciliationByThreadId.size > 0
        ) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, syncFailed ? EVENT_SYNC_RETRY_DELAY_MS : EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  async function recoverBridgeState(forceRefresh = false): Promise<void> {
    await loadPendingServerRequestsFromBridge()
    pendingThreadsRefresh = forceRefresh || !hasLoadedThreads.value
    pendingThreadsRefreshForce = forceRefresh
    const selectedThread = selectedThreadId.value
    if (
      selectedThread
      && (
        forceRefresh
        || (
          loadedMessagesByThreadId.value[selectedThread] !== true
          && !loadMessagePromiseByThreadId.has(selectedThread)
        )
      )
    ) {
      pendingThreadMessageRefresh.add(selectedThread)
    }
    if (forceRefresh) {
      for (const thread of allThreads.value) {
        if (
          thread.id !== selectedThread
          && inProgressById.value[thread.id] === true
          && loadedMessagesByThreadId.value[thread.id] === true
        ) {
          pendingThreadMessageRefresh.add(thread.id)
        }
      }
    }
    const selectedProgressRefresh = selectedThreadId.value
      ? loadAgentProgressSnapshot(selectedThreadId.value, { force: forceRefresh })
      : Promise.resolve()
    await Promise.all([syncFromNotifications(), selectedProgressRefresh])
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return
    if (stopNotificationStream) return
    hasReceivedNotificationReady = false
    void loadPendingServerRequestsFromBridge()
    stopNotificationStream = subscribeCodexNotifications((notification) => {
      if (notification.method === 'connection/status') {
        const status = readString(asRecord(notification.params)?.status) as UiNotificationConnectionState | null
        if (status && ['connecting', 'connected', 'reconnecting', 'unavailable'].includes(status)) {
          notificationConnectionState.value = status
        }
        return
      }
      if (notification.method === 'codex-ui/agent-progress') {
        const snapshot = normalizeAgentProgressSnapshot(asRecord(notification.params)?.progress)
        if (snapshot) setAgentProgressSnapshot(snapshot)
        return
      }
      if (notification.method === 'ready') {
        notificationConnectionState.value = 'connected'
        clearAllTransientTurnErrors()
        const params = asRecord(notification.params)
        const replayRecoveryRequired = params?.replayAvailable !== true || params?.streamChanged === true
        const forceRefresh = hasReceivedNotificationReady && replayRecoveryRequired
        hasReceivedNotificationReady = true
        void recoverBridgeState(forceRefresh)
        threadRuntimePolling.requestImmediate()
        return
      }
      if (notification.method === 'heartbeat') return
      applyRealtimeUpdates(notification)
      queueEventDrivenSync(notification)
    })
    threadRuntimePolling.start()
  }

  async function loadPendingServerRequestsFromBridge(): Promise<void> {
    try {
      const rows = await getPendingServerRequests()
      const normalizedRequests = rows
        .map((row) => normalizeServerRequest(row))
        .filter((request): request is UiServerRequest => request !== null)
      replacePendingServerRequests(normalizedRequests)
    } catch {
      // Keep UI usable when pending request endpoint is temporarily unavailable.
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<boolean> {
    try {
      const generation = reply.generation ?? selectedThreadServerRequests.value
        .find((request) => request.id === reply.id)?.generation
      if (generation === undefined) throw new Error('Server request generation is unavailable')
      await replyToServerRequest(reply.id, generation, {
        result: reply.result,
        error: reply.error,
      })
      removePendingServerRequestById(reply.id, generation)
      return true
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      return false
    }
  }

  function stopPolling(): void {
    agentProgressLoadGeneration += 1
    runtimeRequestGeneration += 1
    threadRuntimePolling.stop()
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }
    hasReceivedNotificationReady = false
    messageLoadGeneration += 1
    visibleMessageLoadOwnerThreadId = ''
    isLoadingMessages.value = false

    terminalRuntimeRefreshThreadIds.clear()
    latestRuntimeStateByThreadId.clear()
    terminalTurnAtMsByThreadId.clear()
    runtimeStateLifecycleEpochByThreadId.clear()
    lastAppliedRuntimeRequestByThreadId.clear()
    optimisticTurnStartedAtByThreadId.clear()

    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()
    pendingCompletedTurnReconciliationByThreadId.clear()
    pendingTurnStartsById.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    if (rateLimitRefreshTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(rateLimitRefreshTimer)
      rateLimitRefreshTimer = null
    }
    threadListLoader.stop()
    if (typeof window !== 'undefined') {
      for (const timerId of delayedTurnSyncTimerByThreadId.values()) {
        window.clearTimeout(timerId)
      }
    }
    delayedTurnSyncTimerByThreadId.clear()
    loadMessagePromiseByThreadId.clear()
    forcedMessageLoadPromiseByThreadId.clear()
    threadHistoryModeProbeByThreadId.clear()
    paginatedTurnReconcileByKey.clear()
    threadHistoryAccessOrderByThreadId.clear()
    threadHistoryAccessSequence = 0
    lastMessageLoadAtByThreadId.clear()
    lastMessageLoadFailureAtByThreadId.clear()
    liveDeltaBuffer.reset()
    agentProgressLoadPromiseByThreadId.clear()
    lastAgentProgressLoadAtByThreadId.clear()
    agentProgressRetryStateByThreadId.clear()
    agentProgressLoadEpochByThreadId.clear()
    activeReasoningItemIdByThreadId.clear()
    shouldAutoScrollOnNextAgentEvent = false
    persistedMessagesByThreadId.value = {}
    loadedMessagesByThreadId.value = {}
    loadedVersionByThreadId.value = {}
    threadHistoryStateById.value = {}
    hasMoreOlderMessagesByThreadId.value = {}
    loadingOlderMessagesByThreadId.value = {}
    resumedThreadById.value = {}
    livePlanMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    liveCommandsByThreadId.value = {}
    liveFileChangeMessagesByThreadId.value = {}
    agentProgressByThreadId.value = {}
    notificationConnectionState.value = 'connecting'
    turnIndexByTurnIdByThreadId.value = {}
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    interruptBlockedUntilPersistedByThreadId.value = {}
    threadListedByServerById.value = {}
    persistedUserMessageByThreadId.value = {}
    hasLoadedPersistedQueueState = false
    queueProcessingByThreadId.value = {}
    codexRateLimit.value = null
    threadTokenUsageByThreadId.value = {}
  }

  const selectedThreadQueuedMessages = computed<QueuedMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return queuedMessagesByThreadId.value[threadId] ?? []
  })

  function removeQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const next = queue.filter((m) => m.id !== messageId)
    queuedMessagesByThreadId.value = next.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: next }
      : omitKey(queuedMessagesByThreadId.value, threadId)
    persistQueueState()
  }

  function reorderQueuedMessage(draggedId: string, targetId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return

    const fromIndex = queue.findIndex((m) => m.id === draggedId)
    const toIndex = queue.findIndex((m) => m.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return

    const next = [...queue]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    queuedMessagesByThreadId.value = {
      ...queuedMessagesByThreadId.value,
      [threadId]: next,
    }
    persistQueueState()
  }

  function steerQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const msg = queue.find((m) => m.id === messageId)
    if (!msg) return
    removeQueuedMessage(messageId)
    setSelectedCollaborationMode(msg.collaborationMode)
    void sendMessageToSelectedThread(msg.text, msg.imageUrls, msg.skills, 'steer', msg.fileAttachments, undefined, msg.collaborationMode, msg.speedMode)
  }

  function primeSelectedThread(threadId: string, options: { persist?: boolean } = {}): void {
    setSelectedThreadId(threadId, options)
  }

  return {
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadTokenUsage,
    selectedThreadTerminalOpen,
    isSelectedThreadInterruptPending,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    pendingNewThreadMessages,
    pendingNewThreadLiveOverlay,
    codexQuota,
    selectedThreadId,
    availableCollaborationModes,
    availableModelIds,
    availableModelCapabilities,
    selectedCollaborationMode,
    selectedModelId,
    selectedReasoningEffort,
    selectedSpeedMode,
    selectedCodexPermissionMode,
    codexCliMissingError,
    installedSkills,
    accountRateLimitSnapshots,
    messages,
    hasMoreOlderMessages,
    isLoadingThreads,
    isLoadingMessages,
    isLoadingOlderMessages,
    isSendingMessage,
    isInterruptingTurn,
    isUpdatingSpeedMode,
    isUpdatingPermissionMode,
    isRollingBack,

    error,
    refreshAll,
    loadThreads,
    refreshSkills,
    selectThread,
    loadMessages,
    loadOlderMessages,
    loadAgentResult,
    ensureThreadMessagesLoaded,
    setThreadTerminalOpen,
    toggleSelectedThreadTerminal,
    archiveThreadById,
    permanentlyDeleteThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,

    sendMessageToSelectedThread,
    sendMessageToNewThread,
    beginPendingNewThreadPreview,
    clearPendingNewThreadPreview,
    interruptSelectedThreadTurn,
    selectedThreadQueuedMessages,
    removeQueuedMessage,
    reorderQueuedMessage,
    steerQueuedMessage,
    setSelectedCollaborationMode,
    readModelIdForThread,
    isFastModeSupportedForModel,
    setSelectedModelIdForThread,
    updateSelectedModelIdForThread,
    setSelectedModelId,

    setSelectedReasoningEffort,
    updateSelectedReasoningEffort,
    updateSelectedSpeedMode,
    updateSelectedCodexPermissionMode,
    respondToPendingServerRequest,
    renameProject,
    removeProject,
    reorderProject,
    pinProjectToTop,
    startPolling,
    stopPolling,
    primeSelectedThread,
  }
}
