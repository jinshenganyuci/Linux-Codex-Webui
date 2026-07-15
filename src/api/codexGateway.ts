import {
  fetchRpcMethodCatalog,
  fetchRpcNotificationCatalog,
  fetchPendingServerRequests,
  rpcCall,
  respondServerRequest,
  subscribeRpcNotifications,
  type RpcNotification,
} from './codexRpcClient'
import type {
  CollaborationModeListResponse,
  ConfigReadResponse,
  GetAccountRateLimitsResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  Turn,
} from './appServerDtos'
import { extractErrorMessage, normalizeCodexApiError } from './codexErrors'
import { fetchWithTimeout } from './requestClient'
export {
  cloneGithubRepository,
  createLocalDirectory,
  createProjectlessThreadDirectory,
  downloadProjectZip,
  getHomeDirectory,
  getProjectRootSuggestion,
  getProjectZipDownloadUrl,
  getWorkspaceRootsState,
  importProjectZip,
  listLocalDirectories,
  openProjectRoot,
  searchComposerFiles,
  searchThreads,
  setWorkspaceRootsState,
} from './projectGateway'
export type {
  ComposerFileSuggestion,
  LocalDirectoryEntry,
  LocalDirectoryListing,
  ThreadSearchResult,
  WorkspaceRootsState,
} from './projectGateway'
import {
  readActiveTurnIdFromResponse,
  normalizeThreadGroupsV2,
  normalizeThreadMessagesV2,
  normalizeThreadSummaryV2,
  readThreadInProgressFromResponse,
} from './normalizers/v2'
import type {
  ReasoningEffort,
  SpeedMode,
  UiAccountEntry,
  UiAccountQuotaStatus,
  UiAccountUnavailableReason,
  CollaborationModeKind,
  CollaborationModeOption,
  UiCreditsSnapshot,
  UiFileChange,
  UiMessage,
  UiModelCapability,
  UiProjectGroup,
  UiThread,
  UiReviewAction,
  UiReviewActionLevel,
  UiReviewFile,
  UiReviewFinding,
  UiReviewHunk,
  UiReviewLine,
  UiReviewResult,
  UiReviewScope,
  UiReviewSnapshot,
  UiReviewSummary,
  UiReviewWorkspaceView,
  UiRateLimitSnapshot,
  UiRateLimitWindow,
  UiThreadAutomation,
  UiThreadAutomationStatus,
  UiAgentProgressEvent,
  UiAgentProgressNode,
  UiAgentProgressPhase,
  UiAgentProgressStatus,
  UiTurnProgress,
} from '../types/codex'
import { normalizePathForUi } from '../pathUtils.js'

type CurrentModelConfig = {
  model: string
  providerId: string
  reasoningEffort: ReasoningEffort | ''
  speedMode: SpeedMode
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

export type CodexRuntimeConfig = {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  memories: boolean
}

export type ThreadModelPreference = {
  model: string
  reasoningEffort: ReasoningEffort
}

export type ThreadModelPreferenceState = Record<string, ThreadModelPreference>

export type DirectoryPluginSummary = {
  id: string
  name: string
  displayName: string
  description: string
  longDescription: string
  developerName: string
  category: string
  marketplaceName: string
  marketplaceDisplayName: string
  marketplacePath: string | null
  remoteMarketplaceName: string | null
  sourceType: string
  sourceUrl: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  logoUrl: string
  logoPath: string
  composerIconUrl: string
  composerIconPath: string
  brandColor: string
  capabilities: string[]
  defaultPrompt: string[]
  screenshotUrls: string[]
  screenshots: string[]
  websiteUrl: string
  privacyPolicyUrl: string
  termsOfServiceUrl: string
}

export type DirectoryPluginDetail = {
  summary: DirectoryPluginSummary
  description: string
  apps: DirectoryPluginAppSummary[]
  skills: DirectoryPluginSkillSummary[]
  mcpServers: string[]
}

export type DirectoryPluginAppSummary = {
  id: string
  name: string
  description: string
  installUrl: string
  needsAuth: boolean
}

export type DirectoryPluginSkillSummary = {
  name: string
  description: string
  path: string
  enabled: boolean
  displayName: string
  shortDescription: string
}

export type DirectoryPluginInstallResult = {
  authPolicy: string
  appsNeedingAuth: DirectoryPluginAppSummary[]
}

export type DirectoryAppInfo = {
  id: string
  name: string
  description: string
  logoUrl: string
  logoUrlDark: string
  distributionChannel: string
  installUrl: string
  isAccessible: boolean
  isEnabled: boolean
  pluginDisplayNames: string[]
  category: string
  developer: string
  website: string
  privacyPolicy: string
  termsOfService: string
  catalogRank: number
}

export type DirectoryMcpServerStatus = {
  name: string
  authStatus: string
  tools: Array<{ name: string; title: string; description: string }>
  resources: Array<{ name: string; title: string; uri: string; description: string }>
  resourceTemplates: Array<{ name: string; title: string; uriTemplate: string; description: string }>
}

export type DirectoryMcpLoginResult = {
  authorizationUrl: string
}

export type DirectoryComposioStatus = {
  available: boolean
  authenticated: boolean
  cliVersion: string
  email: string
  defaultOrgName: string
  defaultOrgId: string
  webUrl: string
  baseUrl: string
  testUserId: string
}

export type DirectoryComposioConnection = {
  id: string
  wordId: string
  alias: string
  status: string
  authScheme: string
  createdAt: string
  updatedAt: string
  isComposioManaged: boolean
  isDisabled: boolean
}

export type DirectoryComposioConnector = {
  slug: string
  name: string
  description: string
  logoUrl: string
  latestVersion: string
  toolsCount: number
  triggersCount: number
  isNoAuth: boolean
  enabled: boolean
  authModes: string[]
  activeCount: number
  totalConnections: number
  connectionStatuses: string[]
}

export type DirectoryComposioTool = {
  slug: string
  name: string
  description: string
}

export type DirectoryComposioConnectorDetail = {
  connector: DirectoryComposioConnector
  connections: DirectoryComposioConnection[]
  tools: DirectoryComposioTool[]
  dashboardUrl: string
}

export type DirectoryComposioLinkResult = {
  status: string
  message: string
  connectedAccountId: string
  redirectUrl: string
  toolkit: string
  projectType: string
}

export type DirectoryComposioLoginResult = {
  status: string
  message: string
  loginUrl: string
  cliKey: string
  expiresAt: string
}

export type ComposerPromptInfo = {
  name: string
  path: string
  content: string
  description: string
}

export type DirectoryComposioInstallResult = {
  ok: boolean
  command: string
  output: string
}

type DirectoryComposioConnectorPage = {
  data: DirectoryComposioConnector[]
  nextCursor: string | null
  total: number
}

type ProviderModelsResponse = {
  data?: unknown
  exclusive?: unknown
}

const PROVIDER_MODELS_FETCH_TIMEOUT_MS = 5_000

type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

function normalizePlanModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

export type StoredQueuedMessage = {
  id: string
  text: string
  imageUrls: string[]
  skills: Array<{ name: string; path: string }>
  fileAttachments: Array<{ label: string; path: string; fsPath: string }>
  collaborationMode: CollaborationModeKind
  speedMode?: SpeedMode
  model?: string
  reasoningEffort?: ReasoningEffort
}

export type ThreadQueueState = Record<string, StoredQueuedMessage[]>

const DEFAULT_COLLABORATION_MODE_OPTIONS: CollaborationModeOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
]

export type WorktreeCreateResult = {
  cwd: string
  branch: string | null
  gitRoot: string
}

export type WorktreeBranchOption = {
  value: string
  label: string
  isCurrent?: boolean
  isRemote?: boolean
}

export type GitBranchState = {
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
  options: WorktreeBranchOption[]
}

export type GitCommitOption = {
  sha: string
  shortSha: string
  subject: string
  date: string
}

export type GitCommitFileChange = {
  path: string
  previousPath: string | null
  status: string
  label: string
  addedLineCount: number | null
  removedLineCount: number | null
}

export type GitRepositoryStatus = {
  isGitRepo: boolean
  gitRoot: string
}



export type TelegramStatus = {
  configured: boolean
  active: boolean
  mappedChats: number
  mappedThreads: number
  allowedUsers: number
  allowAllUsers: boolean
  lastError: string
}

export type TelegramConfig = {
  botToken: string
  allowedUserIds: Array<number | '*'>
}

export type ThreadTerminalSession = {
  id: string
  threadId: string
  cwd: string
  shell: string
  buffer: string
  truncated: boolean
}

export type ThreadTerminalAttachInput = {
  threadId: string
  cwd: string
  sessionId?: string
  cols?: number
  rows?: number
  newSession?: boolean
}

export type ThreadTerminalQuickCommand = {
  label: string
  value: string
  source: 'package' | 'script' | 'make'
}

export type AccountsListResult = {
  activeAccountId: string | null
  activeStorageId: string | null
  accounts: UiAccountEntry[]
  importedAccountId?: string
  importedStorageId?: string
}

type ThreadFileChangeFallbackEntry = {
  turnId: string
  turnIndex: number
  fileChanges: UiFileChange[]
}

type ThreadTurnIndexById = Record<string, number>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function normalizeAccountUnavailableReason(value: unknown): UiAccountUnavailableReason | null {
  return value === 'payment_required' ? value : null
}

function isPaymentRequiredErrorMessage(value: string | null): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  return normalized.includes('payment required') || /\b402\b/.test(normalized)
}

function normalizeRateLimitWindow(value: unknown): UiRateLimitWindow | null {
  const record = asRecord(value)
  if (!record) return null

  const usedPercent = readNumber(record.usedPercent ?? record.used_percent)
  if (usedPercent === null) return null

  const windowValue = readNumber(record.windowDurationMins ?? record.window_minutes)
  return {
    usedPercent,
    windowDurationMins: windowValue,
    windowMinutes: windowValue,
    resetsAt: readNumber(record.resetsAt ?? record.resets_at),
  }
}

function normalizeCreditsSnapshot(value: unknown): UiCreditsSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const hasCredits = readBoolean(record.hasCredits ?? record.has_credits)
  const unlimited = readBoolean(record.unlimited)
  if (hasCredits === null || unlimited === null) return null

  return {
    hasCredits,
    unlimited,
    balance: readString(record.balance),
  }
}

function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const primary = normalizeRateLimitWindow(record.primary)
  const secondary = normalizeRateLimitWindow(record.secondary)
  const credits = normalizeCreditsSnapshot(record.credits)

  if (!primary && !secondary && !credits) return null

  return {
    limitId: readString(record.limitId ?? record.limit_id),
    limitName: readString(record.limitName ?? record.limit_name),
    primary,
    secondary,
    credits,
    planType: readString(record.planType ?? record.plan_type),
  }
}

function normalizeAccountEntry(
  value: unknown,
  activeAccountId: string | null = null,
  activeStorageId: string | null = null,
): UiAccountEntry | null {
  const record = asRecord(value)
  if (!record) return null
  const accountId = readString(record.accountId)
  const storageId = readString(record.storageId) ?? accountId
  const quotaStatusRaw = readString(record.quotaStatus)
  const quotaStatus: UiAccountQuotaStatus =
    quotaStatusRaw === 'loading' || quotaStatusRaw === 'ready' || quotaStatusRaw === 'error' ? quotaStatusRaw : 'idle'
  if (!accountId) return null
  return {
    accountId,
    storageId: storageId ?? accountId,
    userId: readString(record.userId),
    authMode: readString(record.authMode),
    email: readString(record.email),
    planType: readString(record.planType),
    lastRefreshedAtIso: readString(record.lastRefreshedAtIso) ?? '',
    lastActivatedAtIso: readString(record.lastActivatedAtIso),
    quotaSnapshot: normalizeRateLimitSnapshot(record.quotaSnapshot),
    quotaUpdatedAtIso: readString(record.quotaUpdatedAtIso),
    quotaStatus,
    quotaError: readString(record.quotaError),
    unavailableReason: normalizeAccountUnavailableReason(record.unavailableReason)
      ?? (isPaymentRequiredErrorMessage(readString(record.quotaError)) ? 'payment_required' : null),
    isActive: readBoolean(record.isActive) ?? (storageId === activeStorageId || accountId === activeAccountId),
  }
}

export function pickCodexRateLimitSnapshot(payload: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(payload)
  if (!record) return null

  const rateLimitsByLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id)
  const codexBucket = normalizeRateLimitSnapshot(rateLimitsByLimitId?.codex)
  if (codexBucket) return codexBucket

  return normalizeRateLimitSnapshot(record.rateLimits ?? record.rate_limits)
}

const LONG_RPC_METHODS = new Set([
  'thread/read',
  'thread/resume',
  'thread/start',
  'thread/fork',
  'turn/start',
  'review/start',
  'plugin/install',
  'plugin/uninstall',
  'config/mcpServer/reload',
  'mcpServer/oauth/login',
])

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params, {
      timeout: LONG_RPC_METHODS.has(method) ? 'long' : 'rpc',
    })
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

