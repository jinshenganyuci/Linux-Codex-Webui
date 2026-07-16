import type { AgentSessionModelDetails } from './agentSessionModelDetails.js'

export type AgentProgressPhase =
  | 'preparing'
  | 'reasoning'
  | 'dispatching'
  | 'waitingForAgents'
  | 'executing'
  | 'applyingChanges'
  | 'summarizing'
  | 'completed'
  | 'interrupted'
  | 'failed'

export type AgentProgressRootStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'failed'
export type AgentProgressNodeStatus = 'starting' | 'running' | 'completed' | 'interrupted' | 'errored'

export type AgentProgressNode = {
  threadId: string
  parentThreadId: string
  path: string
  nickname: string
  depth: number
  taskSummary: string
  model: string
  reasoningEffort: string
  status: AgentProgressNodeStatus
  startedAtMs: number
  lastActivityAtMs: number
  completedAtMs: number | null
  currentActivity: string
  resultAvailable: boolean
}

export type AgentProgressEvent = {
  id: string
  atMs: number
  kind:
    | 'phaseChanged'
    | 'agentStarted'
    | 'agentInteracted'
    | 'agentCompleted'
    | 'agentInterrupted'
    | 'agentErrored'
    | 'turnCompleted'
  threadId: string
  agentThreadId: string
  phase: AgentProgressPhase | null
  detail: string
}

export type AgentProgressSnapshot = {
  rootThreadId: string
  turnId: string
  status: AgentProgressRootStatus
  phase: AgentProgressPhase
  startedAtMs: number
  lastActivityAtMs: number
  mainLastActivityAtMs: number
  updatedAtMs: number
  agents: AgentProgressNode[]
  events: AgentProgressEvent[]
}

export type AgentRuntimeStateLike = {
  threadId: string
  turnId?: string
  state: 'running' | 'completed' | 'interrupted' | 'idle'
  startedAtIso?: string | null
  completedAtIso?: string | null
}

type MutableProgress = Omit<AgentProgressSnapshot, 'agents' | 'events'> & {
  agentsByThreadId: Map<string, AgentProgressNode>
  agentRootTurnIdByThreadId: Map<string, string>
  agentTurnIdByThreadId: Map<string, string>
  agentTurnStartedAtMsByThreadId: Map<string, number>
  terminalRootTurnAtMsByTurnId: Map<string, number>
  events: AgentProgressEvent[]
  seenEventKeys: Set<string>
  seenEventOrder: string[]
}

type AgentProgressTrackerOptions = {
  now?: () => number
  eventLimit?: number
  nodeLimit?: number
}

const DEFAULT_EVENT_LIMIT = 120
const DEFAULT_NODE_LIMIT = 64
const DISPLAY_TEXT_LIMIT = 240

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readEpochMs(value: unknown): number | null {
  const parsed = readNumber(value)
  if (parsed === null || parsed <= 0) return null
  return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed)
}

function readIsoMs(value: unknown): number | null {
  const text = readString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function readUuidV7TimestampMs(value: unknown): number | null {
  const text = readString(value).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text)) return null
  const parsed = Number.parseInt(`${text.slice(0, 8)}${text.slice(9, 13)}`, 16)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function compactText(value: unknown, limit = DISPLAY_TEXT_LIMIT): string {
  const text = readString(value).replace(/\s+/gu, ' ')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function normalizeItemType(value: unknown): string {
  return readString(value).replace(/[_-]/gu, '').toLowerCase()
}

function pathLabel(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/gu, '')
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized
}

function readThreadId(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const direct = readString(record.threadId)
    || readString(record.thread_id)
    || readString(record.conversationId)
    || readString(record.conversation_id)
  if (direct) return direct
  const thread = asRecord(record.thread)
  if (thread) {
    const id = readString(thread.id)
    if (id) return id
  }
  const turn = asRecord(record.turn)
  return readString(turn?.threadId) || readString(turn?.thread_id)
}

function readTurnId(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const direct = readString(record.turnId) || readString(record.turn_id)
  if (direct) return direct
  return readString(asRecord(record.turn)?.id)
}

function readNotificationAtMs(params: unknown, fallback: number, completed = false): number {
  const record = asRecord(params)
  if (!record) return fallback
  return readEpochMs(completed ? record.completedAtMs : record.startedAtMs)
    ?? readEpochMs(record.occurredAtMs)
    ?? readEpochMs(record.occurred_at_ms)
    ?? fallback
}

function readNotificationTurnStartedAtMs(params: unknown): number | null {
  const record = asRecord(params)
  if (!record) return null
  const turn = asRecord(record.turn)
  return readEpochMs(turn?.startedAtMs)
    ?? readEpochMs(turn?.startedAt)
    ?? readIsoMs(turn?.startedAt)
    ?? readEpochMs(record.startedAtMs)
    ?? readEpochMs(record.startedAt)
    ?? readIsoMs(record.startedAt)
    ?? readUuidV7TimestampMs(readTurnId(params))
}

function readThreadMetadata(value: unknown): {
  threadId: string
  parentThreadId: string
  depth: number | null
  path: string
  nickname: string
} | null {
  const thread = asRecord(value)
  if (!thread) return null
  const threadId = readString(thread.id)
  if (!threadId) return null

  const source = asRecord(thread.source)
  const subAgent = asRecord(source?.subAgent) ?? asRecord(source?.subagent)
  const spawn = asRecord(subAgent?.thread_spawn) ?? asRecord(subAgent?.threadSpawn)
  const parentThreadId = readString(thread.parentThreadId)
    || readString(thread.parent_thread_id)
    || readString(spawn?.parent_thread_id)
    || readString(spawn?.parentThreadId)
  const depthValue = readNumber(spawn?.depth)
  return {
    threadId,
    parentThreadId,
    depth: depthValue === null ? null : Math.max(0, Math.round(depthValue)),
    path: readString(thread.agentPath)
      || readString(thread.agent_path)
      || readString(spawn?.agent_path)
      || readString(spawn?.agentPath),
    nickname: readString(thread.agentNickname)
      || readString(thread.agent_nickname)
      || readString(spawn?.agent_nickname)
      || readString(spawn?.agentNickname),
  }
}

function turnStatus(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase()
  const record = asRecord(value)
  return readString(record?.type).toLowerCase()
}

function isRunningTurnStatus(status: string): boolean {
  return status.includes('progress') || status === 'running'
}

function readTurnStartedAtMs(turn: Record<string, unknown>): number {
  return readEpochMs(turn.startedAtMs)
    ?? readEpochMs(turn.startedAt)
    ?? readIsoMs(turn.startedAt)
    ?? readUuidV7TimestampMs(turn.id)
    ?? 0
}

function readTurnCompletedAtMs(turn: Record<string, unknown>): number | null {
  return readEpochMs(turn.completedAtMs) ?? readEpochMs(turn.completedAt)
}

function selectEffectiveThreadReadTurn(turns: unknown[]): Record<string, unknown> | null {
  let selected: { turn: Record<string, unknown>; lifecycleAtMs: number; index: number } | null = null
  for (const [index, value] of turns.entries()) {
    const turn = asRecord(value)
    if (!turn) continue
    const startedAtMs = readTurnStartedAtMs(turn)
    const completedAtMs = readTurnCompletedAtMs(turn) ?? 0
    const lifecycleAtMs = completedAtMs || startedAtMs
    if (
      !selected
      || lifecycleAtMs > selected.lifecycleAtMs
      || (lifecycleAtMs === selected.lifecycleAtMs && index > selected.index)
    ) {
      selected = { turn, lifecycleAtMs, index }
    }
  }
  return selected?.turn ?? null
}

