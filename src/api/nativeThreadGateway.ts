import { fetchRpcMethodCatalog, rpcCall } from './codexRpcClient'
import { CodexApiError, extractErrorMessage } from './codexErrors'
import { fetchWithTimeout } from './requestClient'
import {
  nativeCapabilities, normalizeNativeGoal, validateGoalPatch,
  type NativeCapabilities, type NativeGoal, type NativeGoalStatus,
  type NativePermissionProfile, type NativeQueueMode, type NativeSettingsPatch, type NativeSubmission,
  normalizeNativeSettings, type NativeThreadSettings,
} from '../nativeThreadControls'

let capabilitiesPromise: Promise<NativeCapabilities> | null = null

export function getNativeCapabilities(): Promise<NativeCapabilities> {
  if (!capabilitiesPromise) {
    const pending = fetchRpcMethodCatalog().then(async methods => {
      const capabilities = nativeCapabilities(methods)
      if (capabilities.turnSettings) {
        try {
          const features = await allPages<{ name: string; enabled: boolean }>('experimentalFeature/list', {})
          if (!features.some(feature => feature.name === 'step_model_switching' && feature.enabled === true)) {
            capabilities.turnSettings = false
            capabilities.turnSettingsReason = '当前 CLI 未启用开发中的 step_model_switching；运行中设置不可用，不会擅自修改配置。'
          }
        } catch {
          capabilities.turnSettings = false
          capabilities.turnSettingsReason = '无法确认运行中设置所需的实验开关，请重新读取。'
        }
      }
      return capabilities
    })
    capabilitiesPromise = pending
    void pending.catch(() => { if (capabilitiesPromise === pending) capabilitiesPromise = null })
  }
  return capabilitiesPromise
}

export function invalidateNativeCapabilities(): void { capabilitiesPromise = null }

export async function getNativeGoal(threadId: string): Promise<NativeGoal | null> {
  const response = await rpcCall<{ goal?: unknown }>('thread/goal/get', { threadId })
  if (response.goal == null) return null
  const goal = normalizeNativeGoal(response.goal, threadId)
  if (!goal) throw new Error('Codex 返回的目标状态无效。')
  return goal
}

export async function setNativeGoal(threadId: string, patch: { objective?: string; tokenBudget?: number | null; status?: NativeGoalStatus }): Promise<NativeGoal> {
  validateGoalPatch(patch)
  const response = await rpcCall<{ goal?: unknown }>('thread/goal/set', { ...patch, threadId })
  const goal = normalizeNativeGoal(response.goal, threadId)
  if (!goal) throw new Error('Codex 返回的目标状态无效；请刷新核对，不会自动重试。')
  return goal
}

export async function clearNativeGoal(threadId: string): Promise<void> { await rpcCall('thread/goal/clear', { threadId }) }

export async function updateNativeSettings(threadId: string, patch: NativeSettingsPatch, turnId?: string): Promise<'applied' | 'targetUnavailable' | 'saved'> {
  if (!threadId.trim()) throw new Error('缺少目标会话。')
  if (turnId !== undefined) {
    if (!turnId.trim()) throw new Error('缺少当前回合 ID，不会改为更新会话设置。')
    if (patch.permissions !== undefined) throw new Error('权限只能应用于后续回合。')
    const response = await rpcCall<{ status: string }>('turn/settings/update', { ...patch, threadId, turnId })
    if (response.status !== 'applied' && response.status !== 'targetUnavailable') throw new Error('运行设置返回未知状态，请刷新核对。')
    return response.status
  }
  await rpcCall('thread/settings/update', { ...patch, threadId })
  return 'saved'
}

