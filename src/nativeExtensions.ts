export type NativeFeature = { name: string; enabled: boolean; defaultEnabled: boolean; stage: string; displayName: string | null; description: string | null }
export type NativeExtensionInfo = {
  descendantThreads?: boolean
  cliVersion: string | null
  provider: string
  accountType: string | null
  features: NativeFeature[]
  featureRequirements: Record<string, boolean>
  requirementsKnown: boolean
  warnings: string[]
}
export type NativeRemoteStatus = { status: 'disabled' | 'connecting' | 'connected' | 'errored'; serverName: string; installationId: string; environmentId: string | null }
export type NativeRemoteClient = { clientId: string; displayName?: string | null; platform?: string | null; lastSeenAt?: number | null }
export type NativePairing = { environmentId: string; expiresAt: number; pairingCode: string; manualPairingCode?: string | null }
export type NativeChildThread = { id: string; parentThreadId: string | null; name: string; role: string; preview: string; model: string; effort: string; status: string; updatedAt: number; archived: boolean }
export type NativeRealtimeSnapshot = { active: boolean; owned: boolean; phase: string }
export type NativeRealtimeOptions = { outputModality: 'audio'; model?: string; voice?: string; transport: { type: 'webrtc'; sdp: string }; version: 'v1' }

export const RUNTIME_FEATURE_KEYS = ['apps', 'plugins'] as const
export const NATIVE_EXTENSION_METHODS = {
  realtime: ['thread/realtime/start', 'thread/realtime/stop', 'thread/realtime/appendText', 'thread/realtime/listVoices'],
  remote: ['remoteControl/status/read', 'remoteControl/enable', 'remoteControl/disable', 'remoteControl/pairing/start', 'remoteControl/pairing/status', 'remoteControl/clients/list', 'remoteControl/clients/revoke'],
} as const

export function extensionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export const extensionText = (value: unknown, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : ''

export function normalizeChildThread(value: unknown, archived: boolean): NativeChildThread | null {
  const row = extensionRecord(value)
  if (!row || typeof row.id !== 'string') return null
  return {
    id: row.id, parentThreadId: typeof row.parentThreadId === 'string' ? row.parentThreadId : null,
    name: extensionText(row.agentNickname || row.name || row.id), role: extensionText(row.agentRole),
    preview: extensionText(row.preview, 1500), model: extensionText(row.model), effort: extensionText(row.reasoningEffort),
    status: extensionText(extensionRecord(row.status)?.type) || 'unknown', updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0, archived,
  }
}

export function contextCapabilityLabel(info: NativeExtensionInfo): string {
  const feature = info.features.find(row => row.name === 'context_management')
  if (!feature) return 'CLI 未提供新上下文管理开关；实际能力未知。'
  if (!feature.enabled) return 'CLI 加载的新上下文管理开关未启用。普通压缩是独立能力。'
  if (info.provider !== 'openai' || info.accountType !== 'chatgpt') return '开关已加载，但当前 provider/认证不满足已核对的默认启用路径；不能据此认定实际生效。'
  return '开关已加载；尚无本会话使用新上下文管理的执行证据。'
}

export function isVolatileRealtimeNotification(method: string): boolean {
  return method.startsWith('thread/realtime/')
}
