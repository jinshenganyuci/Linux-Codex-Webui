import type { ReasoningEffort } from './types/codex'

export type NativeCapabilities = {
  steer: boolean
  turnSettings: boolean
  threadSettings: boolean
  goals: boolean
  queue: boolean
  permissions: boolean
  turnSettingsReason?: string
}

export const EMPTY_NATIVE_CAPABILITIES: NativeCapabilities = {
  steer: false, turnSettings: false, threadSettings: false, goals: false, queue: false, permissions: false,
}

export const NATIVE_QUEUE_METHODS = ['add', 'list', 'update', 'delete', 'reorder', 'start'].map(action => `thread/queue/${action}`)

export function nativeCapabilities(methods: readonly string[]): NativeCapabilities {
  const available = new Set(methods)
  return {
    steer: available.has('turn/steer'),
    turnSettings: available.has('turn/settings/update'),
    threadSettings: available.has('thread/settings/update'),
    goals: ['get', 'set', 'clear'].every(action => available.has(`thread/goal/${action}`)),
    queue: NATIVE_QUEUE_METHODS.every(method => available.has(method)),
    permissions: available.has('permissionProfile/list') && available.has('thread/settings/update'),
  }
}

export type NativeGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export type NativeGoal = {
  threadId: string
  objective: string
  status: NativeGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export type NativeSettingsPatch = {
  model?: string
  effort?: ReasoningEffort
  serviceTier?: string | null
  permissions?: string
}

export type NativeThreadSettings = {
  model: string
  effort: ReasoningEffort | null
  serviceTier: string | null
  permissionProfile: string | null
}

export type NativePermissionProfile = { id: string; description: string; allowed: boolean }
export type NativeSubmission = { id: string; clientUserMessageId: string; input: Array<Record<string, unknown>> }
export type NativeQueueMode = 'legacy' | 'native'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function normalizeNativeGoal(value: unknown, threadId: string): NativeGoal | null {
  const goal = record(value)
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string' || goal.objective.length > 4000) return null
  const statuses: NativeGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']
  if (!statuses.includes(goal.status as NativeGoalStatus)) return null
  for (const key of ['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt']) {
    if (!Number.isSafeInteger(goal[key]) || Number(goal[key]) < 0) return null
  }
  if (goal.tokenBudget != null && (!Number.isSafeInteger(goal.tokenBudget) || Number(goal.tokenBudget) <= 0)) return null
  return {
    threadId, objective: goal.objective, status: goal.status as NativeGoalStatus,
    tokenBudget: goal.tokenBudget == null ? null : Number(goal.tokenBudget),
    tokensUsed: Number(goal.tokensUsed), timeUsedSeconds: Number(goal.timeUsedSeconds),
    createdAt: Number(goal.createdAt), updatedAt: Number(goal.updatedAt),
  }
}

export function normalizeNativeSettings(value: unknown): NativeThreadSettings | null {
  const settings = record(value)
  if (!settings || typeof settings.model !== 'string' || !settings.model.trim()) return null
  const effort = settings.effort ?? settings.reasoningEffort
  const efforts: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const profile = record(settings.activePermissionProfile)
  return {
    model: settings.model.slice(0, 256),
    effort: efforts.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : null,
    serviceTier: typeof settings.serviceTier === 'string' ? settings.serviceTier.slice(0, 128) : null,
    permissionProfile: typeof profile?.id === 'string' ? profile.id.slice(0, 256) : typeof settings.permissionProfile === 'string' ? settings.permissionProfile.slice(0, 256) : null,
  }
}

export function validateGoalPatch(patch: { objective?: string; tokenBudget?: number | null; status?: NativeGoalStatus }): void {
  if (patch.objective !== undefined && (!patch.objective.trim() || patch.objective.length > 4000)) throw new Error('目标必须为 1–4000 个字符。')
  if (patch.tokenBudget !== undefined && patch.tokenBudget !== null && (!Number.isSafeInteger(patch.tokenBudget) || patch.tokenBudget <= 0)) throw new Error('Token 预算必须是正整数，留空表示不设置预算。')
}

export function nativeSubmissionText(submission: NativeSubmission): string {
  return submission.input.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => String(item.text)).join('\n')
}