function normalizeFallbackFileChange(value: unknown): UiFileChange | null {
  const record = asRecord(value)
  if (!record) return null

  const path = readString(record.path)
  const operation = readString(record.operation)
  if (!path || (operation !== 'add' && operation !== 'delete' && operation !== 'update')) {
    return null
  }

  return {
    path,
    operation,
    movedToPath: readString(record.movedToPath) ?? null,
    diff: readString(record.diff) ?? '',
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
  }
}

function normalizeThreadFileChangeFallback(value: unknown): ThreadFileChangeFallbackEntry[] {
  const payload = asRecord(value)
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const normalized: ThreadFileChangeFallbackEntry[] = []

  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue

    const turnId = readString(record.turnId)
    const turnIndex = readNumber(record.turnIndex)
    const fileChanges = Array.isArray(record.fileChanges)
      ? record.fileChanges
        .map((entry) => normalizeFallbackFileChange(entry))
        .filter((entry): entry is UiFileChange => entry !== null)
      : []

    if (!turnId || turnIndex === null || fileChanges.length === 0) continue
    normalized.push({ turnId, turnIndex, fileChanges })
  }

  return normalized
}

function buildTurnIndexByTurnId(payload: ThreadReadResponse, baseTurnIndex = 0): ThreadTurnIndexById {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const lookup: ThreadTurnIndexById = {}

  for (let turnOffset = 0; turnOffset < turns.length; turnOffset += 1) {
    const turnIndex = baseTurnIndex + turnOffset
    const turn = turns[turnOffset]
    if (typeof turn?.id !== 'string' || turn.id.length === 0) continue
    lookup[turn.id] = turnIndex
  }

  return lookup
}

function readThreadTurnStartIndex(payload: ThreadReadResponse): number {
  const record = asRecord(payload)
  const raw = record?.threadTurnStartIndex
  return Math.max(0, Math.floor(typeof raw === 'number' ? raw : 0))
}

async function fetchThreadFileChangeFallback(threadId: string): Promise<ThreadFileChangeFallbackEntry[]> {
  const response = await fetchWithTimeout(`/codex-api/thread-file-change-fallback?threadId=${encodeURIComponent(threadId)}`, undefined, {
    timeout: 'long',
    operation: 'thread-file-change-fallback',
  })
  if (!response.ok) {
    throw new Error(`Fallback request failed with ${response.status}`)
  }
  return normalizeThreadFileChangeFallback(await response.json())
}

function mergeRecoveredFileChangeMessages(messages: UiMessage[], fallbackEntries: ThreadFileChangeFallbackEntry[]): UiMessage[] {
  if (fallbackEntries.length === 0) return messages

  const localTurnIndexByTurnId = new Map<string, number>()
  const coveredTurnIds = new Set<string>()

  for (const message of messages) {
    const tid = typeof message.turnId === 'string' && message.turnId.length > 0 ? message.turnId : undefined
    const tIdx = typeof message.turnIndex === 'number' ? message.turnIndex : undefined
    if (tid && tIdx !== undefined) localTurnIndexByTurnId.set(tid, tIdx)

    const hasFileData =
      message.messageType === 'fileChange' ||
      (Array.isArray(message.fileChanges) && message.fileChanges.length > 0)
    if (hasFileData && tid) coveredTurnIds.add(tid)
  }

  const extraMessages = fallbackEntries
    .filter((entry) => localTurnIndexByTurnId.has(entry.turnId) && !coveredTurnIds.has(entry.turnId))
    .map<UiMessage>((entry) => ({
      id: `session-file-change:${entry.turnId}`,
      role: 'system',
      text: '',
      messageType: 'fileChange',
      fileChangeStatus: 'completed',
      fileChanges: entry.fileChanges,
      turnId: entry.turnId,
      turnIndex: localTurnIndexByTurnId.get(entry.turnId) ?? entry.turnIndex,
    }))

  if (extraMessages.length === 0) return messages

  const extrasByTurnIndex = new Map<number, UiMessage[]>()
  for (const message of extraMessages) {
    const turnIndex = message.turnIndex
    if (typeof turnIndex !== 'number') continue
    const current = extrasByTurnIndex.get(turnIndex)
    if (current) current.push(message)
    else extrasByTurnIndex.set(turnIndex, [message])
  }

  const insertedTurnIndices = new Set<number>()
  const merged: UiMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    merged.push(message)

    const turnIndex = message.turnIndex
    if (typeof turnIndex !== 'number' || insertedTurnIndices.has(turnIndex)) continue
    const nextTurnIndex = messages[index + 1]?.turnIndex
    if (nextTurnIndex === turnIndex) continue

    const extras = extrasByTurnIndex.get(turnIndex)
    if (!extras || extras.length === 0) continue

    merged.push(...extras)
    insertedTurnIndices.add(turnIndex)
  }

  return merged
}

async function enrichThreadMessagesWithFallback(threadId: string, messages: UiMessage[]): Promise<UiMessage[]> {
  try {
    const fallbackEntries = await fetchThreadFileChangeFallback(threadId)
    return mergeRecoveredFileChangeMessages(messages, fallbackEntries)
  } catch {
    return messages
  }
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  const allowed: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return typeof value === 'string' && allowed.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
}

function normalizeSpeedMode(value: unknown): SpeedMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'fast'
    ? 'fast'
    : 'standard'
}

const INITIAL_THREAD_LIST_LIMIT = 50
const BACKGROUND_THREAD_LIST_LIMIT = 100

export type ThreadGroupsPage = {
  groups: UiProjectGroup[]
  nextCursor: string | null
}

export type ArchivedThreadsPage = {
  threads: UiThread[]
  nextCursor: string | null
}

export type ThreadTurnPage = {
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  startTurnIndex: number
  turnIndexByTurnId: ThreadTurnIndexById
}

export type ThreadRuntimeState = {
  threadId: string
  turnId: string
  state: 'running' | 'completed' | 'interrupted' | 'idle'
  isRunning: boolean
  source: 'session' | 'local' | 'external' | 'none'
  startedAtIso: string | null
  completedAtIso: string | null
  owner: {
    instanceId: string
    processId: number
    processIdentity: string
    port: number | null
    local: boolean
    heartbeatAtIso: string
  } | null
}

const AGENT_PROGRESS_PHASES = new Set<UiAgentProgressPhase>([
  'preparing',
  'reasoning',
  'dispatching',
  'waitingForAgents',
  'executing',
  'applyingChanges',
  'summarizing',
  'completed',
  'interrupted',
  'failed',
])

const AGENT_PROGRESS_STATUSES = new Set<UiAgentProgressStatus>([
  'starting',
  'running',
  'completed',
  'interrupted',
  'errored',
])

function normalizeAgentProgressNode(value: unknown): UiAgentProgressNode | null {
  const row = asRecord(value)
  const threadId = readString(row?.threadId)
  const status = readString(row?.status) as UiAgentProgressStatus | null
  if (!threadId || !status || !AGENT_PROGRESS_STATUSES.has(status)) return null
  return {
    threadId,
    parentThreadId: readString(row?.parentThreadId) ?? '',
    path: readString(row?.path) ?? '',
    nickname: readString(row?.nickname) ?? '',
    depth: Math.max(1, Math.round(readNumber(row?.depth) ?? 1)),
    taskSummary: readString(row?.taskSummary) ?? '',
    model: readString(row?.model) ?? '',
    reasoningEffort: readString(row?.reasoningEffort) ?? '',
    status,
    startedAtMs: Math.max(0, readNumber(row?.startedAtMs) ?? 0),
    lastActivityAtMs: Math.max(0, readNumber(row?.lastActivityAtMs) ?? 0),
    completedAtMs: readNumber(row?.completedAtMs),
    currentActivity: readString(row?.currentActivity) ?? '',
    resultAvailable: row?.resultAvailable === true,
  }
}

function normalizeAgentProgressEvent(value: unknown): UiAgentProgressEvent | null {
  const row = asRecord(value)
  const id = readString(row?.id)
  if (!id) return null
  const phaseValue = readString(row?.phase) as UiAgentProgressPhase | null
  return {
    id,
    atMs: Math.max(0, readNumber(row?.atMs) ?? 0),
    kind: readString(row?.kind) ?? '',
    threadId: readString(row?.threadId) ?? '',
    agentThreadId: readString(row?.agentThreadId) ?? '',
    phase: phaseValue && AGENT_PROGRESS_PHASES.has(phaseValue) ? phaseValue : null,
    detail: readString(row?.detail) ?? '',
  }
}

export function normalizeAgentProgressSnapshot(value: unknown): UiTurnProgress | null {
  const row = asRecord(value)
  const rootThreadId = readString(row?.rootThreadId)
  const phase = readString(row?.phase) as UiAgentProgressPhase | null
  const status = readString(row?.status)
  if (!rootThreadId || !phase || !AGENT_PROGRESS_PHASES.has(phase)) return null
  if (!status || !['idle', 'running', 'completed', 'interrupted', 'failed'].includes(status)) return null
  return {
    rootThreadId,
    turnId: readString(row?.turnId) ?? '',
    status: status as UiTurnProgress['status'],
    phase,
    startedAtMs: Math.max(0, readNumber(row?.startedAtMs) ?? 0),
    lastActivityAtMs: Math.max(0, readNumber(row?.lastActivityAtMs) ?? 0),
    mainLastActivityAtMs: Math.max(0, readNumber(row?.mainLastActivityAtMs) ?? 0),
    updatedAtMs: Math.max(0, readNumber(row?.updatedAtMs) ?? 0),
    agents: (Array.isArray(row?.agents) ? row.agents : [])
      .map(normalizeAgentProgressNode)
      .filter((agent): agent is UiAgentProgressNode => agent !== null),
    events: (Array.isArray(row?.events) ? row.events : [])
      .map(normalizeAgentProgressEvent)
      .filter((event): event is UiAgentProgressEvent => event !== null),
  }
}

function normalizeThreadRuntimeState(value: unknown): ThreadRuntimeState | null {
  const row = asRecord(value)
  const threadId = readString(row?.threadId)
  const state = readString(row?.state)
  if (!threadId || !state || !['running', 'completed', 'interrupted', 'idle'].includes(state)) return null
  const source = readString(row?.source)
  const ownerRow = asRecord(row?.owner)
  const ownerInstanceId = readString(ownerRow?.instanceId)
  const owner = ownerInstanceId
    ? {
        instanceId: ownerInstanceId,
        processId: typeof ownerRow?.processId === 'number' ? ownerRow.processId : 0,
        processIdentity: readString(ownerRow?.processIdentity) ?? '',
        port: typeof ownerRow?.port === 'number' ? ownerRow.port : null,
        local: ownerRow?.local === true,
        heartbeatAtIso: readString(ownerRow?.heartbeatAtIso) ?? '',
      }
    : null
  return {
    threadId,
    turnId: readString(row?.turnId) ?? '',
    state: state as ThreadRuntimeState['state'],
    isRunning: row?.isRunning === true,
    source: source && ['session', 'local', 'external', 'none'].includes(source)
      ? source as ThreadRuntimeState['source']
      : 'none',
    startedAtIso: readString(row?.startedAtIso) || null,
    completedAtIso: readString(row?.completedAtIso) || null,
    owner,
  }
}

export async function getThreadRuntimeStates(threadIds: string[]): Promise<ThreadRuntimeState[]> {
  const normalizedThreadIds = Array.from(new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)))
  if (normalizedThreadIds.length === 0) return []
  let response: Response
  try {
    response = await fetchWithTimeout('/codex-api/thread-runtime-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: normalizedThreadIds }),
    })
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to read thread runtime state', 'thread-runtime-state')
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Thread runtime state request failed with HTTP ${response.status}`))
  }
  const rows = Array.isArray(asRecord(payload)?.data) ? asRecord(payload)?.data as unknown[] : []
  return rows
    .map(normalizeThreadRuntimeState)
    .filter((state): state is ThreadRuntimeState => state !== null)
}

export async function getAgentProgress(threadId: string): Promise<UiTurnProgress | null> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return null
  const response = await fetchWithTimeout(`/codex-api/agent-progress?threadId=${encodeURIComponent(normalizedThreadId)}`, undefined, {
    timeout: 'long',
    operation: 'agent-progress',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Agent progress request failed with HTTP ${response.status}`))
  }
  return normalizeAgentProgressSnapshot(asRecord(payload)?.data)
}

