import { rpcCall } from './codexRpcClient'
import { fetchWithTimeout } from './requestClient'
import { getNativeCapabilities, invalidateNativeCapabilities } from './nativeThreadGateway'
import { normalizeChildThread, RUNTIME_FEATURE_KEYS, RUNTIME_FEATURE_VERSION, type NativeChildThread, type NativeExtensionInfo, type NativeRealtimeSnapshot, type NativeRealtimeOptions } from '../nativeExtensions'

async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetchWithTimeout(endpoint, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok || value.error) throw new Error(typeof value.error === 'string' ? value.error : '原生扩展请求失败。')
  return value.data as T
}
export const getExtensionInfo = (threadId = '') => api<NativeExtensionInfo>(`/codex-api/native-extension-info${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`)
export const getRealtimeSnapshot = (threadId: string, ownerId: string) => api<NativeRealtimeSnapshot>(`/codex-api/realtime-session?threadId=${encodeURIComponent(threadId)}&ownerId=${encodeURIComponent(ownerId)}`)
export const controlRealtime = (action: string, threadId: string, ownerId: string, options?: NativeRealtimeOptions | { text: string }) => api<NativeRealtimeSnapshot>('/codex-api/realtime-session', { action, threadId, ownerId, options })

export async function setRuntimeFeature(name: string, enabled: boolean, threadId = ''): Promise<NativeExtensionInfo> {
  if (!RUNTIME_FEATURE_KEYS.some(key => key === name)) throw new Error('此开关没有已核对的运行时切换接口；不会写入配置。')
  const before = await getExtensionInfo(threadId)
  if (before.cliVersion !== RUNTIME_FEATURE_VERSION || !before.requirementsKnown || Object.prototype.hasOwnProperty.call(before.featureRequirements, name)) throw new Error('CLI 版本或托管策略未确认允许此开关；不会写入配置。')
  const result = await rpcCall<{ enablement: Record<string, boolean> }>('experimentalFeature/enablement/set', { enablement: { [name]: enabled } })
  const info = await getExtensionInfo(threadId)
  if (result.enablement?.[name] !== enabled || info.features.find(row => row.name === name)?.enabled !== enabled) throw new Error('CLI 未确认开关生效；没有自动重试或写入配置。')
  invalidateNativeCapabilities()
  void getNativeCapabilities().catch(() => {})
  return info
}

export async function listNativeChildren(threadId: string): Promise<{ data: NativeChildThread[]; truncated: boolean }> {
  const rows = new Map<string, NativeChildThread>()
  for (const archived of [false, true]) {
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let page = 0; page < 4; page += 1) {
      const result: { data: unknown[]; nextCursor?: string | null } = await rpcCall('thread/list', { ancestorThreadId: threadId, modelProviders: [], sourceKinds: [], archived, cursor, limit: 50 })
      if (!Array.isArray(result.data)) throw new Error('CLI 返回无效子线程列表。')
      for (const raw of result.data) {
        const row = normalizeChildThread(raw, archived)
        if (row && row.id !== threadId) rows.set(row.id, row)
      }
      cursor = result.nextCursor ?? null
      if (rows.size > 200 || (rows.size === 200 && (cursor || !archived))) return { data: [...rows.values()].slice(0, 200), truncated: true }
      if (!cursor) break
      if (seen.has(cursor)) throw new Error('子线程返回重复游标。')
      seen.add(cursor)
      if (page === 3 || rows.size >= 200) return { data: [...rows.values()].slice(0, 200), truncated: true }
    }
  }
  return { data: [...rows.values()].sort((first, second) => second.updatedAt - first.updatedAt), truncated: false }
}
