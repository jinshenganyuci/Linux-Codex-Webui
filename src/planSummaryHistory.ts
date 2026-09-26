import type {
  ActivePlanSnapshot,
  UiMessage,
  UiPlanStep,
  UiPlanKind,
  UiPlanSummary,
  UiPlanSummaryHistoryState,
  UiTerminalPlanLifecycle,
} from './types/codex'

export const MAX_PLAN_SUMMARIES_PER_THREAD = 128
export const MAX_PLAN_SUMMARIES_TOTAL = 2_048
const MAX_PLAN_STEPS = 64
export const MAX_PLAN_SUMMARY_TEXT_LENGTH = 32_768
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
  return lines.join('\n').trim().slice(0, MAX_PLAN_SUMMARY_TEXT_LENGTH)
}

export function inferPlanKind(value: { kind?: unknown; steps?: unknown }): UiPlanKind {
  if (value.kind === 'proposal' || value.kind === 'checklist') return value.kind
  return Array.isArray(value.steps) && value.steps.length > 0 ? 'checklist' : 'proposal'
}

export function planIdentity(value: { threadId?: string; turnId?: string; kind?: unknown; itemId?: string; steps?: unknown }): string {
  const kind = inferPlanKind(value)
  return JSON.stringify([value.threadId ?? '', value.turnId ?? '', kind, kind === 'checklist' ? '' : value.itemId || `${value.turnId}:proposal`])
}

export function planMessageIdentity(threadId: string, message: UiMessage): string {
  const kind = message.plan?.kind ?? (message.messageType === 'plan' ? 'proposal' : inferPlanKind(message.plan ?? {}))
  return planIdentity({ threadId, turnId: message.turnId, kind, steps: message.plan?.steps,
    itemId: kind === 'proposal' ? message.plan?.itemId || (message.messageType === 'plan' ? message.id : undefined) : undefined })
}

export function normalizePlanSummary(value: unknown): UiPlanSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const threadId = readTrimmedString(record.threadId, 512)
  const turnId = readTrimmedString(record.turnId, 512)
  let lifecycle = normalizeLifecycle(record.lifecycle)
  if (!threadId || !turnId || !lifecycle) return null

  const nowIso = new Date().toISOString()
  const createdAtIso = readIso(record.createdAtIso, nowIso)
  const updatedAtIso = readIso(record.updatedAtIso, createdAtIso)
  const explanation = readTrimmedString(record.explanation)
  let remainingStepCharacters = Math.max(0, MAX_PLAN_SUMMARY_TEXT_LENGTH - explanation.length)
  const steps: UiPlanStep[] = []
  let hasTruncatedStepText = false
  for (const rawStep of (Array.isArray(record.steps) ? record.steps : []).slice(0, MAX_PLAN_STEPS)) {
    const step = normalizeStep(rawStep)
    if (!step || remainingStepCharacters === 0) continue
    const boundedStep = step.step.slice(0, remainingStepCharacters)
    if (!boundedStep) continue
    const originalStep = asRecord(rawStep)?.step
    if (typeof originalStep === 'string' && originalStep.trim().length > boundedStep.length) hasTruncatedStepText = true
    steps.push({ ...step, step: boundedStep })
    remainingStepCharacters -= boundedStep.length
  }
  const kind = inferPlanKind({ kind: record.kind, steps })
  const itemId = kind === 'proposal' ? readTrimmedString(record.itemId, 512) || readTrimmedString(record.messageId, 512) || `${turnId}:proposal` : undefined
  const truncated = record.truncated === true || hasTruncatedStepText || (Array.isArray(record.steps) && record.steps.length > steps.length)
  if (kind === 'checklist' && lifecycle === 'completed' && (truncated || !steps.length || steps.some(step => step.status !== 'completed'))) lifecycle = 'incomplete'
  const suppliedText = readTrimmedString(record.text, MAX_PLAN_SUMMARY_TEXT_LENGTH)
  const structuredText = buildPlanText(explanation, steps)
  const text = kind === 'proposal' ? suppliedText || structuredText : structuredText || suppliedText
  if (!text && steps.length === 0) return null

  return {
    id: kind === 'checklist' ? `plan-summary:${turnId}` : `plan-summary:${turnId}:proposal:${itemId}`,
    kind,
    itemId,
    ...(truncated ? { truncated: true } : {}),
    threadId,
    turnId,
    messageId: readTrimmedString(record.messageId, 512) || (kind === 'checklist' ? `${turnId}:plan` : itemId!),
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
  const identity = planIdentity(summary)
  const previous = current.find(entry => planIdentity(entry) === identity)
  if (previous && (previous.revision > summary.revision || (previous.revision === summary.revision && previous.updatedAtIso > summary.updatedAtIso))) return current
  const next = current.filter((entry) => planIdentity(entry) !== identity)
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
      const previous = byTurnId.get(planIdentity(summary))
      if (!previous || previous.revision < summary.revision || (previous.revision === summary.revision && previous.updatedAtIso <= summary.updatedAtIso)) {
        byTurnId.set(planIdentity(summary), summary)
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
      kind: inferPlanKind(summary),
      itemId: summary.itemId,
      ...(summary.truncated ? { truncated: true } : {}),
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
  const loadedTurnIds = new Set(
    messages.map((message) => message.turnId?.trim() ?? '').filter(Boolean),
  )
  for (const summary of [...summaries].sort((first, second) => first.createdAtIso.localeCompare(second.createdAtIso))) {
    if (!loadedTurnIds.has(summary.turnId)) continue
    const nativePlanIndex = next.findIndex((message) => (
      (message.messageType === 'plan' || message.messageType === 'plan.summary')
      && planMessageIdentity(summary.threadId, message) === planIdentity(summary)
    ))
    if (nativePlanIndex >= 0) {
      const nativePlan = next[nativePlanIndex]
      next.splice(nativePlanIndex, 1, {
        ...nativePlan,
        text: summary.text,
        plan: {
          kind: inferPlanKind(summary),
          itemId: summary.itemId,
          ...(summary.truncated ? { truncated: true } : {}),
          explanation: summary.explanation,
          steps: summary.steps,
          isStreaming: false,
          lifecycle: summary.lifecycle,
          revision: summary.revision,
          updatedAtIso: summary.updatedAtIso,
        },
      })
      continue
    }
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
  }
  return next
}
