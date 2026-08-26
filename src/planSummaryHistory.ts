import type {
  ActivePlanSnapshot,
  UiMessage,
  UiPlanStep,
  UiPlanSummary,
  UiPlanSummaryHistoryState,
  UiTerminalPlanLifecycle,
} from './types/codex'

export const MAX_PLAN_SUMMARIES_PER_THREAD = 128
export const MAX_PLAN_SUMMARIES_TOTAL = 2_048
const MAX_PLAN_STEPS = 64
const MAX_PLAN_TEXT_LENGTH = 32_768
const MAX_PLAN_SEGMENT_LENGTH = 4_096

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readTrimmedString(value: unknown, maxLength = MAX_PLAN_SEGMENT_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function readIso(value: unknown, fallback: string): string {
  const text = readTrimmedString(value, 64)
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback
}

function readRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeLifecycle(value: unknown): UiTerminalPlanLifecycle | null {
  if (value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'incomplete') {
    return value
  }
  return null
}

function normalizeStep(value: unknown): UiPlanStep | null {
  const record = asRecord(value)
  if (!record) return null
  const step = readTrimmedString(record.step)
  if (!step) return null
  const status = record.status === 'completed'
    ? 'completed'
    : record.status === 'inProgress' || record.status === 'in_progress'
      ? 'inProgress'
      : 'pending'
  return { step, status }
}

function buildPlanText(explanation: string, steps: UiPlanStep[]): string {
  const lines = explanation ? [explanation] : []
  for (const step of steps) {
    const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
    lines.push(`- [${marker}] ${step.step}`)
  }
  return lines.join('\n').trim().slice(0, MAX_PLAN_TEXT_LENGTH)
}

export function normalizePlanSummary(value: unknown): UiPlanSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const threadId = readTrimmedString(record.threadId, 512)
  const turnId = readTrimmedString(record.turnId, 512)
  const lifecycle = normalizeLifecycle(record.lifecycle)
  if (!threadId || !turnId || !lifecycle) return null

  const nowIso = new Date().toISOString()
  const createdAtIso = readIso(record.createdAtIso, nowIso)
  const updatedAtIso = readIso(record.updatedAtIso, createdAtIso)
  const explanation = readTrimmedString(record.explanation)
  const steps = (Array.isArray(record.steps) ? record.steps : [])
    .map(normalizeStep)
    .filter((step): step is UiPlanStep => step !== null)
    .slice(0, MAX_PLAN_STEPS)
  const suppliedText = readTrimmedString(record.text, MAX_PLAN_TEXT_LENGTH)
  const text = suppliedText || buildPlanText(explanation, steps)
  if (!text && steps.length === 0) return null

  return {
    id: readTrimmedString(record.id, 512) || `plan-summary:${turnId}`,
    threadId,
    turnId,
    messageId: readTrimmedString(record.messageId, 512) || `${turnId}:plan`,
    text,
    explanation: explanation || undefined,
    steps,
    revision: readRevision(record.revision),
    lifecycle,
    createdAtIso,
    updatedAtIso,
  }
}

export function planSummaryFromSnapshot(snapshot: ActivePlanSnapshot): UiPlanSummary | null {
  return normalizePlanSummary({
    ...snapshot,
    id: `plan-summary:${snapshot.turnId}`,
  })
}

export function upsertPlanSummary(current: UiPlanSummary[], input: UiPlanSummary): UiPlanSummary[] {
  const summary = normalizePlanSummary(input)
  if (!summary) return current
  const next = current.filter((entry) => entry.turnId !== summary.turnId)
  next.push(summary)
  return next
    .sort((first, second) => first.createdAtIso.localeCompare(second.createdAtIso))
    .slice(-MAX_PLAN_SUMMARIES_PER_THREAD)
}