export async function getAgentResult(threadId: string): Promise<{ threadId: string; text: string; truncated: boolean }> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return { threadId: '', text: '', truncated: false }
  const response = await fetchWithTimeout(`/codex-api/agent-result?threadId=${encodeURIComponent(normalizedThreadId)}`, undefined, {
    timeout: 'long',
    operation: 'agent-result',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Agent result request failed with HTTP ${response.status}`))
  }
  const row = asRecord(asRecord(payload)?.data)
  return {
    threadId: readString(row?.threadId) ?? normalizedThreadId,
    text: readString(row?.text) ?? '',
    truncated: row?.truncated === true,
  }
}

async function getThreadGroupsPageV2(cursor: string | null, limit: number): Promise<ThreadGroupsPage> {
  const payload = await callRpc<ThreadListResponse>('thread/list', {
    archived: false,
    limit,
    sortKey: 'updated_at',
    modelProviders: [],
    cursor,
  })
  return {
    groups: normalizeThreadGroupsV2(payload),
    nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0
      ? payload.nextCursor
      : null,
  }
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  return normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload))
}

async function getThreadSummaryV2(threadId: string): Promise<UiThread> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: false,
  })
  return normalizeThreadSummaryV2(payload)
}

async function getThreadDetailV2(threadId: string): Promise<{
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  turnIndexByTurnId: ThreadTurnIndexById
}> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  const startTurnIndex = readThreadTurnStartIndex(payload)
  const normalized = normalizeThreadMessagesV2(payload, startTurnIndex)
  return {
    model: normalizeThreadModelFromPayload(payload),
    modelProvider: normalizeThreadModelProviderFromPayload(payload),
    messages: normalized,
    inProgress: readThreadInProgressFromResponse(payload),
    activeTurnId: readActiveTurnIdFromResponse(payload),
    hasMoreOlder: startTurnIndex > 0,
    turnIndexByTurnId: buildTurnIndexByTurnId(payload, startTurnIndex),
  }
}

async function getOlderThreadMessagesV2(threadId: string, beforeTurnId: string, limit = 10): Promise<ThreadTurnPage> {
  const params = new URLSearchParams({
    threadId,
    beforeTurnId,
    limit: String(limit),
  })
  const response = await fetchWithTimeout(`/codex-api/thread-turn-page?${params.toString()}`, undefined, {
    timeout: 'long',
    operation: 'thread-turn-page',
  })
  if (!response.ok) {
    throw new Error(`Older thread page request failed with ${response.status}`)
  }
  const payload = await response.json() as {
    result?: ThreadReadResponse
    hasMoreOlder?: unknown
    startTurnIndex?: unknown
  }
  if (!payload.result) {
    throw new Error('Older thread page response did not include a thread result')
  }
  const startTurnIndex = Math.max(0, Math.floor(typeof payload.startTurnIndex === 'number' ? payload.startTurnIndex : 0))

  return {
    messages: normalizeThreadMessagesV2(payload.result, startTurnIndex),
    inProgress: readThreadInProgressFromResponse(payload.result),
    activeTurnId: readActiveTurnIdFromResponse(payload.result),
    hasMoreOlder: payload.hasMoreOlder === true,
    startTurnIndex,
    turnIndexByTurnId: buildTurnIndexByTurnId(payload.result, startTurnIndex),
  }
}

export async function getThreadGroups(): Promise<UiProjectGroup[]> {
  try {
    return (await getThreadGroupsPageV2(null, INITIAL_THREAD_LIST_LIMIT)).groups
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function getThreadGroupsPage(
  cursor: string | null = null,
  limit = INITIAL_THREAD_LIST_LIMIT,
): Promise<ThreadGroupsPage> {
  try {
    return await getThreadGroupsPageV2(cursor, limit)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function getArchivedThreadsPage(
  cursor: string | null = null,
  limit = INITIAL_THREAD_LIST_LIMIT,
): Promise<ArchivedThreadsPage> {
  try {
    const payload = await callRpc<ThreadListResponse>('thread/list', {
      archived: true,
      limit,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor,
    })
    const threads = normalizeThreadGroupsV2(payload)
      .flatMap((group) => group.threads)
      .sort((first, second) => (
        new Date(second.updatedAtIso).getTime() - new Date(first.updatedAtIso).getTime()
      ))
    return {
      threads,
      nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0
        ? payload.nextCursor
        : null,
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load archived threads', 'thread/list')
  }
}

export function getBackgroundThreadListLimit(): number {
  return BACKGROUND_THREAD_LIST_LIMIT
}

export async function getThreadMessages(threadId: string): Promise<UiMessage[]> {
  try {
    return await getThreadMessagesV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadSummary(threadId: string): Promise<UiThread> {
  try {
    return await getThreadSummaryV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadDetail(threadId: string): Promise<{
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  turnIndexByTurnId: ThreadTurnIndexById
}> {
  try {
    return await getThreadDetailV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getOlderThreadMessages(threadId: string, beforeTurnId: string, limit?: number): Promise<ThreadTurnPage> {
  try {
    return await getOlderThreadMessagesV2(threadId, beforeTurnId, limit)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load earlier messages for thread ${threadId}`, 'thread/read')
  }
}

function normalizeReviewLine(value: unknown): UiReviewLine | null {
  const record = asRecord(value)
  if (!record) return null

  const key = readString(record.key)
  const text = typeof record.text === 'string' ? record.text : ''
  const kind = readString(record.kind)
  if (!key || !kind) return null
  if (kind !== 'meta' && kind !== 'hunk' && kind !== 'add' && kind !== 'remove' && kind !== 'context') {
    return null
  }

  return {
    key,
    kind,
    text,
    oldLine: readNumber(record.oldLine),
    newLine: readNumber(record.newLine),
  }
}

function normalizeReviewHunk(value: unknown): UiReviewHunk | null {
  const record = asRecord(value)
  if (!record) return null

  const id = readString(record.id)
  const header = typeof record.header === 'string' ? record.header : ''
  const patch = typeof record.patch === 'string' ? record.patch : ''
  if (!id) return null

  return {
    id,
    header,
    patch,
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
    oldStart: readNumber(record.oldStart),
    oldLineCount: readNumber(record.oldLineCount) ?? 0,
    newStart: readNumber(record.newStart),
    newLineCount: readNumber(record.newLineCount) ?? 0,
    lines: Array.isArray(record.lines)
      ? record.lines
        .map((entry) => normalizeReviewLine(entry))
        .filter((entry): entry is UiReviewLine => entry !== null)
      : [],
  }
}

function normalizeReviewFile(value: unknown): UiReviewFile | null {
  const record = asRecord(value)
  if (!record) return null

  const id = readString(record.id)
  const path = readString(record.path)
  const absolutePath = readString(record.absolutePath)
  const operation = readString(record.operation)
  if (!id || !path || !absolutePath || !operation) return null
  if (operation !== 'add' && operation !== 'delete' && operation !== 'update' && operation !== 'rename') {
    return null
  }

  return {
    id,
    path,
    absolutePath,
    previousPath: readString(record.previousPath),
    previousAbsolutePath: readString(record.previousAbsolutePath),
    operation,
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
    diff: typeof record.diff === 'string' ? record.diff : '',
    hunks: Array.isArray(record.hunks)
      ? record.hunks
        .map((entry) => normalizeReviewHunk(entry))
        .filter((entry): entry is UiReviewHunk => entry !== null)
      : [],
  }
}

function normalizeReviewSnapshot(payload: unknown): UiReviewSnapshot {
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const summaryRecord = asRecord(data?.summary)
  const rawScope = readString(data?.scope)
  const scope = rawScope === 'baseBranch' || rawScope === 'commit' ? rawScope : 'workspace'
  const workspaceView = readString(data?.workspaceView) === 'staged' ? 'staged' : 'unstaged'

  return {
    cwd: readString(data?.cwd) ?? '',
    gitRoot: readString(data?.gitRoot),
    isGitRepo: readBoolean(data?.isGitRepo) ?? false,
    scope,
    workspaceView,
    baseBranch: readString(data?.baseBranch),
    baseBranchOptions: Array.isArray(data?.baseBranchOptions)
      ? data.baseBranchOptions
        .map((entry) => readString(entry))
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [],
    commitSha: readString(data?.commitSha),
    headBranch: readString(data?.headBranch),
    mergeBaseSha: readString(data?.mergeBaseSha),
    generatedAtIso: readString(data?.generatedAtIso) ?? '',
    summary: {
      fileCount: readNumber(summaryRecord?.fileCount) ?? 0,
      addedLineCount: readNumber(summaryRecord?.addedLineCount) ?? 0,
      removedLineCount: readNumber(summaryRecord?.removedLineCount) ?? 0,
    },
    files: Array.isArray(data?.files)
      ? data.files
        .map((entry) => normalizeReviewFile(entry))
        .filter((entry): entry is UiReviewFile => entry !== null)
      : [],
  }
}

function normalizeReviewSummary(payload: unknown): UiReviewSummary {
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  return {
    fileCount: readNumber(data?.fileCount) ?? 0,
    addedLineCount: readNumber(data?.addedLineCount) ?? 0,
    removedLineCount: readNumber(data?.removedLineCount) ?? 0,
  }
}

function parseReviewLocation(value: string): {
  absolutePath: string | null
  startLine: number | null
  endLine: number | null
} {
  const trimmed = value.trim()
  if (!trimmed) {
    return { absolutePath: null, startLine: null, endLine: null }
  }

  const match = trimmed.match(/^(.*?):(\d+)-(\d+)$/u)
  if (!match) {
    return { absolutePath: trimmed || null, startLine: null, endLine: null }
  }

  return {
    absolutePath: match[1]?.trim() || null,
    startLine: Number(match[2]),
    endLine: Number(match[3]),
  }
}

function parseReviewText(reviewText: string): UiReviewResult {
  const normalized = reviewText.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return { reviewText: '', summary: '', findings: [] }
  }

  const markerIndex = normalized.search(/\n(?:Full review comments|Review comment):\n/iu)
  const summary = markerIndex >= 0 ? normalized.slice(0, markerIndex).trim() : normalized
  const findingsSection = markerIndex >= 0 ? normalized.slice(markerIndex).trim() : ''
  const findings: UiReviewFinding[] = []

  if (findingsSection) {
    const body = findingsSection
      .replace(/^(?:Full review comments|Review comment):\n*/iu, '')
      .trim()
    const matches = body.matchAll(/^- (.+?) — (.+)\n?((?:  .*(?:\n|$))*)/gmu)
    let index = 0
    for (const match of matches) {
      const title = match[1]?.trim() ?? ''
      const location = parseReviewLocation(match[2] ?? '')
      const block = (match[0] ?? '').trim()
      const findingBody = (match[3] ?? '')
        .split('\n')
        .map((line) => line.replace(/^  /u, ''))
        .join('\n')
        .trim()

      findings.push({
        id: `finding:${index}`,
        title: title || `Finding ${index + 1}`,
        body: findingBody,
        path: location.absolutePath ? location.absolutePath.split('/').filter(Boolean).slice(-1)[0] ?? location.absolutePath : null,
        absolutePath: location.absolutePath,
        startLine: location.startLine,
        endLine: location.endLine,
        rawText: block,
      })
      index += 1
    }
  }

  return {
    reviewText: normalized,
    summary,
    findings,
  }
}

function readLatestReviewItem(payload: ThreadReadResponse, type: 'enteredReviewMode' | 'exitedReviewMode'): string | null {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]
      if (item?.type !== type) continue
      const review = typeof item.review === 'string' ? item.review.trim() : ''
      if (review) return review
    }
  }
  return null
}

export async function getThreadReviewResult(threadId: string): Promise<{
  enteredReviewLabel: string | null
  result: UiReviewResult | null
}> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })

  const exitedReview = readLatestReviewItem(payload, 'exitedReviewMode')
  return {
    enteredReviewLabel: readLatestReviewItem(payload, 'enteredReviewMode'),
    result: exitedReview ? parseReviewText(exitedReview) : null,
  }
}

export async function getMethodCatalog(): Promise<string[]> {
  return fetchRpcMethodCatalog()
}

export async function getNotificationCatalog(): Promise<string[]> {
  return fetchRpcNotificationCatalog()
}

function asAutomation(record: unknown): UiThreadAutomation | null {
  const row = asRecord(record)
  if (!row) return null
  const id = readString(row.id)
  const kind = readString(row.kind)
  const name = readString(row.name)
  const prompt = readString(row.prompt)
  const rrule = readString(row.rrule)
  const status = readString(row.status)
  if (!id || !name || !prompt || !rrule) return null
  if (kind !== 'heartbeat' && kind !== 'cron') return null
  if (status !== 'ACTIVE' && status !== 'PAUSED') return null
  return {
    id,
    kind,
    name,
    prompt,
    rrule,
    status,
    targetThreadId: readString(row.targetThreadId),
    cwds: Array.isArray(row.cwds) ? row.cwds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [],
    createdAtMs: readNumber(row.createdAtMs),
    updatedAtMs: readNumber(row.updatedAtMs),
    nextRunAtMs: readNumber(row.nextRunAtMs),
  }
}

function asAutomationArray(value: unknown): UiThreadAutomation[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const automation = asAutomation(item)
    return automation ? [automation] : []
  })
  const automation = asAutomation(value)
  return automation ? [automation] : []
}