function selectOverlappingThreadReadTurns(
  turns: unknown[],
  effectiveTurn: Record<string, unknown>,
): Record<string, unknown>[] {
  const effectiveStartedAtMs = readTurnStartedAtMs(effectiveTurn)
  if (effectiveStartedAtMs <= 0) return [effectiveTurn]
  const effectiveCompletedAtMs = readTurnCompletedAtMs(effectiveTurn)
  const effectiveEndAtMs = effectiveCompletedAtMs ?? Number.POSITIVE_INFINITY
  const selected: Record<string, unknown>[] = []
  for (const value of turns) {
    const turn = asRecord(value)
    if (!turn) continue
    if (turn === effectiveTurn) {
      selected.push(turn)
      continue
    }
    const startedAtMs = readTurnStartedAtMs(turn)
    if (startedAtMs <= 0) continue
    const completedAtMs = readTurnCompletedAtMs(turn)
    const status = turnStatus(turn.status)
    const endAtMs = completedAtMs ?? (isRunningTurnStatus(status) ? Number.POSITIVE_INFINITY : startedAtMs)
    if (startedAtMs <= effectiveEndAtMs && effectiveStartedAtMs <= endAtMs) selected.push(turn)
  }
  return selected
}

export class AgentProgressTracker {
  private readonly now: () => number
  private readonly eventLimit: number
  private readonly nodeLimit: number
  private readonly progressByRootThreadId = new Map<string, MutableProgress>()
  private readonly rootByThreadId = new Map<string, string>()
  private latestGeneration = 0

  constructor(options: AgentProgressTrackerOptions = {}) {
    this.now = options.now ?? Date.now
    this.eventLimit = Math.max(20, options.eventLimit ?? DEFAULT_EVENT_LIMIT)
    this.nodeLimit = Math.max(4, options.nodeLimit ?? DEFAULT_NODE_LIMIT)
  }