export function normalizePlanSummaryHistoryState(value: unknown): UiPlanSummaryHistoryState {
  const record = asRecord(value)
  const threadsRecord = asRecord(record?.threads) ?? record
  if (!threadsRecord) return {}

  const all: UiPlanSummary[] = []
  for (const [rawThreadId, rawSummaries] of Object.entries(threadsRecord)) {
    if (rawThreadId === 'version' || !Array.isArray(rawSummaries)) continue
    const threadId = readTrimmedString(rawThreadId, 512)
    if (!threadId) continue
    const byTurnId = new Map<string, UiPlanSummary>()
    for (const rawSummary of rawSummaries) {
      const summary = normalizePlanSummary(rawSummary)
      if (summary?.threadId !== threadId) continue
      const previous = byTurnId.get(summary.turnId)
      if (!previous || previous.updatedAtIso <= summary.updatedAtIso) {
        byTurnId.set(summary.turnId, summary)
      }
    }
    all.push(...[...byTurnId.values()].slice(-MAX_PLAN_SUMMARIES_PER_THREAD))
  }

  all.sort((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso))
  const retained = all.slice(0, MAX_PLAN_SUMMARIES_TOTAL)
  const grouped: UiPlanSummaryHistoryState = {}
  for (const summary of retained) {
    const rows = grouped[summary.threadId] ?? []
    rows.push(summary)
    grouped[summary.threadId] = rows
  }
  for (const rows of Object.values(grouped)) {
    rows.sort((first, second) => first.createdAtIso.localeCompare(second.createdAtIso))
  }
  return grouped
}

function summaryMessage(summary: UiPlanSummary, turnIndex?: number): UiMessage {
  return {
    id: summary.id,
    role: 'assistant',
    text: summary.text,
    timestampIso: summary.createdAtIso,
    messageType: 'plan.summary',
    plan: {
      explanation: summary.explanation,
      steps: summary.steps,
      isStreaming: false,
      lifecycle: summary.lifecycle,
      revision: summary.revision,
      updatedAtIso: summary.updatedAtIso,
    },
    turnId: summary.turnId,
    turnIndex,
  }
}

export function mergePlanSummaryMessages(messages: UiMessage[], summaries: UiPlanSummary[]): UiMessage[] {
  if (summaries.length === 0 || messages.length === 0) return messages
  const next = [...messages]
  const existingSummaryTurnIds = new Set(
    messages
      .filter((message) => message.messageType === 'plan.summary')
      .map((message) => message.turnId?.trim() ?? '')
      .filter(Boolean),
  )

  for (const summary of [...summaries].sort((first, second) => first.createdAtIso.localeCompare(second.createdAtIso))) {
    const nativePlanIndex = next.findIndex((message) => (
      message.messageType === 'plan' && message.turnId?.trim() === summary.turnId
    ))
    if (nativePlanIndex >= 0) {
      const nativePlan = next[nativePlanIndex]
      next.splice(nativePlanIndex, 1, {
        ...nativePlan,
        plan: {
          ...(nativePlan.plan ?? {
            explanation: summary.explanation,
            steps: summary.steps,
          }),
          isStreaming: false,
          lifecycle: summary.lifecycle,
          revision: summary.revision,
          updatedAtIso: summary.updatedAtIso,
        },
      })
      continue
    }
    if (existingSummaryTurnIds.has(summary.turnId)) continue
    const sameTurnIndexes = next
      .map((message, index) => message.turnId === summary.turnId ? index : -1)
      .filter((index) => index >= 0)
    if (sameTurnIndexes.length === 0) continue

    const createdAtMs = Date.parse(summary.createdAtIso)
    let insertAt = sameTurnIndexes[sameTurnIndexes.length - 1] + 1
    if (Number.isFinite(createdAtMs)) {
      const laterIndex = sameTurnIndexes.find((index) => {
        const timestampMs = Date.parse(next[index]?.timestampIso ?? '')
        return Number.isFinite(timestampMs) && timestampMs > createdAtMs
      })
      if (laterIndex !== undefined) insertAt = laterIndex
    }
    const turnIndex = next[sameTurnIndexes[0]]?.turnIndex
    next.splice(insertAt, 0, summaryMessage(summary, turnIndex))
    existingSummaryTurnIds.add(summary.turnId)
  }
  return next
}