export async function getThreadAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetchWithTimeout('/codex-api/thread-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [threadId, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[threadId] = automations
  }
  return next
}

export async function getProjectAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetchWithTimeout('/codex-api/project-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load project automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [projectName, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[projectName] = automations
  }
  return next
}

export async function getThreadAutomation(threadId: string, automationId?: string): Promise<UiThreadAutomation | null> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetchWithTimeout(`/codex-api/thread-automation?${query.toString()}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automation'))
  }
  const data = asRecord(payload)?.data
  if (automationId) return asAutomation(data)
  return asAutomationArray(data)[0] ?? null
}

export async function upsertThreadAutomation(input: {
  threadId: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
}): Promise<UiThreadAutomation> {
  const response = await fetchWithTimeout('/codex-api/thread-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save thread automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Thread automation response was malformed')
  return automation
}

export async function upsertProjectAutomation(input: {
  projectName: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
}): Promise<UiThreadAutomation> {
  const response = await fetchWithTimeout('/codex-api/project-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save project automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Project automation response was malformed')
  return automation
}

export async function deleteThreadAutomation(threadId: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetchWithTimeout(`/codex-api/thread-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete thread automation'))
  }
}

export async function deleteProjectAutomation(projectName: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ projectName })
  if (automationId) query.set('automationId', automationId)
  const response = await fetchWithTimeout(`/codex-api/project-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete project automation'))
  }
}

export async function runThreadAutomationNow(threadId: string, automationId: string): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/thread-automation/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, automationId }),
  }, { timeout: 'long', operation: 'thread-automation/run' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to run thread automation'))
  }
}

export function subscribeCodexNotifications(onNotification: (value: RpcNotification) => void): () => void {
  return subscribeRpcNotifications(onNotification)
}

export type { RpcNotification }

function normalizeThreadTerminalSession(value: unknown): ThreadTerminalSession | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const threadId = readString(record.threadId)
  const cwd = readString(record.cwd)
  const shell = readString(record.shell)
  if (!id || !threadId || !cwd || !shell) return null
  return {
    id,
    threadId,
    cwd,
    shell,
    buffer: typeof record.buffer === 'string' ? record.buffer : '',
    truncated: readBoolean(record.truncated) ?? false,
  }
}

function normalizeCodexSandboxMode(value: unknown): CodexSandboxMode | null {
  const normalized = readString(value)?.trim().toLowerCase()
  if (
    normalized === 'read-only'
    || normalized === 'workspace-write'
    || normalized === 'danger-full-access'
  ) {
    return normalized
  }
  return null
}

function normalizeCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  const normalized = readString(value)?.trim().toLowerCase()
  if (
    normalized === 'untrusted'
    || normalized === 'on-failure'
    || normalized === 'on-request'
    || normalized === 'never'
  ) {
    return normalized
  }
  return null
}

function normalizeCodexRuntimeConfig(value: unknown): CodexRuntimeConfig {
  const record = asRecord(value)
  const sandboxMode = normalizeCodexSandboxMode(record?.sandboxMode)
  const approvalPolicy = normalizeCodexApprovalPolicy(record?.approvalPolicy)
  if (!sandboxMode || !approvalPolicy) {
    throw new Error('Codex runtime config response was malformed')
  }
  return {
    sandboxMode,
    approvalPolicy,
    memories: readBoolean(record?.memories) ?? true,
  }
}

async function fetchRuntimeConfigJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithTimeout(path, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Runtime config request failed with HTTP ${response.status}`))
  }
  return payload
}

export async function getCodexRuntimeConfig(): Promise<CodexRuntimeConfig> {
  const payload = await fetchRuntimeConfigJson('/codex-api/runtime-config')
  return normalizeCodexRuntimeConfig(payload)
}

export async function setCodexRuntimeConfig(input: Pick<CodexRuntimeConfig, 'sandboxMode' | 'approvalPolicy'>): Promise<CodexRuntimeConfig> {
  const payload = await fetchRuntimeConfigJson('/codex-api/runtime-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return normalizeCodexRuntimeConfig(payload)
}

async function fetchTerminalJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithTimeout(path, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Terminal request failed with HTTP ${response.status}`))
  }
  return payload
}

export async function attachThreadTerminal(input: ThreadTerminalAttachInput): Promise<ThreadTerminalSession> {
  const payload = await fetchTerminalJson('/codex-api/thread-terminal/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const session = normalizeThreadTerminalSession(asRecord(payload)?.session)
  if (!session) throw new Error('Terminal attach response was malformed')
  return session
}

export async function getThreadTerminalStatus(): Promise<{ available: boolean, reason: string | null }> {
  const payload = await fetchTerminalJson('/codex-api/thread-terminal/status')
  const record = asRecord(payload)
  return {
    available: readBoolean(record?.available) ?? false,
    reason: readString(record?.reason) || null,
  }
}

export async function getThreadTerminalQuickCommands(cwd: string): Promise<ThreadTerminalQuickCommand[]> {
  const payload = await fetchTerminalJson(`/codex-api/thread-terminal/quick-commands?cwd=${encodeURIComponent(cwd)}`)
  const payloadRecord = asRecord(payload)
  const rows: unknown[] = Array.isArray(payloadRecord?.commands) ? payloadRecord.commands : []
  return rows.flatMap((row: unknown) => {
    const record = asRecord(row)
    const label = readString(record?.label)
    const value = readString(record?.value)
    const source = readString(record?.source)
    if (!label || !value || (source !== 'package' && source !== 'script' && source !== 'make')) return []
    return [{ label, value, source }]
  })
}

export async function sendThreadTerminalInput(sessionId: string, data: string): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, data }),
  })
}

export async function resizeThreadTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/resize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cols, rows }),
  })
}

export async function closeThreadTerminal(sessionId: string): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

export async function getThreadTerminalSnapshot(threadId: string): Promise<ThreadTerminalSession | null> {
  const payload = await fetchTerminalJson(`/codex-api/thread-terminal-snapshot?threadId=${encodeURIComponent(threadId)}`)
  return normalizeThreadTerminalSession(asRecord(payload)?.session)
}

export async function replyToServerRequest(
  id: number,
  generation: number,
  payload: { result?: unknown; error?: { code?: number; message: string } },
): Promise<void> {
  await respondServerRequest({
    id,
    generation,
    ...payload,
  })
}

export async function getPendingServerRequests(): Promise<unknown[]> {
  return fetchPendingServerRequests()
}

export async function getAccountRateLimits(): Promise<UiRateLimitSnapshot | null> {
  try {
    const payload = await callRpc<unknown>('account/rateLimits/read')
    return pickCodexRateLimitSnapshot(payload)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load account rate limits', 'account/rateLimits/read')
  }
}

function normalizeAccountsListResult(payload: unknown): AccountsListResult {
  const record = asRecord(payload)
  const activeAccountId = readString(record?.activeAccountId)
  const activeStorageId = readString(record?.activeStorageId)
  const data = Array.isArray(record?.accounts) ? record?.accounts : []
  return {
    activeAccountId,
    activeStorageId,
    importedAccountId: readString(record?.importedAccountId) ?? undefined,
    importedStorageId: readString(record?.importedStorageId) ?? undefined,
    accounts: data
      .map((entry) => normalizeAccountEntry(entry, activeAccountId, activeStorageId))
      .filter((entry): entry is UiAccountEntry => entry !== null),
  }
}

export async function getAccounts(): Promise<AccountsListResult> {
  const response = await fetchWithTimeout('/codex-api/accounts')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function refreshAccountsFromAuth(): Promise<AccountsListResult> {
  const response = await fetchWithTimeout('/codex-api/accounts/refresh', {
    method: 'POST',
  }, { timeout: 'long', operation: 'accounts/refresh' })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to refresh accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function startCodexLogin(): Promise<string> {
  const response = await fetchWithTimeout('/codex-api/accounts/login/start', {
    method: 'POST',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to start Codex login'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const loginUrl = readString(data?.loginUrl)
  if (!loginUrl) {
    throw new Error('Failed to start Codex login')
  }
  return loginUrl
}

export async function completeCodexLogin(callbackUrl: string): Promise<AccountsListResult> {
  const response = await fetchWithTimeout('/codex-api/accounts/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl }),
  }, { timeout: 'long', operation: 'accounts/login/complete' })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to complete Codex login'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function switchAccount(storageId: string): Promise<UiAccountEntry> {
  const response = await fetchWithTimeout('/codex-api/accounts/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  }, { timeout: 'long', operation: 'accounts/switch' })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to switch account'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const account = normalizeAccountEntry(data?.account, readString(data?.activeAccountId), readString(data?.activeStorageId))
  if (!account) {
    throw new Error('Failed to switch account')
  }
  return account
}

export async function removeAccount(storageId: string): Promise<AccountsListResult> {
  const response = await fetchWithTimeout('/codex-api/accounts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  }, { timeout: 'long', operation: 'accounts/remove' })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to remove account'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export type ResumedThread = {
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  turnIndexByTurnId: ThreadTurnIndexById
}

const RESUME_THREAD_COALESCE_TTL_MS = 30_000
const recentResumeThreadById = new Map<string, Promise<ResumedThread>>()

export async function resumeThread(threadId: string): Promise<ResumedThread> {
  const existing = recentResumeThreadById.get(threadId)
  if (existing) return existing

  const promise = (async () => {
    const payload = await callRpc<ThreadResumeResponse>('thread/resume', { threadId })
    const startTurnIndex = readThreadTurnStartIndex(payload)
    const messages = normalizeThreadMessagesV2(payload, startTurnIndex)
    return {
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
      messages,
      inProgress: readThreadInProgressFromResponse(payload),
      activeTurnId: readActiveTurnIdFromResponse(payload),
      hasMoreOlder: startTurnIndex > 0,
      turnIndexByTurnId: buildTurnIndexByTurnId(payload, startTurnIndex),
    }
  })()

  recentResumeThreadById.set(threadId, promise)
  const hardEvictionTimer = globalThis.setTimeout(() => {
    if (recentResumeThreadById.get(threadId) === promise) {
      recentResumeThreadById.delete(threadId)
    }
  }, RESUME_THREAD_COALESCE_TTL_MS)
  void promise.finally(() => {
    globalThis.clearTimeout(hardEvictionTimer)
    globalThis.setTimeout(() => {
      if (recentResumeThreadById.get(threadId) === promise) {
        recentResumeThreadById.delete(threadId)
      }
    }, 2000)
  }).catch(() => undefined)
  return promise
}

export async function archiveThread(threadId: string): Promise<void> {
  await callRpc('thread/archive', { threadId })
}

export async function unarchiveThread(threadId: string): Promise<void> {
  try {
    await callRpc('thread/unarchive', { threadId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to restore thread ${threadId}`, 'thread/unarchive')
  }
}

