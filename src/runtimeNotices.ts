import type { UiRuntimeNotice } from './types/codex'

const NOTICE_METHODS = new Set([
  'model/safetyBuffering/updated', 'model/verification', 'model/rerouted',
  'modelProvider/authRecoveryStarted', 'modelProvider/authRecoveryCompleted', 'turn/moderationMetadata',
])
const MAX_THREADS = 64
const MAX_DETAIL_LENGTH = 1000

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_DETAIL_LENGTH) : ''
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, 4).map(text).filter(Boolean) : []
}

export function normalizeRuntimeNotices(value: unknown): UiRuntimeNotice[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).flatMap((value) => {
    const row = record(value)
    if (!['safety', 'verification', 'authentication', 'rerouted', 'moderation'].includes(text(row.kind))) return []
    if (!text(row.threadId) || !text(row.turnId) || !text(row.title)) return []
    return [{ kind: row.kind as UiRuntimeNotice['kind'], threadId: text(row.threadId), turnId: text(row.turnId), title: text(row.title), details: texts(row.details), requiresAction: row.requiresAction === true }]
  })
}

export class RuntimeNoticeStore {
  private readonly threads = new Map<string, { turnId: string; notices: UiRuntimeNotice[]; terminal: boolean }>()

  read(threadId: string): UiRuntimeNotice[] {
    return this.threads.get(threadId)?.notices ?? []
  }

  snapshot(): Record<string, UiRuntimeNotice[]> {
    return Object.fromEntries([...this.threads].filter(([, state]) => state.notices.length > 0).map(([threadId, state]) => [threadId, state.notices]))
  }

  clear(): void {
    this.threads.clear()
  }

  replace(threadId: string, turnId: string, notices: UiRuntimeNotice[]): boolean {
    const filtered = normalizeRuntimeNotices(notices).filter(notice => notice.threadId === threadId && (!turnId || notice.turnId === turnId))
    if (JSON.stringify(this.read(threadId)) === JSON.stringify(filtered)) return false
    this.put(threadId, { turnId: turnId || filtered[0]?.turnId || '', notices: filtered, terminal: false })
    return true
  }

  private put(threadId: string, state: { turnId: string; notices: UiRuntimeNotice[]; terminal: boolean }): void {
    this.threads.delete(threadId)
    this.threads.set(threadId, state)
    while (this.threads.size > MAX_THREADS) {
      const oldest = this.threads.keys().next().value
      if (oldest !== undefined) this.threads.delete(oldest)
    }
  }

  observe(method: string, params: unknown): boolean {
    if (!NOTICE_METHODS.has(method) && method !== 'turn/started' && method !== 'turn/completed') return false
    const row = record(params)
    const turn = record(row.turn)
    const threadId = text(row.threadId)
    const turnId = text(row.turnId) || text(turn.id)
    if (!threadId || !turnId) return false
    const current = this.threads.get(threadId)
    if (method === 'turn/started') {
      if (current?.turnId === turnId) return false
      this.put(threadId, { turnId, notices: [], terminal: false })
      return true
    }
    if (current && current.turnId !== turnId) return false
    if (method === 'turn/completed') {
      this.put(threadId, { turnId, notices: (current?.notices ?? []).filter(notice => notice.kind === 'verification' || notice.kind === 'rerouted'), terminal: true })
      return true
    }
    const transient = method === 'model/safetyBuffering/updated' || method === 'modelProvider/authRecoveryStarted'
    if (transient && current?.terminal) return false
    let kind: UiRuntimeNotice['kind'] = 'moderation'
    let title = 'Moderation information received'
    let details: string[] = []
    let remove = false
    if (method === 'model/safetyBuffering/updated') {
      kind = 'safety'
      title = 'Safety buffering · task is still running'
      details = [text(row.model), ...texts(row.reasons)].filter(Boolean).slice(0, 4)
      remove = row.showBufferingUi !== true
    } else if (method === 'model/verification') {
      kind = 'verification'
      title = 'Account verification required'
      details = texts(row.verifications)
      remove = details.length === 0
    } else if (method.startsWith('modelProvider/authRecovery')) {
      kind = 'authentication'
      title = 'Recovering provider authentication'
      details = [text(row.provider)].filter(Boolean)
      remove = method === 'modelProvider/authRecoveryCompleted'
    } else if (method === 'model/rerouted') {
      kind = 'rerouted'
      title = 'The service rerouted this turn'
      details = [`${text(row.fromModel)} → ${text(row.toModel)}`, text(row.reason)].filter(Boolean)
    }
    const notices = (current?.notices ?? []).filter(notice => notice.kind !== kind)
    if (!remove) notices.push({ kind, title, details, threadId, turnId, requiresAction: kind === 'verification' })
    this.put(threadId, { turnId, notices, terminal: current?.terminal ?? false })
    return true
  }
}
