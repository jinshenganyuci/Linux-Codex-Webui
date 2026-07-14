import type {
  UiAgentProgressNode,
  UiAgentProgressPhase,
  UiAgentProgressStatus,
  UiNotificationConnectionState,
  UiTurnProgress,
} from '../../types/codex'

export const AGENT_PROGRESS_STALE_MS = 45_000

export type AgentProgressCounts = {
  total: number
  active: number
  completed: number
  interrupted: number
  failed: number
}

export function orderedAgentProgressNodes(progress: UiTurnProgress): UiAgentProgressNode[] {
  const childrenByParent = new Map<string, UiAgentProgressNode[]>()
  for (const agent of progress.agents) {
    const parentId = agent.parentThreadId || progress.rootThreadId
    const children = childrenByParent.get(parentId) ?? []
    children.push(agent)
    childrenByParent.set(parentId, children)
  }
  const sortNodes = (nodes: UiAgentProgressNode[]) => nodes.sort((first, second) => (
    first.startedAtMs - second.startedAtMs || first.threadId.localeCompare(second.threadId)
  ))
  for (const children of childrenByParent.values()) sortNodes(children)

  const ordered: UiAgentProgressNode[] = []
  const visited = new Set<string>()
  const visit = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.threadId)) continue
      visited.add(child.threadId)
      ordered.push(child)
      visit(child.threadId)
    }
  }
  visit(progress.rootThreadId)
  for (const orphan of sortNodes(progress.agents.filter((agent) => !visited.has(agent.threadId)))) {
    if (visited.has(orphan.threadId)) continue
    visited.add(orphan.threadId)
    ordered.push(orphan)
    visit(orphan.threadId)
  }
  return ordered
}

export function countAgentProgress(progress: UiTurnProgress): AgentProgressCounts {
  const counts: AgentProgressCounts = {
    total: progress.agents.length,
    active: 0,
    completed: 0,
    interrupted: 0,
    failed: 0,
  }
  for (const agent of progress.agents) {
    if (agent.status === 'starting' || agent.status === 'running') counts.active += 1
    else if (agent.status === 'completed') counts.completed += 1
    else if (agent.status === 'interrupted') counts.interrupted += 1
    else counts.failed += 1
  }
  return counts
}

export function isAgentProgressStale(
  progress: UiTurnProgress,
  nowMs: number,
  connectionState: UiNotificationConnectionState = 'connected',
): boolean {
  return progress.status === 'running'
    && connectionState === 'connected'
    && nowMs - progress.lastActivityAtMs >= AGENT_PROGRESS_STALE_MS
}

export function isAgentNodeStale(
  agent: UiAgentProgressNode,
  nowMs: number,
  connectionState: UiNotificationConnectionState = 'connected',
): boolean {
  return (agent.status === 'starting' || agent.status === 'running')
    && connectionState === 'connected'
    && nowMs - agent.lastActivityAtMs >= AGENT_PROGRESS_STALE_MS
}

export function phaseTranslationKey(phase: UiAgentProgressPhase): string {
  const labels: Record<UiAgentProgressPhase, string> = {
    preparing: 'Preparing',
    reasoning: 'Reasoning',
    dispatching: 'Dispatching agents',
    waitingForAgents: 'Waiting for agents',
    executing: 'Executing',
    applyingChanges: 'Applying changes',
    summarizing: 'Summarizing',
    completed: 'Completed',
    interrupted: 'Interrupted',
    failed: 'Failed',
  }
  return labels[phase]
}

export function agentStatusTranslationKey(status: UiAgentProgressStatus, stale = false): string {
  if (stale) return 'Stale'
  if (status === 'starting') return 'Starting'
  if (status === 'running') return 'Running'
  if (status === 'completed') return 'Completed'
  if (status === 'interrupted') return 'Interrupted'
  return 'Failed'
}

export function agentDisplayName(agent: UiAgentProgressNode, index: number): string {
  if (agent.nickname.trim()) return agent.nickname.trim()
  const path = agent.path.replace(/\\/gu, '/').replace(/\/+$/gu, '')
  const pathName = path.split('/').filter(Boolean).at(-1)?.trim() ?? ''
  return pathName || `Agent ${index + 1}`
}

export function formatProgressDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