export async function permanentlyDeleteThread(threadId: string): Promise<void> {
  try {
    await callRpc('thread/delete', { threadId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to permanently delete thread ${threadId}`, 'thread/delete')
  }
}

export async function renameThread(threadId: string, threadName: string): Promise<void> {
  await callRpc('thread/name/set', { threadId, name: threadName })
}

export async function rollbackThread(threadId: string, numTurns: number): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/rollback', { threadId, numTurns })
  return normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload))
}

export async function updateThreadFileChanges(
  threadId: string,
  turnId: string,
  cwd: string,
  action: 'undo' | 'redo',
  patchIds?: string[],
  scope?: 'single_turn' | 'turn_and_later',
): Promise<{ changed: number; errors: string[]; message?: string; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> {
  try {
    const response = await fetchWithTimeout('/codex-api/thread/rollback-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, turnId, cwd, action, patchIds, scope }),
    }, { timeout: 'long', operation: 'thread/rollback-files' })
    const payload = (await response.json().catch(() => ({}))) as {
      changed?: number
      reverted?: number
      applied?: number
      errors?: string[]
      message?: string
      error?: string
      revertedPatchIds?: string[]
      appliedPatchIds?: string[]
    }
    if (!response.ok) {
      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'Server error'
      return {
        changed: 0,
        errors: Array.isArray(payload.errors) && payload.errors.length > 0 ? payload.errors : [message],
        message: payload.message,
      }
    }
    return {
      changed: payload.changed ?? payload.reverted ?? payload.applied ?? 0,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
      message: payload.message,
      revertedPatchIds: Array.isArray(payload.revertedPatchIds) ? payload.revertedPatchIds : [],
      appliedPatchIds: Array.isArray(payload.appliedPatchIds) ? payload.appliedPatchIds : [],
    }
  } catch (error) {
    return { changed: 0, errors: [error instanceof Error ? error.message : 'Network error'] }
  }
}

export async function revertThreadFileChanges(threadId: string, turnId: string, cwd: string): Promise<{ reverted: number; errors: string[] }> {
  const result = await updateThreadFileChanges(threadId, turnId, cwd, 'undo')
  return { reverted: result.changed, errors: result.errors }
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

function normalizeThreadCwdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const cwd = (thread as Record<string, unknown>).cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      return cwd
    }
  }
  return ''
}

function normalizeThreadModelFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const model = (payload as Record<string, unknown>).model
  return typeof model === 'string' ? model.trim() : ''
}

function normalizeThreadModelProviderFromPayload(payload: unknown): string {
  const record = asRecord(payload)
  if (!record) return ''
  const modelProvider = readString(record.modelProvider)?.trim() ?? ''
  if (modelProvider) return modelProvider
  const thread = asRecord(record.thread)
  return readString(thread?.modelProvider)?.trim() ?? ''
}

export type StartedThread = {
  threadId: string
  model: string
  modelProvider: string
}

export type StartedThreadTurn = StartedThread & {
  turnId: string
}

export type ForkedThread = {
  threadId: string
  cwd: string
  model: string
  messages: UiMessage[]
}

function normalizeServiceTierParam(serviceTier: string | null | undefined): string | null | undefined {
  if (serviceTier === null) return null
  if (typeof serviceTier !== 'string') return undefined
  const normalized = serviceTier.trim()
  return normalized.length > 0 ? normalized : undefined
}

function buildThreadStartParams(cwd?: string, model?: string, serviceTier?: string | null): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (typeof cwd === 'string' && cwd.trim().length > 0) {
    params.cwd = cwd.trim()
  }
  if (typeof model === 'string' && model.trim().length > 0) {
    params.model = model.trim()
  }
  const normalizedServiceTier = normalizeServiceTierParam(serviceTier)
  if (normalizedServiceTier !== undefined) {
    params.serviceTier = normalizedServiceTier
  }
  return params
}

export async function startThread(cwd?: string, model?: string, serviceTier?: string | null): Promise<StartedThread> {
  try {
    const params = buildThreadStartParams(cwd, model, serviceTier)
    const payload = await callRpc<ThreadStartResponse>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return {
      threadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export async function forkThread(threadId: string): Promise<ForkedThread>
export async function forkThread(threadId: string, cwd: string | undefined, model: string | undefined): Promise<StartedThread>
export async function forkThread(
  threadId: string,
  cwd?: string,
  model?: string,
): Promise<StartedThread | ForkedThread> {
  if (arguments.length <= 1) {
    try {
      const payload = await callRpc<ThreadForkResponse & ThreadReadResponse & { thread?: { id?: string; cwd?: string } }>('thread/fork', {
        threadId,
        persistExtendedHistory: true,
      })
      const forkedThreadId = normalizeThreadIdFromPayload(payload)
      if (!forkedThreadId) {
        throw new Error('thread/fork did not return a thread id')
      }
      return {
        threadId: forkedThreadId,
        cwd: normalizeThreadCwdFromPayload(payload),
        model: normalizeThreadModelFromPayload(payload),
        messages: normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload)),
      }
    } catch (error) {
      throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
    }
  }

  try {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) {
      throw new Error('thread/fork requires threadId')
    }
    const params: Record<string, unknown> = {
      threadId: normalizedThreadId,
    }
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadForkResponse>('thread/fork', params)
    const nextThreadId = normalizeThreadIdFromPayload(payload)
    if (!nextThreadId) {
      throw new Error('thread/fork did not return a thread id')
    }
    return {
      threadId: nextThreadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
  }
}

export type FileAttachmentParam = { label: string; path: string; fsPath: string }

function extractLocalImagePathFromUrl(value: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value, 'http://localhost')
    if (parsed.pathname !== '/codex-local-image') return null
    const path = parsed.searchParams.get('path')?.trim() ?? ''
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

function buildTextWithAttachments(
  prompt: string,
  files: FileAttachmentParam[],
): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const f of files) {
    prefix += `\n## ${f.label}: ${f.path}\n`
  }
  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

function fileNameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? normalized
}

async function resolveCollaborationModeSettings(
  mode: CollaborationModeKind,
  model?: string,
  effort?: ReasoningEffort,
): Promise<ResolvedCollaborationModeSettings> {
  const explicitModel = model?.trim() ?? ''
  if (explicitModel) {
    return {
      model: explicitModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort)
        : normalizeCollaborationModeReasoningEffort(effort),
    }
  }

  let currentConfig: CurrentModelConfig | null = null
  try {
    currentConfig = await getCurrentModelConfig()
  } catch {
    currentConfig = null
  }

  const configuredModel = currentConfig?.model.trim() ?? ''
  if (configuredModel) {
    return {
      model: configuredModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  let availableModelIds: string[] = []
  try {
    availableModelIds = await getAvailableModelIds()
  } catch {
    availableModelIds = []
  }

  const fallbackModel = availableModelIds.find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  if (fallbackModel) {
    return {
      model: fallbackModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model. Wait for models to load and try again.`)
}

async function buildTurnStartParams(
  threadId: string | undefined,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  collaborationMode?: CollaborationModeKind,
  serviceTier?: string | null,
): Promise<Record<string, unknown>> {
  const normalizedModel = model?.trim() ?? ''
  const localImageAttachments: FileAttachmentParam[] = []
  for (const imageUrl of imageUrls) {
    const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
    if (!localImagePath) continue
    localImageAttachments.push({
      label: fileNameFromPath(localImagePath),
      path: localImagePath,
      fsPath: localImagePath,
    })
  }
  const allFileAttachments = [...fileAttachments, ...localImageAttachments]
  const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
    allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)
  const finalText = buildTextWithAttachments(text, dedupedFileAttachments)
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }]
  for (const imageUrl of imageUrls) {
    const normalizedUrl = imageUrl.trim()
    if (!normalizedUrl) continue
    const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
    if (localImagePath) {
      input.push({
        type: 'localImage',
        path: localImagePath,
      })
      continue
    }
    input.push({
      type: 'image',
      url: normalizedUrl,
      image_url: normalizedUrl,
    })
  }
  if (skills) {
    for (const skill of skills) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }
  }
  const attachments = dedupedFileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
  const params: Record<string, unknown> = {
    input,
  }
  if (typeof threadId === 'string' && threadId.trim().length > 0) {
    params.threadId = threadId.trim()
  }
  if (attachments.length > 0) params.attachments = attachments
  if (normalizedModel) {
    params.model = normalizedModel
  }
  if (typeof effort === 'string' && effort.length > 0) {
    params.effort = effort
  }
  const normalizedServiceTier = normalizeServiceTierParam(serviceTier)
  if (normalizedServiceTier !== undefined) {
    params.serviceTier = normalizedServiceTier
  }
  if (collaborationMode) {
    const collaborationModeSettings = await resolveCollaborationModeSettings(collaborationMode, normalizedModel, effort)
    params.collaborationMode = {
      mode: collaborationMode,
      settings: {
        model: collaborationModeSettings.model,
        reasoning_effort: collaborationModeSettings.reasoningEffort,
        developer_instructions: null,
      },
    }
  }
  return params
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  collaborationMode?: CollaborationModeKind,
  serviceTier?: string | null,
): Promise<string> {
  try {
    const params = await buildTurnStartParams(
      threadId,
      text,
      imageUrls,
      model,
      effort,
      skills,
      fileAttachments,
      collaborationMode,
      serviceTier,
    )
    const payload = await callRpc<{ turn?: Turn }>('turn/start', params)
    return typeof payload?.turn?.id === 'string' ? payload.turn.id.trim() : ''
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export async function startThreadWithTurn(
  cwd: string | undefined,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  collaborationMode?: CollaborationModeKind,
  serviceTier?: string | null,
): Promise<StartedThreadTurn> {
  try {
    const thread = buildThreadStartParams(cwd, model, serviceTier)
    const turn = await buildTurnStartParams(
      undefined,
      text,
      imageUrls,
      model,
      effort,
      skills,
      fileAttachments,
      collaborationMode,
      serviceTier,
    )
    const response = await fetchWithTimeout('/codex-api/thread/start-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread, turn }),
    }, { timeout: 'long', operation: 'thread/start-turn' })
    const payload = (await response.json().catch(() => null)) as unknown
    if (!response.ok) {
      throw new Error(getErrorMessageFromPayload(payload, `Failed to start thread turn (${response.status})`))
    }

    const data = asRecord(asRecord(payload)?.data)
    const threadId = normalizeThreadIdFromPayload(data)
    if (!threadId) {
      throw new Error('thread/start-turn did not return a thread id')
    }
    const turnRecord = asRecord(data?.turn)
    return {
      threadId,
      model: normalizeThreadModelFromPayload(data),
      modelProvider: normalizeThreadModelProviderFromPayload(data),
      turnId: typeof turnRecord?.id === 'string' ? turnRecord.id.trim() : '',
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread turn', 'thread/start-turn')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}

export async function setDefaultModel(model: string): Promise<void> {
  await callRpc('setDefaultModel', { model })
}

export async function setCodexSpeedMode(mode: SpeedMode): Promise<void> {
  const normalizedMode: SpeedMode = mode === 'fast' ? 'fast' : 'standard'
  await callRpc('config/batchWrite', {
    edits: [
      {
        keyPath: 'features.fast_mode',
        value: true,
        mergeStrategy: 'upsert',
      },
      {
        keyPath: 'service_tier',
        value: normalizedMode === 'fast' ? 'fast' : null,
        mergeStrategy: normalizedMode === 'fast' ? 'upsert' : 'replace',
      },
    ],
    filePath: null,
    expectedVersion: null,
  })
}

export interface FreeModeStatus {
  enabled: boolean
  hasCodexAuth?: boolean
  keyCount: number
  models: string[]
  currentModel: string | null
  customKey: boolean
  maskedKey: string | null
  provider?: 'openrouter' | 'custom' | 'opencode-zen'
  customBaseUrl?: string
  wireApi?: 'responses' | 'chat' | null
}

export async function getFreeModeStatus(): Promise<FreeModeStatus> {
  const response = await fetchWithTimeout('/codex-api/free-mode/status')
  return await response.json() as FreeModeStatus
}

export async function setFreeMode(enable: boolean): Promise<{ ok: boolean; enabled: boolean; model?: string; models?: string[] }> {
  const response = await fetchWithTimeout('/codex-api/free-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enable }),
  })
  return await response.json() as { ok: boolean; enabled: boolean; model?: string; models?: string[] }
}

export async function setFreeModeCustomKey(key: string): Promise<{ ok: boolean; customKey: boolean }> {
  const response = await fetchWithTimeout('/codex-api/free-mode/custom-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  return await response.json() as { ok: boolean; customKey: boolean }
}

export async function setCustomProvider(
  baseUrl: string,
  apiKey: string,
  options?: { wireApi?: 'responses' | 'chat'; provider?: 'custom' | 'opencode-zen' | 'openrouter' },
): Promise<{ ok: boolean }> {
  const response = await fetchWithTimeout('/codex-api/free-mode/custom-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      wireApi: options?.wireApi,
      provider: options?.provider,
    }),
  })
  return await response.json() as { ok: boolean }
}

async function fetchProviderModelIds(providerId?: string): Promise<{ ids: string[], exclusive: boolean } | null> {
  try {
    const normalizedProviderId = providerId?.trim() ?? ''
    const url = normalizedProviderId
      ? `/codex-api/provider-models?provider=${encodeURIComponent(normalizedProviderId)}`
      : '/codex-api/provider-models'
    const response = await fetchWithTimeout(url, undefined, {
      timeout: PROVIDER_MODELS_FETCH_TIMEOUT_MS,
      operation: 'provider-models',
    })
    let providerPayload: ProviderModelsResponse | null = null
    try {
      providerPayload = await response.json() as ProviderModelsResponse
    } catch {
      providerPayload = null
    }

    if (response.ok && Array.isArray(providerPayload?.data)) {
      return {
        ids: providerPayload.data
          .map((candidate) => typeof candidate === 'string' ? candidate.trim() : '')
          .filter((candidate, index, candidates): candidate is string =>
            candidate.length > 0 && candidates.indexOf(candidate) === index),
        exclusive: providerPayload.exclusive === true,
      }
    }
  } catch {
    // Keep Codex usable when the provider-models endpoint is unavailable.
  }
  return null
}

function providerModelCapability(id: string): UiModelCapability {
  return {
    id,
    displayName: id,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    supportsFastMode: false,
  }
}

function normalizeModelCapability(value: unknown): UiModelCapability | null {
  const row = asRecord(value)
  if (!row) return null
  const id = readString(row.id) || readString(row.model)
  if (!id) return null

  const supportedReasoningEfforts = Array.isArray(row.supportedReasoningEfforts)
    ? row.supportedReasoningEfforts.flatMap((option) => {
        const optionRecord = asRecord(option)
        const effort = normalizeReasoningEffort(optionRecord?.reasoningEffort ?? option)
        return effort ? [effort] : []
      })
    : []
  const defaultReasoningEffort = normalizeReasoningEffort(row.defaultReasoningEffort) || null
  const serviceTiers = Array.isArray(row.serviceTiers)
    ? row.serviceTiers.flatMap((value) => {
        const serviceTier = asRecord(value)
        const id = readString(serviceTier?.id)
        const name = readString(serviceTier?.name)
        if (!id && !name) return []
        return [{
          id: id ?? '',
          name: name ?? '',
        }]
      })
    : []
  const fastServiceTier = serviceTiers.find((tier) => (
    tier.id.toLowerCase() === 'fast' || tier.name.toLowerCase() === 'fast'
  ))
  const additionalSpeedTiers = readStringArray(row.additionalSpeedTiers)
  const supportsFastMode = Boolean(
    fastServiceTier || additionalSpeedTiers.some((tier) => tier.toLowerCase() === 'fast'),
  )

  return {
    id,
    displayName: readString(row.displayName) || id,
    supportedReasoningEfforts: Array.from(new Set(supportedReasoningEfforts)),
    defaultReasoningEffort,
    supportsFastMode,
  }
}

async function fetchCodexModelCapabilities(): Promise<UiModelCapability[]> {
  const payload = await callRpc<unknown>('model/list', {})
  const payloadRecord = asRecord(payload)
  const rows = Array.isArray(payloadRecord?.data) ? payloadRecord.data : []
  const models: UiModelCapability[] = []
  for (const row of rows) {
    const model = normalizeModelCapability(row)
    if (!model || models.some((candidate) => candidate.id === model.id)) continue
    models.push(model)
  }
  return models
}

export async function getAvailableModels(options: { includeProviderModels?: boolean; requireProviderModels?: boolean; providerId?: string } = {}): Promise<UiModelCapability[]> {
  const shouldIncludeProviderModels = options.includeProviderModels !== false
  const providerModels = shouldIncludeProviderModels ? await fetchProviderModelIds(options.providerId) : null
  const restrictToProviderModels = providerModels?.exclusive === true || options.requireProviderModels === true

  if (restrictToProviderModels && !providerModels) return []

  let codexModels: UiModelCapability[]
  try {
    codexModels = await fetchCodexModelCapabilities()
  } catch (error) {
    if (!restrictToProviderModels || !providerModels) throw error
    return providerModels.ids.map(providerModelCapability)
  }

  if (restrictToProviderModels && providerModels) {
    const codexModelById = new Map(codexModels.map((model) => [model.id, model]))
    return providerModels.ids.map((id) => codexModelById.get(id) ?? providerModelCapability(id))
  }

  if (!shouldIncludeProviderModels || !providerModels) return codexModels

  for (const candidate of providerModels.ids) {
    if (!codexModels.some((model) => model.id === candidate)) codexModels.push(providerModelCapability(candidate))
  }
  return codexModels
}

export async function getAvailableModelIds(options: { includeProviderModels?: boolean; requireProviderModels?: boolean; providerId?: string } = {}): Promise<string[]> {
  return (await getAvailableModels(options)).map((model) => model.id)
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const providerId = typeof payload.config.model_provider === 'string' ? payload.config.model_provider : ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  const speedMode = normalizeSpeedMode(payload.config.service_tier)
  return { model, providerId, reasoningEffort, speedMode }
}

function normalizeThreadModelPreference(value: unknown): ThreadModelPreference | null {
  const record = asRecord(value)
  const model = readString(record?.model)
  const reasoningEffort = normalizeReasoningEffort(record?.reasoningEffort)
  return model && reasoningEffort ? { model, reasoningEffort } : null
}

export async function getThreadModelPreferences(): Promise<ThreadModelPreferenceState> {
  const response = await fetchWithTimeout('/codex-api/thread-model-preferences')
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, `Failed to load thread model preferences (${response.status})`))
  }

  const data = asRecord(asRecord(payload)?.data)
  const state: ThreadModelPreferenceState = {}
  for (const [rawThreadId, rawPreference] of Object.entries(data ?? {})) {
    const threadId = rawThreadId.trim()
    const preference = normalizeThreadModelPreference(rawPreference)
    if (threadId && preference) state[threadId] = preference
  }
  return state
}

export async function persistThreadModelPreference(
  threadId: string,
  preference: ThreadModelPreference,
): Promise<ThreadModelPreference> {
  const response = await fetchWithTimeout('/codex-api/thread-model-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, ...preference }),
  })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, `Failed to save thread model preference (${response.status})`))
  }
  const saved = normalizeThreadModelPreference(asRecord(payload)?.data)
  if (!saved) throw new Error('Thread model preference response was invalid')
  return saved
}

function normalizeDirectoryPluginApp(value: unknown): DirectoryPluginAppSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  return {
    id,
    name,
    description: readString(record.description) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    needsAuth: readBoolean(record.needsAuth ?? record.needs_auth) ?? false,
  }
}

function normalizeDirectoryPluginSkill(value: unknown): DirectoryPluginSkillSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const name = readString(record.name)
  const path = readString(record.path)
  if (!name || !path) return null
  const iface = asRecord(record.interface)
  return {
    name,
    path,
    description: readString(record.description) ?? '',
    enabled: readBoolean(record.enabled) ?? true,
    displayName: readString(iface?.displayName ?? iface?.display_name) ?? name,
    shortDescription: readString(record.shortDescription ?? record.short_description) ?? '',
  }
}

function normalizeDirectoryPluginSummary(
  value: unknown,
  marketplace: { name?: string; displayName?: string; path?: string | null } = {},
): DirectoryPluginSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const iface = asRecord(record.interface)
  const source = asRecord(record.source)
  const sourceType = readString(source?.type) ?? ''
  const sourcePath = readString(source?.path)
  const sourceUrl = readString(source?.url) ?? ''
  const remoteMarketplaceName = sourceType === 'remote' ? marketplace.name ?? null : null
  const marketplacePath = marketplace.path ?? (sourceType === 'local' ? sourcePath : null)
  const displayName = readString(iface?.displayName ?? iface?.display_name) ?? name
  const shortDescription = readString(iface?.shortDescription ?? iface?.short_description)
  const longDescription = readString(iface?.longDescription ?? iface?.long_description) ?? ''

  return {
    id,
    name,
    displayName,
    description: shortDescription ?? longDescription,
    longDescription,
    developerName: readString(iface?.developerName ?? iface?.developer_name) ?? '',
    category: readString(iface?.category) ?? '',
    marketplaceName: marketplace.name ?? '',
    marketplaceDisplayName: marketplace.displayName ?? marketplace.name ?? '',
    marketplacePath,
    remoteMarketplaceName,
    sourceType,
    sourceUrl,
    installed: readBoolean(record.installed) ?? false,
    enabled: readBoolean(record.enabled) ?? true,
    installPolicy: readString(record.installPolicy ?? record.install_policy) ?? '',
    authPolicy: readString(record.authPolicy ?? record.auth_policy) ?? '',
    logoUrl: readString(iface?.logoUrl ?? iface?.logo_url) ?? '',
    logoPath: readString(iface?.logo) ?? '',
    composerIconUrl: readString(iface?.composerIconUrl ?? iface?.composer_icon_url) ?? '',
    composerIconPath: readString(iface?.composerIcon ?? iface?.composer_icon) ?? '',
    brandColor: readString(iface?.brandColor ?? iface?.brand_color) ?? '',
    capabilities: readStringArray(iface?.capabilities),
    defaultPrompt: readStringArray(iface?.defaultPrompt ?? iface?.default_prompt),
    screenshotUrls: readStringArray(iface?.screenshotUrls ?? iface?.screenshot_urls),
    screenshots: readStringArray(iface?.screenshots),
    websiteUrl: readString(iface?.websiteUrl ?? iface?.website_url) ?? '',
    privacyPolicyUrl: readString(iface?.privacyPolicyUrl ?? iface?.privacy_policy_url) ?? '',
    termsOfServiceUrl: readString(iface?.termsOfServiceUrl ?? iface?.terms_of_service_url) ?? '',
  }
}

function normalizeDirectoryApp(value: unknown, catalogRank = 0): DirectoryAppInfo | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const branding = asRecord(record.branding)
  const metadata = asRecord(record.appMetadata ?? record.app_metadata)
  return {
    id,
    name,
    description: readString(record.description) ?? readString(metadata?.seoDescription ?? metadata?.seo_description) ?? '',
    logoUrl: readString(record.logoUrl ?? record.logo_url) ?? '',
    logoUrlDark: readString(record.logoUrlDark ?? record.logo_url_dark) ?? '',
    distributionChannel: readString(record.distributionChannel ?? record.distribution_channel) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    isAccessible: readBoolean(record.isAccessible ?? record.is_accessible) ?? false,
    isEnabled: readBoolean(record.isEnabled ?? record.is_enabled) ?? true,
    pluginDisplayNames: readStringArray(record.pluginDisplayNames ?? record.plugin_display_names),
    category: readString(branding?.category) ?? '',
    developer: readString(branding?.developer) ?? readString(metadata?.developer) ?? '',
    website: readString(branding?.website) ?? '',
    privacyPolicy: readString(branding?.privacyPolicy ?? branding?.privacy_policy) ?? '',
    termsOfService: readString(branding?.termsOfService ?? branding?.terms_of_service) ?? '',
    catalogRank,
  }
}

function normalizeDirectoryMcpServer(value: unknown): DirectoryMcpServerStatus | null {
  const record = asRecord(value)
  if (!record) return null
  const name = readString(record.name)
  if (!name) return null
  const toolsRecord = asRecord(record.tools) ?? {}
  const tools = Object.entries(toolsRecord).map(([fallbackName, raw]) => {
    const tool = asRecord(raw)
    return {
      name: readString(tool?.name) ?? fallbackName,
      title: readString(tool?.title) ?? '',
      description: readString(tool?.description) ?? '',
    }
  })
  const resources = Array.isArray(record.resources)
    ? record.resources.map((raw) => {
      const resource = asRecord(raw)
      return {
        name: readString(resource?.name) ?? '',
        title: readString(resource?.title) ?? '',
        uri: readString(resource?.uri) ?? '',
        description: readString(resource?.description) ?? '',
      }
    }).filter((resource) => resource.name || resource.uri)
    : []
  const rawResourceTemplates = record.resourceTemplates ?? record.resource_templates
  const resourceTemplates = Array.isArray(rawResourceTemplates)
    ? rawResourceTemplates.map((raw: unknown) => {
      const template = asRecord(raw)
      return {
        name: readString(template?.name) ?? '',
        title: readString(template?.title) ?? '',
        uriTemplate: readString(template?.uriTemplate ?? template?.uri_template) ?? '',
        description: readString(template?.description) ?? '',
      }
    }).filter((template) => template.name || template.uriTemplate)
    : []

  return {
    name,
    authStatus: readString(record.authStatus ?? record.auth_status) ?? 'unsupported',
    tools,
    resources,
    resourceTemplates,
  }
}

export async function listDirectoryPlugins(cwds?: string[]): Promise<DirectoryPluginSummary[]> {
  const params: Record<string, unknown> = {}
  if (cwds && cwds.length > 0) params.cwds = cwds
  const payload = await callRpc<{ marketplaces?: unknown[] }>('plugin/list', params)
  const plugins: DirectoryPluginSummary[] = []
  for (const marketplaceValue of payload.marketplaces ?? []) {
    const marketplace = asRecord(marketplaceValue)
    if (!marketplace) continue
    const iface = asRecord(marketplace.interface)
    const meta = {
      name: readString(marketplace.name) ?? '',
      displayName: readString(iface?.displayName ?? iface?.display_name) ?? '',
      path: readString(marketplace.path),
    }
    const rows = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
    for (const row of rows) {
      const plugin = normalizeDirectoryPluginSummary(row, meta)
      if (plugin) plugins.push(plugin)
    }
  }
  return plugins
}

export async function readDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginDetail> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ plugin?: unknown }>('plugin/read', params)
  const detailRecord = asRecord(payload.plugin)
  if (!detailRecord) throw new Error('Plugin detail response is empty')
  const summary = normalizeDirectoryPluginSummary(detailRecord.summary, {
    name: readString(detailRecord.marketplaceName) ?? plugin.marketplaceName,
    displayName: plugin.marketplaceDisplayName,
    path: readString(detailRecord.marketplacePath) ?? plugin.marketplacePath,
  }) ?? plugin
  return {
    summary,
    description: readString(detailRecord.description) ?? summary.longDescription,
    apps: Array.isArray(detailRecord.apps)
      ? detailRecord.apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null)
      : [],
    skills: Array.isArray(detailRecord.skills)
      ? detailRecord.skills.map(normalizeDirectoryPluginSkill).filter((row): row is DirectoryPluginSkillSummary => row !== null)
      : [],
    mcpServers: readStringArray(detailRecord.mcpServers ?? detailRecord.mcp_servers),
  }
}

export async function installDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginInstallResult> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ authPolicy?: string; auth_policy?: string; appsNeedingAuth?: unknown[]; apps_needing_auth?: unknown[] }>('plugin/install', params)
  const apps = payload.appsNeedingAuth ?? payload.apps_needing_auth ?? []
  return {
    authPolicy: readString(payload.authPolicy ?? payload.auth_policy) ?? '',
    appsNeedingAuth: apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null),
  }
}

export async function uninstallDirectoryPlugin(pluginId: string): Promise<void> {
  await callRpc('plugin/uninstall', { pluginId })
}

export async function setDirectoryPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `plugins.${pluginId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryApps(threadId?: string): Promise<DirectoryAppInfo[]> {
  const apps: DirectoryAppInfo[] = []
  let cursor: string | null = null
  let catalogRank = 0
  do {
    const params: Record<string, unknown> = { limit: 100 }
    if (cursor) params.cursor = cursor
    if (threadId) params.threadId = threadId
    const payload = await callRpc<{ data?: unknown[]; nextCursor?: string | null; next_cursor?: string | null }>('app/list', params)
    for (const item of payload.data ?? []) {
      const app = normalizeDirectoryApp(item, catalogRank)
      if (app) apps.push(app)
      catalogRank += 1
    }
    cursor = readString(payload.nextCursor ?? payload.next_cursor)
  } while (cursor)
  return apps
}

export async function setDirectoryAppEnabled(appId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `apps.${appId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryMcpServers(): Promise<DirectoryMcpServerStatus[]> {
  const servers: DirectoryMcpServerStatus[] = []
  let cursor: string | null = null
  do {
    const params: Record<string, unknown> = {}
    if (cursor) params.cursor = cursor
    const payload = await callRpc<{ data?: unknown[]; nextCursor?: string | null; next_cursor?: string | null }>('mcpServerStatus/list', params)
    for (const item of payload.data ?? []) {
      const server = normalizeDirectoryMcpServer(item)
      if (server) servers.push(server)
    }
    cursor = readString(payload.nextCursor ?? payload.next_cursor)
  } while (cursor)
  return servers
}

export async function reloadDirectoryMcpServers(): Promise<void> {
  await callRpc('config/mcpServer/reload', {})
}

export async function startDirectoryMcpLogin(name: string): Promise<DirectoryMcpLoginResult> {
  const payload = await callRpc<{ authorizationUrl?: string; authorization_url?: string }>('mcpServer/oauth/login', { name })
  return {
    authorizationUrl: readString(payload.authorizationUrl ?? payload.authorization_url) ?? '',
  }
}

export async function getDirectoryComposioStatus(): Promise<DirectoryComposioStatus> {
  const response = await fetchWithTimeout('/codex-api/composio/status')
  if (!response.ok) {
    throw new Error(`Failed to load Composio status (${response.status})`)
  }
  return await response.json() as DirectoryComposioStatus
}

export async function listDirectoryComposioConnectors(
  query = '',
  cursor: string | null = null,
  limit = 50,
): Promise<DirectoryComposioConnectorPage> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('query', query.trim())
  if (cursor) params.set('cursor', cursor)
  if (limit && Number.isFinite(limit)) params.set('limit', String(Math.max(1, Math.floor(limit))))
  const suffix = params.toString()
  const response = await fetchWithTimeout(`/codex-api/composio/connectors${suffix ? `?${suffix}` : ''}`)
  if (!response.ok) {
    throw new Error(`Failed to list Composio connectors (${response.status})`)
  }
  const payload = await response.json() as DirectoryComposioConnectorPage | { data?: DirectoryComposioConnector[]; nextCursor?: string | null; total?: number }
  return {
    data: Array.isArray(payload.data) ? payload.data : [],
    nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0 ? payload.nextCursor : null,
    total: typeof payload.total === 'number' && Number.isFinite(payload.total) ? Math.max(0, Math.floor(payload.total)) : 0,
  }
}

export async function readDirectoryComposioConnector(slug: string): Promise<DirectoryComposioConnectorDetail> {
  const response = await fetchWithTimeout(`/codex-api/composio/connector?slug=${encodeURIComponent(slug)}`)
  if (!response.ok) {
    throw new Error(`Failed to load Composio connector (${response.status})`)
  }
  return await response.json() as DirectoryComposioConnectorDetail
}

export async function startDirectoryComposioLogin(slug: string): Promise<DirectoryComposioLinkResult> {
  const response = await fetchWithTimeout('/codex-api/composio/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  }, { timeout: 'long', operation: 'composio/link' })
  if (!response.ok) {
    throw new Error(`Failed to start Composio login (${response.status})`)
  }
  return await response.json() as DirectoryComposioLinkResult
}

export async function startDirectoryComposioCliLogin(): Promise<DirectoryComposioLoginResult> {
  const response = await fetchWithTimeout('/codex-api/composio/login', {
    method: 'POST',
  }, { timeout: 'long', operation: 'composio/login' })
  if (!response.ok) {
    throw new Error(`Failed to start Composio CLI login (${response.status})`)
  }
  return await response.json() as DirectoryComposioLoginResult
}

export async function installDirectoryComposioCli(): Promise<DirectoryComposioInstallResult> {
  const response = await fetchWithTimeout('/codex-api/composio/install', {
    method: 'POST',
  }, { timeout: 'long', operation: 'composio/install' })
  if (!response.ok) {
    throw new Error(`Failed to install Composio CLI (${response.status})`)
  }
  return await response.json() as DirectoryComposioInstallResult
}

export async function getAccountRateLimitsResponse(): Promise<GetAccountRateLimitsResponse> {
  return await callRpc<GetAccountRateLimitsResponse>('account/rateLimits/read')
}

function normalizeCollaborationModeLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (segment) => segment.toUpperCase())
}

export async function getAvailableCollaborationModes(): Promise<CollaborationModeOption[]> {
  try {
    const payload = await callRpc<CollaborationModeListResponse>('collaborationMode/list', {})
    const seen = new Set<CollaborationModeKind>()
    const normalized: CollaborationModeOption[] = []

    for (const row of payload.data) {
      const mode = row.mode
      if (mode !== 'default' && mode !== 'plan') continue
      if (seen.has(mode)) continue
      seen.add(mode)
      normalized.push({
        value: mode,
        label: normalizeCollaborationModeLabel(row.name || mode) || (mode === 'plan' ? 'Plan' : 'Default'),
      })
    }

    if (normalized.length > 0) {
      for (const fallback of DEFAULT_COLLABORATION_MODE_OPTIONS) {
        if (!seen.has(fallback.value)) {
          normalized.push(fallback)
        }
      }
      return normalized.sort((first, second) => (
        first.value === second.value ? 0 : first.value === 'default' ? -1 : 1
      ))
    }
  } catch {
    // Fall back to static options when the app-server does not expose presets.
  }

  return DEFAULT_COLLABORATION_MODE_OPTIONS
}

function normalizeStoredQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null

  const imageUrls = Array.isArray(record.imageUrls)
    ? record.imageUrls.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const skills = Array.isArray(record.skills)
    ? record.skills.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const itemRecord = item as Record<string, unknown>
      const name = typeof itemRecord.name === 'string' ? itemRecord.name.trim() : ''
      const path = typeof itemRecord.path === 'string' ? itemRecord.path.trim() : ''
      return name && path ? [{ name, path }] : []
    })
    : []
  const fileAttachments = Array.isArray(record.fileAttachments)
    ? record.fileAttachments.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const itemRecord = item as Record<string, unknown>
      const label = typeof itemRecord.label === 'string' ? itemRecord.label.trim() : ''
      const path = typeof itemRecord.path === 'string' ? itemRecord.path.trim() : ''
      const fsPath = typeof itemRecord.fsPath === 'string' ? itemRecord.fsPath.trim() : ''
      return label && path && fsPath ? [{ label, path, fsPath }] : []
    })
    : []

  const speedMode: SpeedMode | undefined = record.speedMode === 'fast'
    ? 'fast'
    : record.speedMode === 'standard'
      ? 'standard'
      : undefined
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort)

  return {
    id,
    text: typeof record.text === 'string' ? record.text : '',
    imageUrls,
    skills,
    fileAttachments,
    collaborationMode: record.collaborationMode === 'plan' ? 'plan' : 'default',
    ...(speedMode ? { speedMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

function normalizeThreadQueueState(value: unknown): ThreadQueueState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const state: ThreadQueueState = {}
  for (const [threadId, rawMessages] of Object.entries(value as Record<string, unknown>)) {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !Array.isArray(rawMessages)) continue
    const messages = rawMessages.flatMap((item) => {
      const message = normalizeStoredQueuedMessage(item)
      return message ? [message] : []
    })
    if (messages.length > 0) {
      state[normalizedThreadId] = messages
    }
  }
  return state
}

export async function getThreadQueueState(): Promise<ThreadQueueState> {
  const response = await fetchWithTimeout('/codex-api/thread-queue-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load thread queue state')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeThreadQueueState(envelope.data)
}

export async function setThreadQueueState(nextState: ThreadQueueState): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/thread-queue-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeThreadQueueState(nextState)),
  })
  if (!response.ok) {
    throw new Error('Failed to save thread queue state')
  }
}

export async function createWorktree(sourceCwd: string, baseBranch?: string): Promise<WorktreeCreateResult> {
  const normalizedBaseBranch = (baseBranch ?? '').trim()
  const response = await fetchWithTimeout('/codex-api/worktree/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      baseBranch: normalizedBaseBranch || undefined,
    }),
  }, { timeout: 'long', operation: 'worktree/create' })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function createPermanentWorktree(sourceCwd: string, worktreeName: string): Promise<WorktreeCreateResult> {
  const response = await fetchWithTimeout('/codex-api/worktree/create-permanent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      worktreeName,
    }),
  }, { timeout: 'long', operation: 'worktree/create-permanent' })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function getWorktreeBranchOptions(sourceCwd: string): Promise<WorktreeBranchOption[]> {
  const normalizedSourceCwd = sourceCwd.trim()
  if (!normalizedSourceCwd) return []
  const query = new URLSearchParams({ sourceCwd: normalizedSourceCwd })
  const response = await fetchWithTimeout(`/codex-api/worktree/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branches')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const value = typeof record.value === 'string' ? record.value.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
    })
  }
  return options
}

export async function getGitBranchState(cwd: string): Promise<GitBranchState> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { currentBranch: null, headSha: null, headSubject: null, headDate: null, detached: false, dirty: false, gitRoot: '', options: [] }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetchWithTimeout(`/codex-api/git/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Git branch state')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  const currentBranchRaw = record.currentBranch
  const currentBranch = typeof currentBranchRaw === 'string' && currentBranchRaw.trim()
    ? currentBranchRaw.trim()
    : null
  const rawList = Array.isArray(record.options) ? record.options : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const option = item as Record<string, unknown>
    const value = typeof option.value === 'string' ? option.value.trim() : ''
    const label = typeof option.label === 'string' ? option.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
      isCurrent: option.isCurrent === true,
      isRemote: option.isRemote === true,
    })
  }
  if (currentBranch && !seen.has(currentBranch)) {
    options.unshift({ value: currentBranch, label: currentBranch, isCurrent: true })
  }
  const headShaRaw = record.headSha
  const headSubjectRaw = record.headSubject
  const headDateRaw = record.headDate
  const gitRootRaw = record.gitRoot
  return {
    currentBranch,
    headSha: typeof headShaRaw === 'string' && headShaRaw.trim() ? headShaRaw.trim() : null,
    headSubject: typeof headSubjectRaw === 'string' && headSubjectRaw.trim() ? headSubjectRaw.trim() : null,
    headDate: typeof headDateRaw === 'string' && headDateRaw.trim() ? headDateRaw.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof gitRootRaw === 'string' ? normalizePathForUi(gitRootRaw) : '',
    options,
  }
}

export async function getGitRepositoryStatus(cwd: string): Promise<GitRepositoryStatus> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { isGitRepo: false, gitRoot: '' }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetchWithTimeout(`/codex-api/git/repository-status?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to read Git repository status')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    isGitRepo: record.isGitRepo === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
  }
}

export async function checkoutGitBranch(cwd: string, branch: string): Promise<string | null> {
  const response = await fetchWithTimeout('/codex-api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
    }),
  }, { timeout: 'long', operation: 'git/checkout' })
  const payload = (await response.json()) as { data?: { currentBranch?: string | null }; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to switch branch')
  }
  const branchName = payload.data?.currentBranch
  return typeof branchName === 'string' && branchName.trim() ? branchName.trim() : null
}

