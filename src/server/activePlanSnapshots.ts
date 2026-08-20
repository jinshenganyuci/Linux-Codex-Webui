import type { ActivePlanSnapshot, UiPlanLifecycle, UiPlanStep } from '../types/codex'

export const ACTIVE_PLAN_SNAPSHOT_MAX_COUNT = 64
export const ACTIVE_PLAN_SNAPSHOT_MAX_STEPS = 64
export const ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES = 64 * 1024
export const ACTIVE_PLAN_TERMINAL_RETENTION_MS = 30_000

type ActivePlanSnapshotStoreOptions = {
  maxCount?: number
  maxSteps?: number
  maxTextBytes?: number
  terminalRetentionMs?: number
  now?: () => number
}

type StoredActivePlanSnapshot = ActivePlanSnapshot & {
  terminalAtMs: number | null
  updatedAtMs: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRawString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function extractThreadId(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  return readString(record.threadId)
    || readString(record.thread_id)
    || readString(record.conversationId)
    || readString(record.conversation_id)
    || readString(asRecord(record.thread)?.id)
    || readString(asRecord(record.turn)?.threadId)
    || readString(asRecord(record.turn)?.thread_id)
}

function extractTurnId(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  return readString(record.turnId)
    || readString(record.turn_id)
    || readString(asRecord(record.turn)?.id)
}

function normalizeStepStatus(value: unknown): UiPlanStep['status'] {
  if (value === 'completed') return 'completed'
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
  return 'pending'
}

function capUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let bytes = 0
  let result = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function buildPlanText(explanation: string, steps: UiPlanStep[]): string {
  const lines: string[] = []
  if (explanation) lines.push(explanation)
  for (const step of steps) {
    const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
    lines.push(`- [${marker}] ${step.step}`)
  }
  return lines.join('\n').trim()
}

function cloneSnapshot(snapshot: StoredActivePlanSnapshot): ActivePlanSnapshot {
  return {
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId,
    text: snapshot.text,
    explanation: snapshot.explanation,
    steps: snapshot.steps.map((step) => ({ ...step })),
    revision: snapshot.revision,
    updatedAtIso: snapshot.updatedAtIso,
    generation: snapshot.generation,
    lifecycle: snapshot.lifecycle,
  }
}

export class ActivePlanSnapshotStore {
  private readonly snapshotsByTurnId = new Map<string, StoredActivePlanSnapshot>()
  private readonly maxCount: number
  private readonly maxSteps: number
  private readonly maxTextBytes: number
  private readonly terminalRetentionMs: number
  private readonly now: () => number

  constructor(options: ActivePlanSnapshotStoreOptions = {}) {
    this.maxCount = Math.max(1, options.maxCount ?? ACTIVE_PLAN_SNAPSHOT_MAX_COUNT)
    this.maxSteps = Math.max(1, options.maxSteps ?? ACTIVE_PLAN_SNAPSHOT_MAX_STEPS)
    this.maxTextBytes = Math.max(256, options.maxTextBytes ?? ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES)
    this.terminalRetentionMs = Math.max(0, options.terminalRetentionMs ?? ACTIVE_PLAN_TERMINAL_RETENTION_MS)
    this.now = options.now ?? Date.now
  }

  applyNotification(method: string, params: unknown, generation = 0, atIso?: string): void {
    const threadId = extractThreadId(params)
    const turnId = extractTurnId(params)
    if (!threadId || !turnId) return

    const nowMs = this.now()
    this.prune(nowMs)
    if (method === 'turn/started') {
      this.markPreviousThreadPlansIncomplete(threadId, turnId, generation, nowMs, atIso)
      return
    }
    if (method === 'turn/plan/updated') {
      this.applyFullPlan(threadId, turnId, params, generation, nowMs, atIso)
      return
    }
    if (method === 'item/plan/delta') {
      this.applyDelta(threadId, turnId, params, generation, nowMs, atIso)
      return
    }
    if (method === 'turn/completed') {
      this.markTerminal(threadId, turnId, params, generation, nowMs, atIso)
    }
  }

  getSnapshots(): ActivePlanSnapshot[] {
    this.prune(this.now())
    return Array.from(this.snapshotsByTurnId.values())
      .sort((first, second) => first.updatedAtMs - second.updatedAtMs)
      .map(cloneSnapshot)
  }

  private applyFullPlan(
    threadId: string,
    turnId: string,
    params: unknown,
    generation: number,
    nowMs: number,
    atIso?: string,
  ): void {
    const record = asRecord(params)
    const rawSteps = Array.isArray(record?.plan) ? record.plan : []
    const structuredBudgetBytes = Math.max(128, Math.floor(this.maxTextBytes / 2))
    const explanation = capUtf8Prefix(
      readString(record?.explanation),
      Math.max(64, Math.floor(structuredBudgetBytes / 2)),
    )
    let remainingStructuredBytes = Math.max(
      0,
      structuredBudgetBytes - Buffer.byteLength(explanation, 'utf8'),
    )
    const steps: UiPlanStep[] = []
    for (const rawStep of rawSteps.slice(0, this.maxSteps)) {
      const row = asRecord(rawStep)
      const stepText = capUtf8Prefix(readString(row?.step), remainingStructuredBytes)
      if (!stepText) continue
      steps.push({ step: stepText, status: normalizeStepStatus(row?.status) })
      remainingStructuredBytes = Math.max(
        0,
        remainingStructuredBytes - Buffer.byteLength(stepText, 'utf8'),
      )
      if (remainingStructuredBytes === 0) break
    }
    const textBudgetBytes = Math.max(128, this.maxTextBytes - structuredBudgetBytes)
    const text = capUtf8Prefix(buildPlanText(explanation, steps), textBudgetBytes)
    const previous = this.snapshotsByTurnId.get(turnId)
    this.snapshotsByTurnId.set(turnId, {
      threadId,
      turnId,
      messageId: `${turnId}:plan`,
      text,
      explanation: explanation || undefined,
      steps,
      revision: (previous?.revision ?? 0) + 1,
      updatedAtIso: atIso || new Date(nowMs).toISOString(),
      generation,
      lifecycle: 'live',
      terminalAtMs: null,
      updatedAtMs: nowMs,
    })
    this.enforceCapacity()
  }

  private applyDelta(
    threadId: string,
    turnId: string,
    params: unknown,
    generation: number,
    nowMs: number,
    atIso?: string,
  ): void {
    const delta = readRawString(asRecord(params)?.delta)
    if (!delta) return
    const previous = this.snapshotsByTurnId.get(turnId)
    const text = capUtf8Prefix(`${previous?.text ?? ''}${delta}`, this.maxTextBytes)
    this.snapshotsByTurnId.set(turnId, {
      threadId,
      turnId,
      messageId: `${turnId}:plan`,
      text,
      explanation: previous?.explanation,
      steps: previous?.steps.map((step) => ({ ...step })) ?? [],
      revision: (previous?.revision ?? 0) + 1,
      updatedAtIso: atIso || new Date(nowMs).toISOString(),
      generation,
      lifecycle: 'live',
      terminalAtMs: null,
      updatedAtMs: nowMs,
    })
    this.enforceCapacity()
  }

  private markTerminal(
    threadId: string,
    turnId: string,
    params: unknown,
    generation: number,
    nowMs: number,
    atIso?: string,
  ): void {
    const previous = this.snapshotsByTurnId.get(turnId)
    if (!previous || previous.threadId !== threadId) return
    const status = readString(asRecord(asRecord(params)?.turn)?.status)
    const lifecycle: UiPlanLifecycle = status === 'completed'
      ? 'completed'
      : status === 'failed'
        ? 'failed'
        : status === 'interrupted'
          ? 'interrupted'
          : 'incomplete'
    this.snapshotsByTurnId.set(turnId, {
      ...previous,
      generation,
      lifecycle,
      revision: previous.revision + 1,
      updatedAtIso: atIso || new Date(nowMs).toISOString(),
      terminalAtMs: nowMs,
      updatedAtMs: nowMs,
    })
  }

  private markPreviousThreadPlansIncomplete(
    threadId: string,
    nextTurnId: string,
    generation: number,
    nowMs: number,
    atIso?: string,
  ): void {
    for (const [turnId, snapshot] of this.snapshotsByTurnId) {
      if (snapshot.threadId !== threadId || turnId === nextTurnId || snapshot.lifecycle !== 'live') continue
      this.snapshotsByTurnId.set(turnId, {
        ...snapshot,
        generation,
        lifecycle: 'incomplete',
        revision: snapshot.revision + 1,
        updatedAtIso: atIso || new Date(nowMs).toISOString(),
        terminalAtMs: nowMs,
        updatedAtMs: nowMs,
      })
    }
  }

  private prune(nowMs: number): void {
    for (const [turnId, snapshot] of this.snapshotsByTurnId) {
      if (snapshot.terminalAtMs === null) continue
      if (nowMs - snapshot.terminalAtMs >= this.terminalRetentionMs) {
        this.snapshotsByTurnId.delete(turnId)
      }
    }
    this.enforceCapacity()
  }

  private enforceCapacity(): void {
    if (this.snapshotsByTurnId.size <= this.maxCount) return
    const oldestFirst = Array.from(this.snapshotsByTurnId.values())
      .sort((first, second) => first.updatedAtMs - second.updatedAtMs)
    while (this.snapshotsByTurnId.size > this.maxCount) {
      const oldest = oldestFirst.shift()
      if (!oldest) break
      this.snapshotsByTurnId.delete(oldest.turnId)
    }
  }
}
