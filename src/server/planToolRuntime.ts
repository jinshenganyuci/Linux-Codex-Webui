type RecordValue = Record<string, unknown>
type NativeCall = (method: string, params: unknown) => Promise<unknown>
type ThreadMethod = 'thread/start' | 'thread/resume'

export const PLAN_PROGRESS_GUIDANCE = '[WebUI task progress]\nFor tasks that require multiple meaningful steps, use update_plan to keep a concise plan current: mark the step you are working on in_progress, finish it before moving on, and reflect changes or unfinished work honestly. Skip plans for simple questions. This progress guidance does not change the selected collaboration mode or authorize implementation while in Plan mode.'

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
}

function explicitPlanSetting(value: unknown): boolean | undefined {
  const config = record(value)
  const candidate = config?.['tools.update_plan.enabled']
    ?? record(config?.['tools.update_plan'])?.enabled
    ?? record(record(config?.tools)?.update_plan)?.enabled
  return typeof candidate === 'boolean' ? candidate : undefined
}

function supportsPlanSetting(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 152))
}

function unsupportedSetting(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /update_plan/i.test(message) && /unknown|unsupported|unrecognized|unexpected|invalid (?:field|key)/i.test(message)
}

/** Uses native parsed config layers; never parses TOML or changes process flags. */
export class PlanToolRuntimePolicy {
  private readonly pendingConfig = new Map<string, Promise<RecordValue>>()
  private readonly warned = new Set<string>()
  private unsupported = false
  private lastNotice: string | null = null

  constructor(private readonly notify: (message: string) => void) {}

  reset(): void {
    this.pendingConfig.clear()
    this.warned.clear()
    this.unsupported = false
    this.lastNotice = null
  }

  get compatibilityNotice(): string | null { return this.lastNotice }

  private notice(reason: string, message: string): void {
    this.lastNotice = message
    if (this.warned.has(reason)) return
    this.warned.add(reason)
    this.notify(message)
  }

  private readConfig(cwd: string, call: NativeCall): Promise<RecordValue> {
    const existing = this.pendingConfig.get(cwd)
    if (existing) return existing
    // Only coalesce concurrent reads. A later thread operation must observe
    // external config edits and must never inherit a different project's policy.
    const pending = call('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) }).then(value => {
      const payload = record(value)
      if (!payload || !record(payload.config) || !Array.isArray(payload.layers)) {
        throw new Error('Native parsed configuration layers are unavailable')
      }
      return payload
    }).finally(() => {
      if (this.pendingConfig.get(cwd) === pending) this.pendingConfig.delete(cwd)
    })
    this.pendingConfig.set(cwd, pending)
    return pending
  }

  async call(method: ThreadMethod, params: unknown, version: string | null, call: NativeCall): Promise<unknown> {
    const original = record(params)
    if (!original || this.unsupported) return call(method, params)
    if (!supportsPlanSetting(version)) {
      this.notice('version', '当前 Codex 版本无法确认支持计划工具默认配置，已保留原生行为；自动进度计划可能不可用。')
      return call(method, params)
    }
    const explicit = explicitPlanSetting(original.config)
    if (explicit === false) return call(method, params)

    let payload: RecordValue
    try {
      let cwd = typeof original.cwd === 'string' ? original.cwd.trim() : ''
      if (method === 'thread/resume' && !cwd) {
        const threadId = typeof original.threadId === 'string' ? original.threadId : ''
        // A path/history resume may target a different thread. Leave its native
        // settings intact unless the caller provides an unambiguous cwd.
        if (!threadId || original.path || original.history) throw new Error('Unknown resumed thread workspace')
        const summary = record(await call('thread/read', { threadId, includeTurns: false }))
        const thread = record(summary?.thread)
        cwd = typeof thread?.cwd === 'string' ? thread.cwd.trim() : ''
        if (!cwd) throw new Error('Unknown resumed thread workspace')
      }
      payload = await this.readConfig(cwd, call)
    } catch {
      this.notice('config', '无法读取当前会话的原生配置层，已保留原设置，未强制启用计划工具；请检查 Codex 配置兼容性。')
      return call(method, params)
    }

    // Native layers are ordered highest precedence first. Disabled/untrusted
    // project layers must not take effect. Current app-server rejects legacy
    // profiles, but older runtimes may leave them nested in raw layer data;
    // never guess which nested profile is active and override its disable.
    const layers = payload.layers as unknown[]
    const activeConfigs = [original.config, ...layers.flatMap(value => {
      const layer = record(value)
      return layer && !layer.disabledReason ? [layer.config] : []
    })]
    if (activeConfigs.some(value => {
      const config = record(value)
      return typeof config?.profile === 'string' || record(config?.profiles) !== null
    })) {
      this.notice('profiles', '当前配置包含无法确认有效层级的旧式 profile，已保留原生工具设置，未覆盖配置档中的计划工具开关。')
      return call(method, params)
    }
    let configured: boolean | undefined
    for (const value of layers) {
      const layer = record(value)
      if (!layer || layer.disabledReason) continue
      configured = explicitPlanSetting(layer.config)
      if (configured !== undefined) break
    }
    if (explicit !== true && configured === false) return call(method, params)

    const config = record(original.config) ?? {}
    const next: RecordValue = { ...original, config: { ...config, 'tools.update_plan.enabled': true } }
    if (method === 'thread/start') {
      const nativeConfig = record(payload.config)
      const existing = original.developerInstructions ?? config.developer_instructions ?? nativeConfig?.developer_instructions
      // Resume deliberately preserves persisted thread-specific instructions,
      // which thread/read does not expose for safe concatenation.
      const instructions = typeof existing === 'string' ? existing : ''
      next.developerInstructions = instructions.includes('[WebUI task progress]')
        ? instructions
        : [instructions, PLAN_PROGRESS_GUIDANCE].filter(Boolean).join('\n\n')
    }
    try {
      return await call(method, next)
    } catch (error) {
      if (!unsupportedSetting(error) || explicit === true) throw error
      this.unsupported = true
      this.notice('unsupported', '当前 Codex 拒绝计划工具配置，已回退原生会话设置；本次运行不再重复尝试自动启用。')
      // Retry only an explicit unknown-config validation failure, once. Never
      // retry transport failures or model errors that may follow thread creation.
      return call(method, params)
    }
  }
}