export async function getGitBranchCommits(cwd: string, branch: string, options: { includeResetHistory?: boolean } = {}): Promise<GitCommitOption[]> {
  const normalizedCwd = cwd.trim()
  const normalizedBranch = branch.trim()
  if (!normalizedCwd || !normalizedBranch) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    branch: normalizedBranch,
    includeResetHistory: options.includeResetHistory === false ? 'false' : 'true',
  })
  const response = await fetchWithTimeout(`/codex-api/git/branch-commits?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branch commits')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const sha = typeof record.sha === 'string' ? record.sha.trim() : ''
    const shortSha = typeof record.shortSha === 'string' ? record.shortSha.trim() : ''
    const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
    const date = typeof record.date === 'string' ? record.date.trim() : ''
    if (!sha || !shortSha) return []
    return [{ sha, shortSha, subject: subject || shortSha, date }]
  })
}

export async function getGitCommitFiles(cwd: string, sha: string): Promise<GitCommitFileChange[]> {
  const normalizedCwd = cwd.trim()
  const normalizedSha = sha.trim()
  if (!normalizedCwd || !normalizedSha) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    sha: normalizedSha,
  })
  const response = await fetchWithTimeout(`/codex-api/git/commit-files?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load commit files')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const previousPath = typeof record.previousPath === 'string' && record.previousPath.length > 0 ? record.previousPath : null
    const status = typeof record.status === 'string' ? record.status.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const addedLineCount = typeof record.addedLineCount === 'number' && Number.isFinite(record.addedLineCount) ? record.addedLineCount : null
    const removedLineCount = typeof record.removedLineCount === 'number' && Number.isFinite(record.removedLineCount) ? record.removedLineCount : null
    if (!path || !status) return []
    return [{ path, previousPath, status, label: label || status, addedLineCount, removedLineCount }]
  })
}