async function allPages<T>(method: string, params: Record<string, unknown>): Promise<T[]> {
  const rows: T[] = []
  let totalBytes = 0
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const result: { data: T[]; nextCursor?: string | null } = await rpcCall(method, { ...params, cursor, limit: 100 })
    if (!Array.isArray(result.data)) throw new Error(`${method} 返回无效列表。`)
    totalBytes += new TextEncoder().encode(JSON.stringify(result.data)).byteLength
    if (totalBytes > 8 * 1024 * 1024) throw new Error(`${method} 超出列表字节上限，请通过 CLI 管理大型队列。`)
    rows.push(...result.data)
    if (rows.length > 2000) throw new Error(`${method} 超出列表安全上限。`)
    if (!result.nextCursor) return rows
    if (seen.has(result.nextCursor)) throw new Error(`${method} 返回重复分页游标。`)
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error(`${method} 超出分页安全上限。`)
}

export async function getNativePermissionProfiles(): Promise<NativePermissionProfile[]> {
  return (await allPages<{ id?: unknown; allowed?: unknown; description?: unknown }>('permissionProfile/list', {}))
    .filter(profile => typeof profile.id === 'string' && typeof profile.allowed === 'boolean')
    .map(profile => ({ id: String(profile.id), allowed: profile.allowed === true, description: typeof profile.description === 'string' ? profile.description.slice(0, 2000) : '' }))
}

export async function getNativeQueue(threadId: string): Promise<NativeSubmission[]> {
  const rows = await allPages<NativeSubmission>('thread/queue/list', { threadId })
  if (rows.some(row => typeof row.id !== 'string' || typeof row.clientUserMessageId !== 'string' || !Array.isArray(row.input))) throw new Error('原生队列返回无效条目。')
  return rows
}

export async function addNativeQueueInput(threadId: string, clientUserMessageId: string, input: Array<Record<string, unknown>>): Promise<NativeSubmission> {
  try {
    const submission = (await rpcCall<{ queuedSubmission?: NativeSubmission }>('thread/queue/add', { threadId, clientUserMessageId, input })).queuedSubmission
    if (!submission?.id || submission.clientUserMessageId !== clientUserMessageId || !Array.isArray(submission.input)) throw new CodexApiError('原生队列返回了不完整的确认。', { code: 'invalid_response', method: 'thread/queue/add' })
    return submission
  } catch (error) {
    if (error instanceof CodexApiError && (['timeout', 'network_error', 'aborted', 'invalid_response'].includes(error.code) || (error.code === 'http_error' && (error.status ?? 0) >= 500))) {
      const received = (await getNativeQueue(threadId).catch(() => [])).find(row => row.clientUserMessageId === clientUserMessageId)
      if (received) return received
      throw new Error('队列提交结果不确定，可能已被接收或开始执行。请核对队列和对话，不会自动重发。')
    }
    throw error
  }
}

export async function updateNativeQueueInput(threadId: string, queuedSubmissionId: string, input: Array<Record<string, unknown>>): Promise<void> { await rpcCall('thread/queue/update', { threadId, queuedSubmissionId, input }) }
export async function deleteNativeQueueInput(threadId: string, queuedSubmissionId: string): Promise<void> { await rpcCall('thread/queue/delete', { threadId, queuedSubmissionId }) }
export async function reorderNativeQueue(threadId: string, queuedSubmissionIds: string[]): Promise<void> { await rpcCall('thread/queue/reorder', { threadId, queuedSubmissionIds }) }
export async function startNativeQueueInput(threadId: string, queuedSubmissionId: string): Promise<void> { await rpcCall('thread/queue/start', { threadId, queuedSubmissionId }) }

export async function getNativeThreadState(threadId: string): Promise<{ mode: NativeQueueMode; settings: NativeThreadSettings | null }> {
  const response = await fetchWithTimeout(`/codex-api/native-queue-mode?threadId=${encodeURIComponent(threadId)}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok || !['legacy', 'native'].includes(payload?.data?.mode)) throw new Error(extractErrorMessage(payload, '无法读取队列归属。'))
  return { mode: payload.data.mode, settings: normalizeNativeSettings(payload.data.settings) }
}

export async function getNativeQueueMode(threadId: string): Promise<NativeQueueMode> { return (await getNativeThreadState(threadId)).mode }

export async function setNativeQueueMode(threadId: string, mode: NativeQueueMode): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/native-queue-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, mode }) })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(extractErrorMessage(payload, '无法切换队列归属。'))
}
