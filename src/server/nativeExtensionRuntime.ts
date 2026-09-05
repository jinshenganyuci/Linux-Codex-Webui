import { extensionRecord, extensionText, type NativeExtensionInfo, type NativeFeature, type NativeRealtimeSnapshot } from '../nativeExtensions'

type Rpc = (method: string, params: unknown) => Promise<unknown>
type Runtime = () => { codex: { version: string | null; generation: number } }

export function createExtensionInfoReader(rpc: Rpc, runtime: Runtime, now = Date.now) {
  const cache = new Map<string, { pending: Promise<NativeExtensionInfo>; validUntil: number; generation: number }>()
  const invalidate = () => { cache.clear() }
  const read = (threadId = ''): Promise<NativeExtensionInfo> => {
    const generation = runtime().codex.generation
    const cached = cache.get(threadId)
    if (cached && cached.generation === generation && now() < cached.validUntil) return cached.pending
    if (!cache.has(threadId) && cache.size >= 32) cache.delete(cache.keys().next().value!)
    const pending = (async () => {
      const warnings: string[] = []
      const optional = async (method: string, params: unknown) => {
        try { return extensionRecord(await rpc(method, params)) } catch { warnings.push(`${method} 读取失败，相关状态未知。`); return null }
      }
      const [config, requirements, account, features] = await Promise.all([
        threadId ? optional('thread/read', { threadId, includeTurns: false }) : optional('config/read', { includeLayers: false }), optional('configRequirements/read', {}), optional('account/read', { refreshToken: false }),
        (async () => {
          const rows: NativeFeature[] = []
          let cursor: string | null = null
          const seen = new Set<string>()
          for (let page = 0; page < 20; page += 1) {
            const value = extensionRecord(await rpc('experimentalFeature/list', { cursor, limit: 100, ...(threadId ? { threadId } : {}) }))
            if (!Array.isArray(value?.data)) throw new Error('CLI 返回无效能力目录。')
            for (const raw of value.data) {
              const item = extensionRecord(raw)
              if (item && typeof item.name === 'string' && typeof item.enabled === 'boolean') rows.push({ name: extensionText(item.name, 128), enabled: item.enabled, defaultEnabled: item.defaultEnabled === true, stage: extensionText(item.stage, 64), displayName: extensionText(item.displayName) || null, description: extensionText(item.description, 1500) || null })
            }
            if (rows.length > 2000) throw new Error('能力目录超过上限。')
            cursor = typeof value.nextCursor === 'string' ? value.nextCursor : null
            if (!cursor) return rows
            if (seen.has(cursor)) throw new Error('能力目录返回重复游标。')
            seen.add(cursor)
          }
          throw new Error('能力目录分页超过上限。')
        })(),
      ])
      const locks = extensionRecord(extensionRecord(requirements?.requirements)?.featureRequirements)
      return {
        threadId: threadId || null, cliVersion: runtime().codex.version, provider: extensionText(threadId ? extensionRecord(config?.thread)?.modelProvider : extensionRecord(config?.config)?.model_provider) || 'unknown',
        accountType: extensionText(extensionRecord(account?.account)?.type) || null, features,
        requirementsKnown: requirements !== null,
        featureRequirements: Object.fromEntries(Object.entries(locks ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')), warnings,
      }
    })()
    cache.set(threadId, { pending, validUntil: now() + 15000, generation })
    void pending.catch(() => { if (cache.get(threadId)?.pending === pending) cache.delete(threadId) })
    return pending
  }
  return { read, invalidate }
}

export class RealtimeSessionConflict extends Error {}
type Lease = { ownerId: string; touchedAt: number; phase: string; cleanupAttempts: number }
const unsupportedRealtimeThread = (error: unknown) => error instanceof Error && /^thread [^\r\n]+ does not support realtime conversation$/.test(error.message)

export class NativeRealtimeSessions {
  private leases = new Map<string, Lease>()
  private mutations = new Map<string, Promise<unknown>>()
  private disposed = false
  private generation = 0
  constructor(private rpc: Rpc, private now = Date.now) {}

  snapshot(threadId: string, ownerId: string): NativeRealtimeSnapshot {
    const lease = this.leases.get(threadId)
    return { active: Boolean(lease), owned: Boolean(lease?.ownerId && lease.ownerId === ownerId), phase: lease?.phase ?? 'idle' }
  }

  isWebUiOwned(threadId: string): boolean { return Boolean(this.leases.get(threadId)?.ownerId) }

  async request(action: string, threadId: string, ownerId: string, options: unknown = null): Promise<NativeRealtimeSnapshot> {
    if (this.disposed || !threadId || threadId.length > 256 || !ownerId || ownerId.length > 128) throw new RealtimeSessionConflict('实时会话标识无效或桥接已关闭。')
    if (!this.mutations.has(threadId) && this.mutations.size >= 64) throw new RealtimeSessionConflict('实时操作过多，请稍后重试。')
    const previous = this.mutations.get(threadId)
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.disposed) throw new RealtimeSessionConflict('实时桥接已关闭。')
      const lease = this.leases.get(threadId)
      if (action === 'start') {
        if (lease) throw new RealtimeSessionConflict('该会话已有实时连接，请在原页面停止或等待断线租约清理。')
        if (this.leases.size >= 64) throw new RealtimeSessionConflict('实时会话数量达到上限。')
        const params = extensionRecord(options)
        const transport = extensionRecord(params?.transport)
        if (!params || params.version !== 'v1' || params.outputModality !== 'audio' || transport?.type !== 'webrtc' || typeof transport.sdp !== 'string' || transport.sdp.length > 128 * 1024) throw new RealtimeSessionConflict('无效的 WebRTC 启动参数；当前适配使用 V1 音频会话。')
        const owned: Lease = { ownerId, touchedAt: this.now(), phase: 'starting', cleanupAttempts: 0 }
        this.leases.set(threadId, owned)
        try {
          await this.rpc('thread/realtime/start', { threadId, outputModality: 'audio', version: 'v1', transport: { type: 'webrtc', sdp: transport.sdp }, ...(typeof params.model === 'string' && params.model.trim() ? { model: params.model.trim() } : {}), ...(typeof params.voice === 'string' && params.voice ? { voice: params.voice } : {}) })
        } catch (error) {
          if (this.leases.get(threadId) === owned) {
            if (unsupportedRealtimeThread(error)) this.leases.delete(threadId)
            else {
              owned.phase = 'uncertain'
              try { await this.rpc('thread/realtime/stop', { threadId }); this.leases.delete(threadId) } catch { owned.touchedAt = 0 }
            }
          }
          throw error
        }
      } else {
        if (!lease && action === 'stop') return this.snapshot(threadId, ownerId)
        if (!lease || lease.ownerId !== ownerId) throw new RealtimeSessionConflict('实时会话属于其他页面，未执行操作。')
        if (action === 'heartbeat') lease.touchedAt = this.now()
        else if (action === 'stop') {
          try { await this.rpc('thread/realtime/stop', { threadId }) } catch (error) { if (!unsupportedRealtimeThread(error)) throw error }
          if (this.leases.get(threadId) === lease) this.leases.delete(threadId)
        }
        else if (action === 'text') {
          const text = extensionRecord(options)?.text
          if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new RealtimeSessionConflict('实时文本为空或过长。')
          await this.rpc('thread/realtime/appendText', { threadId, text })
        } else throw new RealtimeSessionConflict('未知实时操作。')
      }
      return this.snapshot(threadId, ownerId)
    })
    this.mutations.set(threadId, pending)
    void pending.finally(() => { if (this.mutations.get(threadId) === pending) this.mutations.delete(threadId) }).catch(() => {})
    return pending
  }

  observe(method: string, params: unknown, generation?: number): void {
    if (typeof generation === 'number' && generation > this.generation) {
      if (this.generation) this.leases.clear()
      this.generation = generation
    }
    const threadId = extensionText(extensionRecord(params)?.threadId, 256)
    if (!threadId) return
    if (method === 'thread/realtime/closed') this.leases.delete(threadId)
    else if (method === 'thread/realtime/started') {
      const lease = this.leases.get(threadId)
      if (lease) lease.phase = 'accepted'
      else if (this.leases.size < 64) this.leases.set(threadId, { ownerId: '', touchedAt: Infinity, phase: 'external', cleanupAttempts: 0 })
    } else if (method === 'thread/realtime/error') {
      const lease = this.leases.get(threadId)
      if (lease) { lease.phase = 'error'; lease.touchedAt = 0 }
    }
  }

  async sweep(): Promise<void> {
    await Promise.all([...this.leases].filter(([, lease]) => lease.ownerId && lease.cleanupAttempts < 3 && this.now() - lease.touchedAt > 30000).map(([threadId, lease]) => {
      lease.cleanupAttempts += 1
      return this.request('stop', threadId, lease.ownerId).catch(() => { lease.phase = 'cleanupFailed' })
    }))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.mutations.values()])
    await Promise.all([...this.leases].filter(([, lease]) => lease.ownerId).map(([threadId]) => this.rpc('thread/realtime/stop', { threadId }).catch(() => {})))
    this.leases.clear()
  }
}