export async function resetGitBranchToCommit(cwd: string, branch: string, sha: string): Promise<GitBranchState> {
  const response = await fetchWithTimeout('/codex-api/git/reset-to-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
      sha: sha.trim(),
    }),
  }, { timeout: 'long', operation: 'git/reset-to-commit' })
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to reset branch to commit')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    currentBranch: typeof record.currentBranch === 'string' && record.currentBranch.trim() ? record.currentBranch.trim() : null,
    headSha: typeof record.headSha === 'string' && record.headSha.trim() ? record.headSha.trim() : null,
    headSubject: typeof record.headSubject === 'string' && record.headSubject.trim() ? record.headSubject.trim() : null,
    headDate: typeof record.headDate === 'string' && record.headDate.trim() ? record.headDate.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
    options: [],
  }
}

export async function getReviewSnapshot(
  cwd: string,
  scope: UiReviewScope,
  workspaceView: UiReviewWorkspaceView,
  baseBranch?: string | null,
  commitSha?: string | null,
): Promise<UiReviewSnapshot> {
  const query = new URLSearchParams({ cwd, scope, workspaceView })
  if (baseBranch && baseBranch.trim()) {
    query.set('baseBranch', baseBranch.trim())
  }
  if (commitSha && commitSha.trim()) {
    query.set('commitSha', commitSha.trim())
  }
  const response = await fetchWithTimeout(`/codex-api/review/snapshot?${query.toString()}`, undefined, {
    timeout: 'long',
    operation: 'review/snapshot',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load review snapshot'))
  }
  return normalizeReviewSnapshot(payload)
}

export async function getReviewSummary(
  cwd: string,
  workspaceView: UiReviewWorkspaceView,
): Promise<UiReviewSummary> {
  const query = new URLSearchParams({ cwd, workspaceView })
  const response = await fetchWithTimeout(`/codex-api/review/summary?${query.toString()}`, undefined, {
    timeout: 'long',
    operation: 'review/summary',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load review summary'))
  }
  return normalizeReviewSummary(payload)
}

export async function applyReviewAction(payload: {
  cwd: string
  scope: UiReviewScope
  workspaceView: UiReviewWorkspaceView
  action: UiReviewAction
  level: UiReviewActionLevel
  path?: string
  previousPath?: string | null
  patch?: string
}): Promise<UiReviewSnapshot> {
  const response = await fetchWithTimeout('/codex-api/review/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { timeout: 'long', operation: 'review/action' })
  const data = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(data, 'Failed to apply review action'))
  }
  return normalizeReviewSnapshot(data)
}

export async function initializeReviewGit(cwd: string): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/review/git/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  }, { timeout: 'long', operation: 'review/git/init' })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to initialize Git'))
  }
}