  handleNotification(method: string, params: unknown, generation = 0, atMs = this.now()): string[] {
    if (generation > 0 && generation < this.latestGeneration) return []
    if (generation > this.latestGeneration) this.latestGeneration = generation

    const changedRoots = new Set<string>()
    const record = asRecord(params)

    if (method === 'thread/started') {
      const metadata = readThreadMetadata(record?.thread)
      if (metadata) {
        const rootThreadId = this.registerThreadMetadata(metadata, atMs)
        if (rootThreadId) changedRoots.add(rootThreadId)
      }
      return Array.from(changedRoots)
    }

    const threadId = readThreadId(params)
    if (!threadId) return Array.from(changedRoots)
    const rootThreadId = this.rootByThreadId.get(threadId) ?? threadId

    if (method === 'turn/started') {
      const turnId = readTurnId(params)
      const startedAtMs = readNotificationTurnStartedAtMs(params) ?? readNotificationAtMs(params, atMs)
      if (threadId === rootThreadId) {
        const existing = this.progressByRootThreadId.get(rootThreadId)
        if (turnId && existing?.terminalRootTurnAtMsByTurnId.has(turnId)) {
          return Array.from(changedRoots)
        }
        if (
          turnId
          && existing?.turnId
          && turnId !== existing.turnId
          && (
            startedAtMs < existing.startedAtMs
            || (
              startedAtMs === existing.startedAtMs
              && readUuidV7TimestampMs(turnId) !== null
              && readUuidV7TimestampMs(existing.turnId) !== null
              && turnId < existing.turnId
            )
          )
        ) return Array.from(changedRoots)
        this.startRootTurn(rootThreadId, turnId, startedAtMs, generation)
        this.setRootPhase(rootThreadId, 'preparing', startedAtMs, 'turn-started')
      } else {
        const childProgress = this.ensureProgress(rootThreadId, startedAtMs, generation)
        const previousTurnId = childProgress.agentTurnIdByThreadId.get(threadId) ?? ''
        const startsNewTurn = Boolean(turnId && (!previousTurnId || turnId !== previousTurnId))
        if (this.compareChildTurn(childProgress, threadId, turnId, startedAtMs) === 'older') {
          return Array.from(changedRoots)
        }
        this.updateAgent(rootThreadId, threadId, startedAtMs, (agent) => {
          const isTerminal = agent.status === 'completed' || agent.status === 'interrupted' || agent.status === 'errored'
          if (!isTerminal || (childProgress.status === 'running' && startsNewTurn)) {
            agent.status = 'running'
            agent.completedAtMs = null
            agent.currentActivity = 'working'
            agent.resultAvailable = false
          }
        })
        if (turnId && childProgress.agentsByThreadId.has(threadId)) {
          childProgress.agentTurnIdByThreadId.set(threadId, turnId)
          childProgress.agentTurnStartedAtMsByThreadId.set(threadId, startedAtMs)
        }
      }
      changedRoots.add(rootThreadId)
      return Array.from(changedRoots)
    }

    const progress = this.ensureProgress(rootThreadId, atMs, generation)

    if (method === 'turn/completed') {
      const completedAtMs = readNotificationAtMs(params, atMs, true)
      const status = turnStatus(asRecord(record?.turn)?.status)
      if (threadId === rootThreadId) {
        const completedTurnId = readTurnId(params)
        const isOverlappingTurn = Boolean(completedTurnId && progress.turnId && completedTurnId !== progress.turnId)
        if (isOverlappingTurn && (progress.status === 'running' || completedAtMs < progress.mainLastActivityAtMs)) {
          this.recordRootTurnTerminal(progress, completedTurnId, completedAtMs)
          return Array.from(changedRoots)
        }
        if (completedTurnId && (isOverlappingTurn || !progress.turnId)) {
          const turn = asRecord(record?.turn)
          const startedAtMs = readEpochMs(turn?.startedAtMs)
            ?? readEpochMs(turn?.startedAt)
            ?? readIsoMs(turn?.startedAt)
          progress.turnId = completedTurnId
          if (startedAtMs !== null) progress.startedAtMs = startedAtMs
        }
        if (status.includes('fail') || status.includes('error')) {
          progress.status = 'failed'
          this.setRootPhase(rootThreadId, 'failed', completedAtMs, 'turn-failed')
        } else if (status.includes('interrupt') || status.includes('cancel')) {
          progress.status = 'interrupted'
          this.setRootPhase(rootThreadId, 'interrupted', completedAtMs, 'turn-interrupted')
        } else {
          progress.status = 'completed'
          this.setRootPhase(rootThreadId, 'completed', completedAtMs, 'turn-completed')
        }
        this.recordRootTurnTerminal(progress, completedTurnId || progress.turnId, completedAtMs)
        this.addEvent(progress, {
          id: `turn:${readTurnId(params) || progress.turnId}:completed`,
          atMs: completedAtMs,
          kind: 'turnCompleted',
          threadId,
          agentThreadId: '',
          phase: progress.phase,
          detail: progress.status,
        })
      } else {
        const completedTurnId = readTurnId(params)
        const activeChildTurnId = progress.agentTurnIdByThreadId.get(threadId) ?? ''
        const completedTurnStartedAtMs = readNotificationTurnStartedAtMs(params)
        const childTurnOrder = this.compareChildTurn(
          progress,
          threadId,
          completedTurnId,
          completedTurnStartedAtMs,
        )
        if (
          completedTurnId
          && activeChildTurnId
          && completedTurnId !== activeChildTurnId
          && childTurnOrder !== 'newer'
        ) {
          return Array.from(changedRoots)
        }
        if (completedTurnId && progress.agentsByThreadId.has(threadId)) {
          progress.agentTurnIdByThreadId.set(threadId, completedTurnId)
          if (completedTurnStartedAtMs !== null) {
            progress.agentTurnStartedAtMsByThreadId.set(threadId, completedTurnStartedAtMs)
          }
        }
        this.updateAgent(rootThreadId, threadId, completedAtMs, (agent) => {
          agent.completedAtMs = completedAtMs
          agent.currentActivity = ''
          agent.resultAvailable = true
          agent.status = status.includes('fail') || status.includes('error')
            ? 'errored'
            : status.includes('interrupt') || status.includes('cancel')
              ? 'interrupted'
              : 'completed'
          this.addAgentTerminalEvent(progress, agent, completedAtMs)
        })
      }
      changedRoots.add(rootThreadId)
      return Array.from(changedRoots)
    }

    if (method === 'thread/status/changed') {
      const status = turnStatus(record?.status)
      if (threadId !== rootThreadId) {
        this.updateAgent(rootThreadId, threadId, atMs, (agent) => {
          if (status === 'active' && (agent.status === 'starting' || agent.status === 'running')) {
            agent.status = 'running'
          }
          if (status === 'idle' && (agent.status === 'starting' || agent.status === 'running')) {
            agent.status = 'completed'
            agent.completedAtMs = atMs
            agent.currentActivity = ''
            agent.resultAvailable = true
            this.addAgentTerminalEvent(progress, agent, atMs)
          }
        })
      }
      changedRoots.add(rootThreadId)
      return Array.from(changedRoots)
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(record?.item)
      const itemType = normalizeItemType(item?.type)
      const itemId = readString(item?.id)
      const eventAtMs = readNotificationAtMs(params, atMs, method === 'item/completed')

      if (itemType === 'subagentactivity') {
        const childThreadId = readString(item?.agentThreadId) || readString(item?.agent_thread_id)
        const path = readString(item?.agentPath) || readString(item?.agent_path)
        const kind = readString(item?.kind).toLowerCase()
        const sourceRootTurnId = threadId === rootThreadId
          ? readTurnId(params) || progress.turnId
          : progress.agentRootTurnIdByThreadId.get(threadId) || progress.turnId
        const sourceChildTurnId = threadId === rootThreadId ? '' : readTurnId(params)
        const activeSourceChildTurnId = threadId === rootThreadId
          ? ''
          : progress.agentTurnIdByThreadId.get(threadId) ?? ''
        const sourceChildNode = threadId === rootThreadId ? null : progress.agentsByThreadId.get(threadId)
        const sourceChildIsTerminal = sourceChildNode?.status === 'completed'
          || sourceChildNode?.status === 'interrupted'
          || sourceChildNode?.status === 'errored'
        const sourceChildTurnIsCurrent = !sourceChildTurnId
          || !activeSourceChildTurnId
          || sourceChildTurnId === activeSourceChildTurnId
        if (kind === 'started' && sourceChildIsTerminal && sourceChildTurnIsCurrent) {
          return Array.from(changedRoots)
        }
        if (
          sourceChildTurnId
          && activeSourceChildTurnId
          && sourceChildTurnId !== activeSourceChildTurnId
        ) return Array.from(changedRoots)
        const activeChildRootTurnId = childThreadId
          ? progress.agentRootTurnIdByThreadId.get(childThreadId) ?? ''
          : ''
        if (
          kind === 'started'
          && sourceRootTurnId
          && progress.terminalRootTurnAtMsByTurnId.has(sourceRootTurnId)
          && !(sourceRootTurnId === progress.turnId && progress.status === 'running')
        ) return Array.from(changedRoots)
        const targetsStaleRootTurn = Boolean(
          sourceRootTurnId
          && activeChildRootTurnId
          && sourceRootTurnId !== activeChildRootTurnId
          && sourceRootTurnId !== progress.turnId,
        )
        if (targetsStaleRootTurn) return Array.from(changedRoots)
        this.touchProgress(progress, threadId, eventAtMs)
        if (childThreadId && kind === 'started') {
          const childRoot = this.registerAgent(rootThreadId, threadId, childThreadId, path, eventAtMs)
          if (childRoot) {
            const childProgress = this.progressByRootThreadId.get(childRoot)
            const agent = childProgress?.agentsByThreadId.get(childThreadId)
            if (childProgress && agent) {
              if (sourceRootTurnId) {
                childProgress.agentRootTurnIdByThreadId.set(childThreadId, sourceRootTurnId)
              }
              this.addEvent(childProgress, {
                id: `agent:${childThreadId}:started:${itemId}`,
                atMs: eventAtMs,
                kind: 'agentStarted',
                threadId,
                agentThreadId: childThreadId,
                phase: null,
                detail: agent.path || childThreadId,
              })
              if (threadId === rootThreadId) this.setRootPhase(rootThreadId, 'dispatching', eventAtMs, `agent:${childThreadId}`)
              changedRoots.add(childRoot)
            }
          }
        } else if (childThreadId && kind === 'interrupted') {
          this.updateAgent(rootThreadId, childThreadId, eventAtMs, (agent) => {
            agent.status = 'interrupted'
            agent.completedAtMs = eventAtMs
            agent.currentActivity = ''
            this.addAgentTerminalEvent(progress, agent, eventAtMs)
          })
          changedRoots.add(rootThreadId)
        } else if (kind === 'interacted') {
          const sourceAgent = progress.agentsByThreadId.get(threadId)
          const targetAgent = progress.agentsByThreadId.get(childThreadId)
          const agent = sourceAgent ?? targetAgent
          if (agent) {
            agent.lastActivityAtMs = eventAtMs
            agent.currentActivity = 'communicating'
            this.addEvent(progress, {
              id: `agent:${agent.threadId}:interacted:${itemId}`,
              atMs: eventAtMs,
              kind: 'agentInteracted',
              threadId,
              agentThreadId: agent.threadId,
              phase: null,
              detail: agent.path || agent.threadId,
            })
          }
          changedRoots.add(rootThreadId)
        }
        return Array.from(changedRoots)
      }

      const sourceRootTurnIdForItem = threadId === rootThreadId
        ? readTurnId(params) || progress.turnId
        : progress.agentRootTurnIdByThreadId.get(threadId) || progress.turnId
      const sourceChildTurnIdForItem = threadId === rootThreadId ? '' : readTurnId(params)
      const activeSourceChildTurnIdForItem = threadId === rootThreadId
        ? ''
        : progress.agentTurnIdByThreadId.get(threadId) ?? ''
      const sourceChildNodeForItem = threadId === rootThreadId ? null : progress.agentsByThreadId.get(threadId)
      const sourceChildIsTerminalForItem = sourceChildNodeForItem?.status === 'completed'
        || sourceChildNodeForItem?.status === 'interrupted'
        || sourceChildNodeForItem?.status === 'errored'
      const sourceChildTurnIsCurrentForItem = !sourceChildTurnIdForItem
        || !activeSourceChildTurnIdForItem
        || sourceChildTurnIdForItem === activeSourceChildTurnIdForItem
      if (
        sourceChildTurnIdForItem
        && activeSourceChildTurnIdForItem
        && sourceChildTurnIdForItem !== activeSourceChildTurnIdForItem
      ) return Array.from(changedRoots)
      if (
        sourceRootTurnIdForItem
        && progress.turnId
        && sourceRootTurnIdForItem !== progress.turnId
      ) return Array.from(changedRoots)
      if (
        itemType === 'collabagenttoolcall'
        && readString(item?.tool).toLowerCase() === 'spawnagent'
        && sourceRootTurnIdForItem
        && progress.terminalRootTurnAtMsByTurnId.has(sourceRootTurnIdForItem)
        && !(sourceRootTurnIdForItem === progress.turnId && progress.status === 'running')
      ) return Array.from(changedRoots)
      if (
        itemType === 'collabagenttoolcall'
        && readString(item?.tool).toLowerCase() === 'spawnagent'
        && sourceChildIsTerminalForItem
        && sourceChildTurnIsCurrentForItem
      ) return Array.from(changedRoots)
      this.touchProgress(progress, threadId, eventAtMs)

      if (itemType === 'collabagenttoolcall') {
        const tool = readString(item?.tool).toLowerCase()
        const status = readString(item?.status).toLowerCase()
        if (tool === 'wait' && threadId === rootThreadId) {
          this.setRootPhase(rootThreadId, status === 'inprogress' ? 'waitingForAgents' : 'reasoning', eventAtMs, `wait:${itemId}:${status}`)
        }
        if (tool === 'spawnagent') {
          const receiverIds = Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds : []
          for (const receiverId of receiverIds) {
            const childThreadId = readString(receiverId)
            if (!childThreadId) continue
            const childRoot = this.registerAgent(rootThreadId, threadId, childThreadId, '', eventAtMs, {
              taskSummary: compactText(item?.prompt),
              model: readString(item?.model),
              reasoningEffort: readString(item?.reasoningEffort),
            })
            const childProgress = this.progressByRootThreadId.get(childRoot)
            const sourceRootTurnId = sourceRootTurnIdForItem
            if (childProgress?.agentsByThreadId.has(childThreadId) && sourceRootTurnId) {
              childProgress.agentRootTurnIdByThreadId.set(childThreadId, sourceRootTurnId)
            }
          }
          if (threadId === rootThreadId) this.setRootPhase(rootThreadId, 'dispatching', eventAtMs, `spawn:${itemId}`)
        }
        changedRoots.add(rootThreadId)
        return Array.from(changedRoots)
      }

      const phase = this.phaseForItemType(itemType)
      if (threadId === rootThreadId && phase) {
        this.setRootPhase(rootThreadId, phase, eventAtMs, `${itemType}:${itemId}:${method}`)
      } else if (threadId !== rootThreadId) {
        this.updateAgent(rootThreadId, threadId, eventAtMs, (agent) => {
          if (agent.status === 'starting' || agent.status === 'running') {
            agent.status = 'running'
            agent.currentActivity = phase ?? itemType
          }
          if (itemType === 'agentmessage' && method === 'item/completed') agent.resultAvailable = true
        })
      }
      changedRoots.add(rootThreadId)
      return Array.from(changedRoots)
    }

    const directPhase = this.phaseForMethod(method)
    if (threadId === rootThreadId && directPhase) {
      this.setRootPhase(rootThreadId, directPhase, atMs, method)
      changedRoots.add(rootThreadId)
    } else if (threadId !== rootThreadId && directPhase) {
      this.updateAgent(rootThreadId, threadId, atMs, (agent) => {
        if (agent.status === 'starting' || agent.status === 'running') {
          agent.status = 'running'
          agent.currentActivity = directPhase
        }
      })
      changedRoots.add(rootThreadId)
    }

    return Array.from(changedRoots)
  }