export async function startThreadReview(
  threadId: string,
  scope: UiReviewScope,
  workspaceView: UiReviewWorkspaceView,
  baseBranch?: string | null,
): Promise<void> {
  const target = scope === 'baseBranch'
    ? { type: 'baseBranch' as const, branch: (baseBranch ?? '').trim() }
    : { type: 'uncommittedChanges' as const }
  if (target.type === 'baseBranch' && !target.branch) {
    throw new Error('Base branch is unavailable')
  }
  await callRpc('review/start', {
    threadId,
    target,
    delivery: 'inline',
  })
}

export async function configureTelegramBot(
  botToken: string,
  allowedUserIds: Array<number | '*'>,
): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/telegram/configure-bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      botToken,
      allowedUserIds,
    }),
  })
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to connect Telegram bot')
    throw new Error(message)
  }
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const response = await fetchWithTimeout('/codex-api/telegram/config')
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to load Telegram configuration')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const rawAllowedUserIds = Array.isArray(data.allowedUserIds) ? data.allowedUserIds : []
  const allowedUserIds: Array<number | '*'> = []
  for (const value of rawAllowedUserIds) {
    if (value === '*') {
      allowedUserIds.push('*')
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowedUserIds.push(Math.trunc(value))
    }
  }
  return {
    botToken: typeof data.botToken === 'string' ? data.botToken : '',
    allowedUserIds,
  }
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const response = await fetchWithTimeout('/codex-api/telegram/status')
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to load Telegram status')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return {
    configured: data.configured === true,
    active: data.active === true,
    mappedChats: typeof data.mappedChats === 'number' ? data.mappedChats : 0,
    mappedThreads: typeof data.mappedThreads === 'number' ? data.mappedThreads : 0,
    allowedUsers: typeof data.allowedUsers === 'number' ? data.allowedUsers : 0,
    allowAllUsers: data.allowAllUsers === true,
    lastError: typeof data.lastError === 'string' ? data.lastError : '',
  }
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const message = record.message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message
  }
  const error = record.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
export type ThreadPinnedState = { threadIds: string[] }
export type FirstLaunchPluginsCardPreference = { dismissed: boolean }

export async function getThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const response = await fetchWithTimeout('/codex-api/thread-titles')
    if (!response.ok) return { titles: {}, order: [] }
    const envelope = (await response.json()) as { data?: ThreadTitleCache }
    return envelope.data ?? { titles: {}, order: [] }
  } catch {
    return { titles: {}, order: [] }
  }
}

export async function persistThreadTitle(id: string, title: string): Promise<void> {
  try {
    await fetchWithTimeout('/codex-api/thread-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function getPinnedThreadState(): Promise<ThreadPinnedState> {
  const response = await fetchWithTimeout('/codex-api/thread-pins')
  const payload = await response.json().catch(() => null) as { data?: ThreadPinnedState } | null
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load pinned chats'))
  }
  return payload?.data ?? { threadIds: [] }
}

export async function persistPinnedThreadIds(threadIds: string[]): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/thread-pins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadIds }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to update pinned chats'))
  }
}

export async function getFirstLaunchPluginsCardPreference(): Promise<FirstLaunchPluginsCardPreference> {
  try {
    const response = await fetchWithTimeout('/codex-api/preferences/first-launch-plugins-card')
    if (!response.ok) return { dismissed: false }
    const envelope = (await response.json()) as { data?: FirstLaunchPluginsCardPreference }
    return { dismissed: envelope.data?.dismissed === true }
  } catch {
    return { dismissed: false }
  }
}

export async function persistFirstLaunchPluginsCardPreference(dismissed: boolean): Promise<void> {
  try {
    await fetchWithTimeout('/codex-api/preferences/first-launch-plugins-card', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function generateThreadTitle(prompt: string, cwd: string | null): Promise<string> {
  try {
    const result = await callRpc<{ title?: string }>('generate-thread-title', { prompt, cwd })
    return result.title?.trim() ?? ''
  } catch {
    return ''
  }
}

export type SkillInfo = {
  name: string
  displayName?: string
  description: string
  path: string
  scope: string
  enabled: boolean
}

function normalizeSkillMarkdownPath(skillPath: string): string {
  if (!skillPath) return ''
  return skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
}

function deriveGroupedSkillRoot(
  skillPath: string,
  knownPaths: Set<string>,
): { rootPath: string; rootName: string; isNested: boolean } | null {
  const normalizedPath = normalizeSkillMarkdownPath(skillPath)
  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const pluginSkillsIndex = parts.lastIndexOf('skills')
  if (pluginSkillsIndex >= 2) {
    const pluginName = parts[pluginSkillsIndex - 2] ?? ''
    if (pluginName) {
      const pluginRootPath = `/${[...parts.slice(0, pluginSkillsIndex + 1), pluginName, 'SKILL.md'].join('/')}`
      if (knownPaths.has(pluginRootPath)) {
        return { rootPath: pluginRootPath, rootName: pluginName, isNested: pluginRootPath !== normalizedPath }
      }
    }
  }

  const firstSkillsIndex = parts.indexOf('skills')
  if (firstSkillsIndex < 0 || firstSkillsIndex + 1 >= parts.length - 1) return null
  const rootName = parts[firstSkillsIndex + 1] ?? ''
  if (!rootName) return null
  const rootPath = `/${[...parts.slice(0, firstSkillsIndex + 2), 'SKILL.md'].join('/')}`
  if (!knownPaths.has(rootPath)) return { rootPath, rootName, isNested: rootPath !== normalizedPath }
  return { rootPath, rootName, isNested: rootPath !== normalizedPath }
}

type SkillsListResponseEntry = {
  cwd: string
  skills: Array<{
    name: string
    description: string
    shortDescription?: string
    path: string
    scope: string
    enabled: boolean
  }>
  errors: unknown[]
}

export async function getSkillsList(cwds?: string[]): Promise<SkillInfo[]> {
  try {
    const params: Record<string, unknown> = {}
    if (cwds && cwds.length > 0) params.cwds = cwds
    const payload = await callRpc<{ data: SkillsListResponseEntry[] }>('skills/list', params)
    const allSkills = payload.data.flatMap((entry) => entry.skills)
    const pathSet = new Set(allSkills.map((skill) => normalizeSkillMarkdownPath(skill.path)).filter(Boolean))
    const grouped = new Map<string, SkillInfo & { __hasRoot: boolean }>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        if (!skill.name) continue
        const groupInfo = deriveGroupedSkillRoot(skill.path, pathSet)
        const normalizedPath = normalizeSkillMarkdownPath(skill.path)
        const shouldCollapseIntoRoot = Boolean(groupInfo?.isNested && pathSet.has(groupInfo.rootPath))
        const key = shouldCollapseIntoRoot ? groupInfo!.rootPath : normalizedPath
        const isRoot = normalizedPath === key
        const existing = grouped.get(key)
        const candidate: SkillInfo & { __hasRoot: boolean } = {
          name: skill.name,
          displayName: groupInfo && key === groupInfo.rootPath ? groupInfo.rootName : undefined,
          description: skill.shortDescription || skill.description || '',
          path: key,
          scope: skill.scope,
          enabled: skill.enabled,
          __hasRoot: isRoot,
        }
        if (!existing) {
          grouped.set(key, candidate)
          continue
        }
        existing.enabled = existing.enabled || skill.enabled
        if (!existing.__hasRoot && isRoot) {
          grouped.set(key, candidate)
          continue
        }
        if (!existing.displayName && candidate.displayName) {
          existing.displayName = candidate.displayName
        }
        if (!existing.description && candidate.description) {
          existing.description = candidate.description
        }
      }
    }
    return Array.from(grouped.values()).map(({ __hasRoot: _ignored, ...skill }) => skill)
  } catch {
    return []
  }
}

export async function getComposerPrompts(): Promise<ComposerPromptInfo[]> {
  try {
    const response = await fetchWithTimeout('/codex-api/prompts')
    if (!response.ok) return []
    const payload = (await response.json()) as { data?: ComposerPromptInfo[] }
    return Array.isArray(payload.data) ? payload.data : []
  } catch {
    return []
  }
}

export async function createComposerPrompt(name: string, content: string): Promise<ComposerPromptInfo | null> {
  try {
    const response = await fetchWithTimeout('/codex-api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { data?: ComposerPromptInfo }
    return payload.data ?? null
  } catch {
    return null
  }
}

export async function removeComposerPrompt(path: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({ path })
    const response = await fetchWithTimeout(`/codex-api/prompts?${params.toString()}`, {
      method: 'DELETE',
    })
    return response.ok
  } catch {
    return false
  }
}

const FILE_UPLOAD_TIMEOUT_MS = 60_000

export async function uploadFile(file: File): Promise<string | null> {
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetchWithTimeout('/codex-api/upload-file', {
      method: 'POST',
      body: form,
    }, {
      timeout: FILE_UPLOAD_TIMEOUT_MS,
      operation: 'upload-file',
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { path?: string }
    return data.path ?? null
  } catch {
    return null
  }
}