  ingestThreadRead(result: unknown, atMs = this.now()): string[] {
    const response = asRecord(result)
    const thread = asRecord(response?.thread) ?? asRecord(asRecord(response?.data)?.thread)
    if (!thread) return []
    const metadata = readThreadMetadata(thread)
    if (!metadata) return []
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const latestTurn = selectEffectiveThreadReadTurn(turns)
    if (!latestTurn) {
      const rootThreadId = this.registerThreadMetadata(metadata, atMs) || metadata.threadId
      return [rootThreadId]
    }
    const latestTurnId = readString(latestTurn.id)
    const status = turnStatus(latestTurn.status)
    const startedAtMs = readTurnStartedAtMs(latestTurn) || atMs
    const completedAtMs = readTurnCompletedAtMs(latestTurn)
    const eventAtMs = completedAtMs ?? startedAtMs
    const rootThreadId = this.registerThreadMetadata(metadata, startedAtMs) || metadata.threadId
    const incomingTurnIsRunning = isRunningTurnStatus(status)
    let ignoreReadState = false

    if (metadata.threadId === rootThreadId) {
      const progress = this.progressByRootThreadId.get(rootThreadId)
      const isDifferentTurn = Boolean(progress && latestTurnId && latestTurnId !== progress.turnId)
      if (progress && latestTurnId && !incomingTurnIsRunning) {
        this.recordRootTurnTerminal(progress, latestTurnId, eventAtMs)
      }
      if (progress && incomingTurnIsRunning) {
        const sameTurnIsTerminal = latestTurnId === progress.turnId
          && (progress.status === 'completed' || progress.status === 'interrupted' || progress.status === 'failed')
        const isKnownTerminalTurn = Boolean(
          latestTurnId
          && progress.terminalRootTurnAtMsByTurnId.has(latestTurnId)
          && !(latestTurnId === progress.turnId && progress.status === 'running')
        )
        const isOlderDifferentTurn = isDifferentTurn && (
          startedAtMs < progress.startedAtMs
          || (
            startedAtMs === progress.startedAtMs
            && readUuidV7TimestampMs(latestTurnId) !== null
            && readUuidV7TimestampMs(progress.turnId) !== null
            && latestTurnId < progress.turnId
          )
        )
        ignoreReadState = sameTurnIsTerminal || isKnownTerminalTurn || isOlderDifferentTurn
      } else if (progress && isDifferentTurn) {
        ignoreReadState = progress.status === 'running' || eventAtMs < progress.mainLastActivityAtMs
      }
      if (!ignoreReadState && (!progress || isDifferentTurn)) {
        this.startRootTurn(rootThreadId, latestTurnId, startedAtMs, 0)
      }
    } else {
      const progress = this.progressByRootThreadId.get(rootThreadId)
      const node = progress?.agentsByThreadId.get(metadata.threadId)
      if (progress && node) {
        const activeChildTurnId = progress.agentTurnIdByThreadId.get(metadata.threadId) ?? ''
        const isDifferentChildTurn = Boolean(
          latestTurnId
          && activeChildTurnId
          && latestTurnId !== activeChildTurnId,
        )
        const childTurnOrder = this.compareChildTurn(
          progress,
          metadata.threadId,
          latestTurnId,
          startedAtMs,
        )
        const nodeIsTerminal = node.status === 'completed' || node.status === 'interrupted' || node.status === 'errored'
        ignoreReadState = childTurnOrder === 'older'
          || (incomingTurnIsRunning && !isDifferentChildTurn && nodeIsTerminal)
      }
    }

    const hydratedTurns = selectOverlappingThreadReadTurns(turns, latestTurn)
    for (const hydratedTurn of ignoreReadState ? [] : hydratedTurns) {
      const hydratedTurnId = readString(hydratedTurn.id) || latestTurnId
      const hydratedStartedAtMs = readTurnStartedAtMs(hydratedTurn) || startedAtMs
      const hydratedCompletedAtMs = readTurnCompletedAtMs(hydratedTurn)
      const hydratedEventAtMs = hydratedCompletedAtMs ?? hydratedStartedAtMs
      for (const item of Array.isArray(hydratedTurn.items) ? hydratedTurn.items : []) {
        const itemRecord = asRecord(item)
        if (!itemRecord) continue
        this.handleNotification('item/completed', {
          threadId: metadata.threadId,
          turnId: hydratedTurnId,
          item: itemRecord,
          completedAtMs: hydratedEventAtMs,
        }, 0, hydratedEventAtMs)
      }
    }

    const progress = this.progressByRootThreadId.get(rootThreadId)
    if (!progress) return [rootThreadId]
    if (metadata.threadId === rootThreadId) {
      this.touchProgress(progress, rootThreadId, eventAtMs)
      if (incomingTurnIsRunning && !ignoreReadState) {
        progress.status = 'running'
        if (progress.phase === 'completed' || progress.phase === 'interrupted' || progress.phase === 'failed') {
          progress.phase = 'preparing'
        }
      } else if (status.includes('interrupt') || status.includes('cancel')) {
        if (!ignoreReadState && progress.status !== 'completed' && progress.status !== 'failed') {
          progress.status = 'interrupted'
          progress.phase = 'interrupted'
        }
      } else if (status.includes('fail') || status.includes('error')) {
        if (!ignoreReadState) {
          progress.status = 'failed'
          progress.phase = 'failed'
        }
      } else if (status.includes('complete')) {
        if (!ignoreReadState && progress.status !== 'failed') {
          progress.status = 'completed'
          progress.phase = 'completed'
        }
      }
      if (progress.status === 'completed' || progress.status === 'interrupted' || progress.status === 'failed') {
        this.recordRootTurnTerminal(progress, latestTurnId || progress.turnId, eventAtMs)
      }
    } else {
      const node = progress.agentsByThreadId.get(metadata.threadId)
      if (node) {
        const activeChildTurnId = progress.agentTurnIdByThreadId.get(metadata.threadId) ?? ''
        const isDifferentChildTurn = Boolean(
          latestTurnId
          && activeChildTurnId
          && latestTurnId !== activeChildTurnId,
        )
        const childTurnOrder = this.compareChildTurn(
          progress,
          metadata.threadId,
          latestTurnId,
          startedAtMs,
        )
        const switchesToNewerChildTurn = isDifferentChildTurn && childTurnOrder === 'newer'
        const nodeIsTerminal = node.status === 'completed' || node.status === 'interrupted' || node.status === 'errored'
        const ignoreChildReadState = childTurnOrder === 'older'
          || (incomingTurnIsRunning && !isDifferentChildTurn && nodeIsTerminal)
        if (latestTurnId && !ignoreChildReadState) {
          progress.agentTurnIdByThreadId.set(metadata.threadId, latestTurnId)
          progress.agentTurnStartedAtMsByThreadId.set(metadata.threadId, startedAtMs)
        }
        node.startedAtMs = Math.min(node.startedAtMs, startedAtMs)
        node.lastActivityAtMs = Math.max(node.lastActivityAtMs, eventAtMs)
        if (hydratedTurns.some((turn) => (
          Array.isArray(turn.items)
          && turn.items.some((item) => normalizeItemType(asRecord(item)?.type) === 'agentmessage')
        ))) node.resultAvailable = true
        if (!ignoreChildReadState && (status.includes('interrupt') || status.includes('cancel'))) {
          if (!switchesToNewerChildTurn && (node.status === 'completed' || node.status === 'errored')) {
            progress.updatedAtMs = Math.max(progress.updatedAtMs, eventAtMs)
            return [rootThreadId]
          }
          node.status = 'interrupted'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        } else if (!ignoreChildReadState && (status.includes('fail') || status.includes('error'))) {
          node.status = 'errored'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        } else if (!ignoreChildReadState && status.includes('complete')) {
          if (!switchesToNewerChildTurn && node.status === 'errored') {
            progress.updatedAtMs = Math.max(progress.updatedAtMs, eventAtMs)
            return [rootThreadId]
          }
          node.status = 'completed'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        }
        else if (incomingTurnIsRunning && !ignoreChildReadState) {
          node.status = 'running'
          node.completedAtMs = null
          node.currentActivity = 'working'
          if (isDifferentChildTurn) node.resultAvailable = false
        }
      }
    }
    progress.updatedAtMs = Math.max(progress.updatedAtMs, eventAtMs)
    return [rootThreadId]
  }

  applyRuntimeStates(rootThreadId: string, states: AgentRuntimeStateLike[], atMs = this.now()): void {
    let progress = this.progressByRootThreadId.get(rootThreadId)
    if (!progress) return
    let latestStateAtMs = progress.updatedAtMs
    for (const state of states) {
      const stateAtMs = readIsoMs(state.completedAtIso) ?? readIsoMs(state.startedAtIso) ?? atMs
      latestStateAtMs = Math.max(latestStateAtMs, stateAtMs)
      if (state.threadId === rootThreadId) {
        const runtimeTurnId = readString(state.turnId)
        if (runtimeTurnId && (state.state === 'completed' || state.state === 'interrupted')) {
          this.recordRootTurnTerminal(progress, runtimeTurnId, stateAtMs)
        }
        const fillsMissingTurnId = Boolean(runtimeTurnId && !progress.turnId)
        const isDifferentTurn = Boolean(runtimeTurnId && progress.turnId && runtimeTurnId !== progress.turnId)
        if (isDifferentTurn && state.state === 'running') {
          progress = this.startRootTurnPreservingAgents(
            rootThreadId,
            runtimeTurnId,
            readIsoMs(state.startedAtIso) ?? readUuidV7TimestampMs(runtimeTurnId) ?? stateAtMs,
          )
          latestStateAtMs = Math.max(latestStateAtMs, progress.updatedAtMs)
          continue
        }
        if (isDifferentTurn && state.state !== 'running' && stateAtMs < progress.mainLastActivityAtMs) continue
        if ((isDifferentTurn || fillsMissingTurnId) && runtimeTurnId) {
          progress.turnId = runtimeTurnId
          const runtimeStartedAtMs = readIsoMs(state.startedAtIso) ?? readUuidV7TimestampMs(runtimeTurnId)
          if (runtimeStartedAtMs !== null) progress.startedAtMs = runtimeStartedAtMs
        }
        if (
          state.state === 'running'
          && (
            fillsMissingTurnId
            || (progress.status !== 'completed' && progress.status !== 'failed')
          )
        ) {
          progress.status = 'running'
          if (progress.phase === 'interrupted' || progress.phase === 'completed' || progress.phase === 'failed') {
            progress.phase = 'preparing'
          }
        }
        if (state.state === 'completed' && (isDifferentTurn || progress.status !== 'failed')) {
          progress.status = 'completed'
          progress.phase = 'completed'
          progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, stateAtMs)
          progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, stateAtMs)
        }
        if (
          state.state === 'interrupted'
          && (
            isDifferentTurn
            || progress.status === 'running'
            || progress.status === 'idle'
            || (fillsMissingTurnId && stateAtMs >= progress.updatedAtMs)
          )
        ) {
          progress.status = 'interrupted'
          progress.phase = 'interrupted'
          progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, stateAtMs)
          progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, stateAtMs)
        }
        continue
      }
      const node = progress.agentsByThreadId.get(state.threadId)
      if (!node) continue
      const runtimeChildTurnId = readString(state.turnId)
      const activeChildTurnId = progress.agentTurnIdByThreadId.get(state.threadId) ?? ''
      const runtimeChildStartedAtMs = readIsoMs(state.startedAtIso) ?? readUuidV7TimestampMs(runtimeChildTurnId)
      const isDifferentChildTurn = Boolean(
        runtimeChildTurnId
        && activeChildTurnId
        && runtimeChildTurnId !== activeChildTurnId,
      )
      const childTurnOrder = this.compareChildTurn(
        progress,
        state.threadId,
        runtimeChildTurnId,
        runtimeChildStartedAtMs,
      )
      const switchesToNewerChildTurn = isDifferentChildTurn && childTurnOrder === 'newer'
      if (isDifferentChildTurn && childTurnOrder === 'older') continue
      if (isDifferentChildTurn && childTurnOrder === 'unknown' && state.state !== 'running') continue
      if (runtimeChildTurnId) {
        progress.agentTurnIdByThreadId.set(state.threadId, runtimeChildTurnId)
        if (runtimeChildStartedAtMs !== null) {
          progress.agentTurnStartedAtMsByThreadId.set(state.threadId, runtimeChildStartedAtMs)
        }
      }
      node.lastActivityAtMs = Math.max(node.lastActivityAtMs, stateAtMs)
      if (
        state.state === 'running'
        && (
          isDifferentChildTurn
          || (node.status !== 'completed' && node.status !== 'errored')
        )
      ) {
        node.status = 'running'
        node.completedAtMs = null
        node.currentActivity = 'working'
        if (isDifferentChildTurn) node.resultAvailable = false
      }
      if (state.state === 'completed' && (switchesToNewerChildTurn || node.status !== 'errored')) {
        node.status = 'completed'
        node.completedAtMs = stateAtMs
        node.currentActivity = ''
        node.resultAvailable = true
      }
      if (
        state.state === 'interrupted'
        && (switchesToNewerChildTurn || node.status === 'starting' || node.status === 'running')
      ) {
        node.status = 'interrupted'
        node.completedAtMs = stateAtMs
        node.currentActivity = ''
      }
    }
    progress.updatedAtMs = latestStateAtMs
  }

  markProcessExit(atMs = this.now()): string[] {
    const changed: string[] = []
    for (const progress of this.progressByRootThreadId.values()) {
      if (progress.status !== 'running') continue
      progress.status = 'interrupted'
      progress.phase = 'interrupted'
      progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, atMs)
      progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, atMs)
      progress.updatedAtMs = Math.max(progress.updatedAtMs, atMs)
      this.recordRootTurnTerminal(progress, progress.turnId, atMs)
      for (const agent of progress.agentsByThreadId.values()) {
        if (agent.status !== 'starting' && agent.status !== 'running') continue
        agent.status = 'interrupted'
        agent.completedAtMs = atMs
        agent.lastActivityAtMs = Math.max(agent.lastActivityAtMs, atMs)
      }
      changed.push(progress.rootThreadId)
    }
    return changed
  }

  getSnapshot(rootThreadId: string): AgentProgressSnapshot | null {
    const root = this.rootByThreadId.get(rootThreadId) ?? rootThreadId
    const progress = this.progressByRootThreadId.get(root)
    if (!progress) return null
    const agents = Array.from(progress.agentsByThreadId.values())
      .sort((first, second) => first.depth - second.depth || first.startedAtMs - second.startedAtMs || first.threadId.localeCompare(second.threadId))
      .map((agent) => ({ ...agent }))
    return {
      rootThreadId: progress.rootThreadId,
      turnId: progress.turnId,
      status: progress.status,
      phase: progress.phase,
      startedAtMs: progress.startedAtMs,
      lastActivityAtMs: progress.lastActivityAtMs,
      mainLastActivityAtMs: progress.mainLastActivityAtMs,
      updatedAtMs: progress.updatedAtMs,
      agents,
      events: progress.events.map((event) => ({ ...event })),
    }
  }

  getDirectChildThreadIds(parentThreadId: string): string[] {
    const rootThreadId = this.rootByThreadId.get(parentThreadId) ?? parentThreadId
    const progress = this.progressByRootThreadId.get(rootThreadId)
    if (!progress) return []
    return Array.from(progress.agentsByThreadId.values())
      .filter((agent) => agent.parentThreadId === parentThreadId)
      .map((agent) => agent.threadId)
  }

  getAgentThreadIds(rootThreadId: string): string[] {
    const snapshot = this.getSnapshot(rootThreadId)
    return snapshot?.agents.map((agent) => agent.threadId) ?? []
  }

  applyAgentModelDetails(rootThreadId: string, details: AgentSessionModelDetails[]): boolean {
    const root = this.rootByThreadId.get(rootThreadId) ?? rootThreadId
    const progress = this.progressByRootThreadId.get(root)
    if (!progress) return false
    let changed = false
    for (const detail of details) {
      if (this.rootByThreadId.get(detail.threadId) !== root) continue
      const agent = progress.agentsByThreadId.get(detail.threadId)
      if (!agent) continue
      const model = readString(detail.model)
      const reasoningEffort = readString(detail.reasoningEffort)
      if (model && agent.model !== model) {
        agent.model = model
        changed = true
      }
      if (reasoningEffort && agent.reasoningEffort !== reasoningEffort) {
        agent.reasoningEffort = reasoningEffort
        changed = true
      }
    }
    return changed
  }

  private compareChildTurn(
    progress: MutableProgress,
    threadId: string,
    incomingTurnId: string,
    incomingStartedAtMs: number | null,
  ): 'same' | 'older' | 'newer' | 'unknown' {
    const activeTurnId = progress.agentTurnIdByThreadId.get(threadId) ?? ''
    if (!incomingTurnId || !activeTurnId) return 'unknown'
    if (incomingTurnId === activeTurnId) return 'same'
    const activeStartedAtMs = progress.agentTurnStartedAtMsByThreadId.get(threadId)
    if (incomingStartedAtMs === null || activeStartedAtMs === undefined) return 'unknown'
    return incomingStartedAtMs > activeStartedAtMs ? 'newer' : 'older'
  }

  private recordRootTurnTerminal(progress: MutableProgress, turnId: string, atMs: number): void {
    if (!turnId) return
    progress.terminalRootTurnAtMsByTurnId.delete(turnId)
    progress.terminalRootTurnAtMsByTurnId.set(turnId, atMs)
    const limit = Math.max(8, Math.min(this.eventLimit, 64))
    while (progress.terminalRootTurnAtMsByTurnId.size > limit) {
      const oldestTurnId = progress.terminalRootTurnAtMsByTurnId.keys().next().value
      if (typeof oldestTurnId !== 'string') break
      progress.terminalRootTurnAtMsByTurnId.delete(oldestTurnId)
    }
  }

  private ensureProgress(rootThreadId: string, atMs: number, generation: number): MutableProgress {
    const existing = this.progressByRootThreadId.get(rootThreadId)
    if (existing) return existing
    const created: MutableProgress = {
      rootThreadId,
      turnId: '',
      status: 'idle',
      phase: 'preparing',
      startedAtMs: atMs,
      lastActivityAtMs: atMs,
      mainLastActivityAtMs: atMs,
      updatedAtMs: atMs,
      agentsByThreadId: new Map(),
      agentRootTurnIdByThreadId: new Map(),
      agentTurnIdByThreadId: new Map(),
      agentTurnStartedAtMsByThreadId: new Map(),
      terminalRootTurnAtMsByTurnId: new Map(),
      events: [],
      seenEventKeys: new Set(),
      seenEventOrder: [],
    }
    void generation
    this.rootByThreadId.set(rootThreadId, rootThreadId)
    this.progressByRootThreadId.set(rootThreadId, created)
    return created
  }

  private startRootTurn(rootThreadId: string, turnId: string, atMs: number, generation: number): MutableProgress {
    const existing = this.progressByRootThreadId.get(rootThreadId)
    if (existing && existing.turnId === turnId) {
      if (existing.status === 'running') {
        existing.lastActivityAtMs = Math.max(existing.lastActivityAtMs, atMs)
        existing.mainLastActivityAtMs = Math.max(existing.mainLastActivityAtMs, atMs)
        existing.updatedAtMs = Math.max(existing.updatedAtMs, atMs)
      }
      return existing
    }
    if (existing) {
      for (const agent of existing.agentsByThreadId.values()) this.rootByThreadId.delete(agent.threadId)
    }
    const progress: MutableProgress = {
      rootThreadId,
      turnId,
      status: 'running',
      phase: 'preparing',
      startedAtMs: atMs,
      lastActivityAtMs: atMs,
      mainLastActivityAtMs: atMs,
      updatedAtMs: atMs,
      agentsByThreadId: new Map(),
      agentRootTurnIdByThreadId: new Map(),
      agentTurnIdByThreadId: new Map(),
      agentTurnStartedAtMsByThreadId: new Map(),
      terminalRootTurnAtMsByTurnId: existing?.terminalRootTurnAtMsByTurnId ?? new Map(),
      events: [],
      seenEventKeys: new Set(),
      seenEventOrder: [],
    }
    void generation
    this.rootByThreadId.set(rootThreadId, rootThreadId)
    this.progressByRootThreadId.set(rootThreadId, progress)
    return progress
  }

  private startRootTurnPreservingAgents(rootThreadId: string, turnId: string, atMs: number): MutableProgress {
    const existing = this.progressByRootThreadId.get(rootThreadId)
    const preservedAgents = existing
      ? Array.from(existing.agentsByThreadId.values()).filter((agent) => (
          existing.agentRootTurnIdByThreadId.get(agent.threadId) === turnId
        ))
      : []
    const progress = this.startRootTurn(rootThreadId, turnId, atMs, 0)
    for (const agent of preservedAgents) {
      progress.agentsByThreadId.set(agent.threadId, agent)
      progress.agentRootTurnIdByThreadId.set(agent.threadId, turnId)
      const childTurnId = existing?.agentTurnIdByThreadId.get(agent.threadId)
      if (childTurnId) progress.agentTurnIdByThreadId.set(agent.threadId, childTurnId)
      const childTurnStartedAtMs = existing?.agentTurnStartedAtMsByThreadId.get(agent.threadId)
      if (childTurnStartedAtMs !== undefined) {
        progress.agentTurnStartedAtMsByThreadId.set(agent.threadId, childTurnStartedAtMs)
      }
      progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, agent.lastActivityAtMs)
      progress.updatedAtMs = Math.max(progress.updatedAtMs, agent.lastActivityAtMs)
      this.rootByThreadId.set(agent.threadId, rootThreadId)
    }
    return progress
  }

  private registerThreadMetadata(metadata: NonNullable<ReturnType<typeof readThreadMetadata>>, atMs: number): string {
    if (!metadata.parentThreadId) {
      this.rootByThreadId.set(metadata.threadId, metadata.threadId)
      this.ensureProgress(metadata.threadId, atMs, 0)
      return metadata.threadId
    }
    const rootThreadId = this.rootByThreadId.get(metadata.parentThreadId) ?? metadata.parentThreadId
    const progressBeforeRegistration = this.progressByRootThreadId.get(rootThreadId)
    const hadAgent = progressBeforeRegistration?.agentsByThreadId.has(metadata.threadId) === true
    const rootWasTerminal = progressBeforeRegistration?.status === 'completed'
      || progressBeforeRegistration?.status === 'interrupted'
      || progressBeforeRegistration?.status === 'failed'
    this.registerAgent(rootThreadId, metadata.parentThreadId, metadata.threadId, metadata.path, atMs, {
      nickname: metadata.nickname,
      ...(metadata.depth === null ? {} : { depth: metadata.depth }),
    })
    const progress = this.progressByRootThreadId.get(rootThreadId)
    const registeredAgent = progress?.agentsByThreadId.get(metadata.threadId)
    if (registeredAgent && !hadAgent && rootWasTerminal) {
      registeredAgent.status = 'interrupted'
      registeredAgent.completedAtMs = atMs
      registeredAgent.currentActivity = ''
    }
    if (
      progress?.agentsByThreadId.has(metadata.threadId)
      && !progress.agentRootTurnIdByThreadId.has(metadata.threadId)
    ) {
      const sourceRootTurnId = progress.agentRootTurnIdByThreadId.get(metadata.parentThreadId) || progress.turnId
      if (sourceRootTurnId) progress.agentRootTurnIdByThreadId.set(metadata.threadId, sourceRootTurnId)
    }
    this.migrateOrphanProgress(metadata.threadId, rootThreadId, atMs)
    return rootThreadId
  }

  private discardOrphanProgress(threadId: string, orphan: MutableProgress): void {
    for (const orphanAgent of orphan.agentsByThreadId.values()) {
      if (this.rootByThreadId.get(orphanAgent.threadId) === threadId) {
        this.rootByThreadId.delete(orphanAgent.threadId)
      }
    }
    this.progressByRootThreadId.delete(threadId)
    if (this.rootByThreadId.get(threadId) === threadId) this.rootByThreadId.delete(threadId)
  }

  private migrateOrphanProgress(threadId: string, rootThreadId: string, atMs: number): void {
    if (threadId === rootThreadId) return
    const orphan = this.progressByRootThreadId.get(threadId)
    if (!orphan) return
    const target = this.ensureProgress(rootThreadId, atMs, 0)
    const node = target.agentsByThreadId.get(threadId)
    if (!node) {
      this.discardOrphanProgress(threadId, orphan)
      return
    }
    const activeChildTurnId = target.agentTurnIdByThreadId.get(threadId) ?? ''
    if (
      orphan.turnId
      && activeChildTurnId
      && orphan.turnId !== activeChildTurnId
      && this.compareChildTurn(target, threadId, orphan.turnId, orphan.startedAtMs) !== 'newer'
    ) {
      this.discardOrphanProgress(threadId, orphan)
      return
    }
    node.startedAtMs = Math.min(node.startedAtMs, orphan.startedAtMs)
    node.lastActivityAtMs = Math.max(node.lastActivityAtMs, orphan.lastActivityAtMs)
    const targetNodeIsTerminal = node.status === 'completed' || node.status === 'interrupted' || node.status === 'errored'
    const orphanIsRunning = orphan.status === 'running' || orphan.status === 'idle'
    const orphanMatchesActiveTurn = !orphan.turnId
      || !activeChildTurnId
      || orphan.turnId === activeChildTurnId
    const preservesTargetTerminal = targetNodeIsTerminal && orphanIsRunning && orphanMatchesActiveTurn
    node.completedAtMs = orphan.status === 'running' || orphan.status === 'idle'
      ? node.completedAtMs
      : orphan.lastActivityAtMs
    if (!preservesTargetTerminal) {
      node.status = orphan.status === 'completed'
        ? 'completed'
        : orphan.status === 'interrupted'
          ? 'interrupted'
          : orphan.status === 'failed'
            ? 'errored'
            : 'running'
      node.currentActivity = node.status === 'running' ? orphan.phase : ''
    }
    node.resultAvailable = node.resultAvailable || orphan.status === 'completed'
    if (orphan.turnId) {
      target.agentTurnIdByThreadId.set(threadId, orphan.turnId)
      target.agentTurnStartedAtMsByThreadId.set(threadId, orphan.startedAtMs)
    }
    const orphanAgents = Array.from(orphan.agentsByThreadId.values())
      .sort((first, second) => first.depth - second.depth || first.startedAtMs - second.startedAtMs)
    for (const orphanAgent of orphanAgents) {
      if (target.agentsByThreadId.size >= this.nodeLimit && !target.agentsByThreadId.has(orphanAgent.threadId)) break
      const parent = target.agentsByThreadId.get(orphanAgent.parentThreadId)
      target.agentsByThreadId.set(orphanAgent.threadId, {
        ...orphanAgent,
        depth: parent ? parent.depth + 1 : Math.max(2, orphanAgent.depth + (node?.depth ?? 1)),
      })
      const sourceRootTurnId = orphan.agentRootTurnIdByThreadId.get(orphanAgent.threadId)
        || target.agentRootTurnIdByThreadId.get(threadId)
        || target.turnId
      if (sourceRootTurnId) target.agentRootTurnIdByThreadId.set(orphanAgent.threadId, sourceRootTurnId)
      const childTurnId = orphan.agentTurnIdByThreadId.get(orphanAgent.threadId)
      if (childTurnId) target.agentTurnIdByThreadId.set(orphanAgent.threadId, childTurnId)
      const childTurnStartedAtMs = orphan.agentTurnStartedAtMsByThreadId.get(orphanAgent.threadId)
      if (childTurnStartedAtMs !== undefined) {
        target.agentTurnStartedAtMsByThreadId.set(orphanAgent.threadId, childTurnStartedAtMs)
      }
      this.rootByThreadId.set(orphanAgent.threadId, rootThreadId)
    }
    for (const orphanAgent of orphanAgents) {
      if (this.rootByThreadId.get(orphanAgent.threadId) === threadId) {
        this.rootByThreadId.delete(orphanAgent.threadId)
      }
    }
    for (const event of orphan.events) this.addEvent(target, { ...event })
    target.lastActivityAtMs = Math.max(target.lastActivityAtMs, orphan.lastActivityAtMs)
    target.updatedAtMs = Math.max(target.updatedAtMs, orphan.updatedAtMs, atMs)
    this.progressByRootThreadId.delete(threadId)
    this.rootByThreadId.set(threadId, rootThreadId)
  }

  private registerAgent(
    rootThreadId: string,
    parentThreadId: string,
    threadId: string,
    path: string,
    atMs: number,
    details: Partial<Pick<AgentProgressNode, 'nickname' | 'depth' | 'taskSummary' | 'model' | 'reasoningEffort'>> = {},
  ): string {
    const progress = this.ensureProgress(rootThreadId, atMs, 0)
    const existing = progress.agentsByThreadId.get(threadId)
    const parent = progress.agentsByThreadId.get(parentThreadId)
    const depth = details.depth ?? (parent ? parent.depth + 1 : 1)
    if (!existing && progress.agentsByThreadId.size >= this.nodeLimit) return rootThreadId
    const agent: AgentProgressNode = existing ?? {
      threadId,
      parentThreadId,
      path,
      nickname: '',
      depth,
      taskSummary: '',
      model: '',
      reasoningEffort: '',
      status: 'starting',
      startedAtMs: atMs,
      lastActivityAtMs: atMs,
      completedAtMs: null,
      currentActivity: 'starting',
      resultAvailable: false,
    }
    agent.parentThreadId = parentThreadId || agent.parentThreadId
    agent.path = path || agent.path
    agent.nickname = details.nickname || agent.nickname
    agent.depth = Math.max(1, depth)
    agent.taskSummary = details.taskSummary || agent.taskSummary
    agent.model = details.model || agent.model
    agent.reasoningEffort = details.reasoningEffort || agent.reasoningEffort
    agent.lastActivityAtMs = Math.max(agent.lastActivityAtMs, atMs)
    if (!existing || agent.status === 'starting' || agent.status === 'running') {
      agent.status = 'running'
      agent.currentActivity = 'working'
    }
    progress.agentsByThreadId.set(threadId, agent)
    this.rootByThreadId.set(threadId, rootThreadId)
    this.touchProgress(progress, threadId, atMs)
    return rootThreadId
  }

  private updateAgent(rootThreadId: string, threadId: string, atMs: number, update: (agent: AgentProgressNode) => void): void {
    const progress = this.ensureProgress(rootThreadId, atMs, 0)
    let agent = progress.agentsByThreadId.get(threadId)
    if (!agent) {
      this.registerAgent(rootThreadId, rootThreadId, threadId, '', atMs)
      agent = progress.agentsByThreadId.get(threadId)
    }
    if (!agent) return
    agent.lastActivityAtMs = Math.max(agent.lastActivityAtMs, atMs)
    update(agent)
    this.touchProgress(progress, threadId, atMs)
  }

  private touchProgress(progress: MutableProgress, threadId: string, atMs: number): void {
    progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, atMs)
    progress.updatedAtMs = Math.max(progress.updatedAtMs, atMs)
    if (threadId === progress.rootThreadId) progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, atMs)
  }

  private setRootPhase(rootThreadId: string, phase: AgentProgressPhase, atMs: number, eventId: string): void {
    const progress = this.ensureProgress(rootThreadId, atMs, 0)
    const progressIsTerminal = progress.status === 'completed'
      || progress.status === 'interrupted'
      || progress.status === 'failed'
    const phaseIsTerminal = phase === 'completed' || phase === 'interrupted' || phase === 'failed'
    if (progressIsTerminal && !phaseIsTerminal) return
    this.touchProgress(progress, rootThreadId, atMs)
    if (progress.phase === phase && phase !== 'waitingForAgents') return
    progress.phase = phase
    if (phase !== 'completed' && phase !== 'interrupted' && phase !== 'failed') progress.status = 'running'
    this.addEvent(progress, {
      id: `phase:${eventId}`,
      atMs,
      kind: 'phaseChanged',
      threadId: rootThreadId,
      agentThreadId: '',
      phase,
      detail: phase,
    })
  }

  private addAgentTerminalEvent(progress: MutableProgress, agent: AgentProgressNode, atMs: number): void {
    const kind = agent.status === 'completed'
      ? 'agentCompleted'
      : agent.status === 'interrupted'
        ? 'agentInterrupted'
        : 'agentErrored'
    this.addEvent(progress, {
      id: `agent:${agent.threadId}:${agent.status}`,
      atMs,
      kind,
      threadId: agent.parentThreadId,
      agentThreadId: agent.threadId,
      phase: null,
      detail: agent.path || agent.nickname || agent.threadId,
    })
  }

  private addEvent(progress: MutableProgress, event: AgentProgressEvent): void {
    const key = event.id
    if (progress.seenEventKeys.has(key)) return
    progress.seenEventKeys.add(key)
    progress.seenEventOrder.push(key)
    progress.events.push(event)
    while (progress.events.length > this.eventLimit) progress.events.shift()
    while (progress.seenEventOrder.length > this.eventLimit * 2) {
      const removed = progress.seenEventOrder.shift()
      if (removed) progress.seenEventKeys.delete(removed)
    }
  }

  private phaseForItemType(itemType: string): AgentProgressPhase | null {
    if (itemType === 'reasoning') return 'reasoning'
    if (itemType === 'agentmessage') return 'summarizing'
    if (itemType === 'commandexecution' || itemType === 'mcptoolcall' || itemType === 'dynamictoolcall') return 'executing'
    if (itemType === 'filechange') return 'applyingChanges'
    return null
  }

  private phaseForMethod(method: string): AgentProgressPhase | null {
    if (method.includes('/reasoning/')) return 'reasoning'
    if (method === 'item/agentMessage/delta') return 'summarizing'
    if (method.includes('/commandExecution/') || method.includes('/mcpToolCall/')) return 'executing'
    if (method.includes('/fileChange/')) return 'applyingChanges'
    return null
  }
}
