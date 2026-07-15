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
  state: 'running' | 'completed' | 'interrupted' | 'idle'
  startedAtIso?: string | null
  completedAtIso?: string | null
}

type MutableProgress = Omit<AgentProgressSnapshot, 'agents' | 'events'> & {
  agentsByThreadId: Map<string, AgentProgressNode>
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
    }

    const threadId = readThreadId(params)
    if (!threadId) return Array.from(changedRoots)
    const rootThreadId = this.rootByThreadId.get(threadId) ?? threadId

    if (method === 'turn/started') {
      const turnId = readTurnId(params)
      const startedAtMs = readNotificationAtMs(params, atMs)
      if (threadId === rootThreadId) {
        this.startRootTurn(rootThreadId, turnId, startedAtMs, generation)
        this.setRootPhase(rootThreadId, 'preparing', startedAtMs, 'turn-started')
      } else {
        this.updateAgent(rootThreadId, threadId, startedAtMs, (agent) => {
          agent.status = 'running'
          agent.currentActivity = 'working'
        })
      }
      changedRoots.add(rootThreadId)
      return Array.from(changedRoots)
    }

    const progress = this.ensureProgress(rootThreadId, atMs, generation)

    if (method === 'turn/completed') {
      const completedAtMs = readNotificationAtMs(params, atMs, true)
      const status = turnStatus(asRecord(record?.turn)?.status)
      if (threadId === rootThreadId) {
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
          if (status === 'active') agent.status = 'running'
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
      this.touchProgress(progress, threadId, eventAtMs)

      if (itemType === 'subagentactivity') {
        const childThreadId = readString(item?.agentThreadId) || readString(item?.agent_thread_id)
        const path = readString(item?.agentPath) || readString(item?.agent_path)
        const kind = readString(item?.kind).toLowerCase()
        if (childThreadId && kind === 'started') {
          const childRoot = this.registerAgent(rootThreadId, threadId, childThreadId, path, eventAtMs)
          if (childRoot) {
            const childProgress = this.progressByRootThreadId.get(childRoot)
            const agent = childProgress?.agentsByThreadId.get(childThreadId)
            if (childProgress && agent) {
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
            this.registerAgent(rootThreadId, threadId, childThreadId, '', eventAtMs, {
              taskSummary: compactText(item?.prompt),
              model: readString(item?.model),
              reasoningEffort: readString(item?.reasoningEffort),
            })
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
          agent.status = 'running'
          agent.currentActivity = phase ?? itemType
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
        agent.status = 'running'
        agent.currentActivity = directPhase
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
    const latestTurn = asRecord(turns.at(-1))
    if (!latestTurn) {
      const rootThreadId = this.registerThreadMetadata(metadata, atMs) || metadata.threadId
      return [rootThreadId]
    }
    const latestTurnId = readString(latestTurn.id)
    const status = turnStatus(latestTurn.status)
    const startedAtMs = readEpochMs(latestTurn.startedAtMs)
      ?? readEpochMs(latestTurn.startedAt)
      ?? atMs
    const completedAtMs = readEpochMs(latestTurn.completedAtMs)
      ?? readEpochMs(latestTurn.completedAt)
    const eventAtMs = completedAtMs ?? (status.includes('progress') || status === 'running' ? atMs : startedAtMs)
    const rootThreadId = this.registerThreadMetadata(metadata, startedAtMs) || metadata.threadId

    if (metadata.threadId === rootThreadId) {
      const progress = this.progressByRootThreadId.get(rootThreadId)
      if (!progress || (latestTurnId && progress.turnId !== latestTurnId)) {
        this.startRootTurn(rootThreadId, latestTurnId, startedAtMs, 0)
      }
    }

    const items = Array.isArray(latestTurn.items) ? latestTurn.items : []
    for (const item of items) {
      const itemRecord = asRecord(item)
      if (!itemRecord) continue
      this.handleNotification('item/completed', {
        threadId: metadata.threadId,
        turnId: latestTurnId,
        item: itemRecord,
        completedAtMs: eventAtMs,
      }, 0, eventAtMs)
    }

    const progress = this.progressByRootThreadId.get(rootThreadId)
    if (!progress) return [rootThreadId]
    if (metadata.threadId === rootThreadId) {
      this.touchProgress(progress, rootThreadId, eventAtMs)
      if (status.includes('progress') || status === 'running') {
        progress.status = 'running'
      } else if (status.includes('interrupt') || status.includes('cancel')) {
        progress.status = 'interrupted'
        progress.phase = 'interrupted'
      } else if (status.includes('fail') || status.includes('error')) {
        progress.status = 'failed'
        progress.phase = 'failed'
      } else if (status.includes('complete')) {
        progress.status = 'completed'
        progress.phase = 'completed'
      }
    } else {
      const node = progress.agentsByThreadId.get(metadata.threadId)
      if (node) {
        node.startedAtMs = Math.min(node.startedAtMs, startedAtMs)
        node.lastActivityAtMs = Math.max(node.lastActivityAtMs, eventAtMs)
        if (items.some((item) => normalizeItemType(asRecord(item)?.type) === 'agentmessage')) node.resultAvailable = true
        if (status.includes('interrupt') || status.includes('cancel')) {
          node.status = 'interrupted'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        } else if (status.includes('fail') || status.includes('error')) {
          node.status = 'errored'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        } else if (status.includes('complete')) {
          node.status = 'completed'
          node.completedAtMs = completedAtMs ?? eventAtMs
          node.currentActivity = ''
        }
        else if (status.includes('progress') || status === 'running') node.status = 'running'
      }
    }
    progress.updatedAtMs = Math.max(progress.updatedAtMs, eventAtMs)
    return [rootThreadId]
  }

  applyRuntimeStates(rootThreadId: string, states: AgentRuntimeStateLike[], atMs = this.now()): void {
    const progress = this.progressByRootThreadId.get(rootThreadId)
    if (!progress) return
    let latestStateAtMs = progress.updatedAtMs
    for (const state of states) {
      const stateAtMs = readIsoMs(state.completedAtIso) ?? readIsoMs(state.startedAtIso) ?? atMs
      latestStateAtMs = Math.max(latestStateAtMs, stateAtMs)
      if (state.threadId === rootThreadId) {
        if (state.state === 'running') progress.status = 'running'
        if (state.state === 'completed') {
          progress.status = 'completed'
          progress.phase = 'completed'
          progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, stateAtMs)
          progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, stateAtMs)
        }
        if (state.state === 'interrupted') {
          progress.status = 'interrupted'
          progress.phase = 'interrupted'
          progress.lastActivityAtMs = Math.max(progress.lastActivityAtMs, stateAtMs)
          progress.mainLastActivityAtMs = Math.max(progress.mainLastActivityAtMs, stateAtMs)
        }
        continue
      }
      const node = progress.agentsByThreadId.get(state.threadId)
      if (!node) continue
      node.lastActivityAtMs = Math.max(node.lastActivityAtMs, stateAtMs)
      if (state.state === 'running') node.status = 'running'
      if (state.state === 'completed') {
        node.status = 'completed'
        node.completedAtMs = stateAtMs
        node.currentActivity = ''
        node.resultAvailable = true
      }
      if (state.state === 'interrupted') {
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
    if (existing && existing.turnId === turnId && existing.status === 'running') {
      existing.lastActivityAtMs = Math.max(existing.lastActivityAtMs, atMs)
      existing.mainLastActivityAtMs = Math.max(existing.mainLastActivityAtMs, atMs)
      existing.updatedAtMs = Math.max(existing.updatedAtMs, atMs)
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
      events: [],
      seenEventKeys: new Set(),
      seenEventOrder: [],
    }
    void generation
    this.rootByThreadId.set(rootThreadId, rootThreadId)
    this.progressByRootThreadId.set(rootThreadId, progress)
    return progress
  }

  private registerThreadMetadata(metadata: NonNullable<ReturnType<typeof readThreadMetadata>>, atMs: number): string {
    if (!metadata.parentThreadId) {
      this.rootByThreadId.set(metadata.threadId, metadata.threadId)
      this.ensureProgress(metadata.threadId, atMs, 0)
      return metadata.threadId
    }
    const rootThreadId = this.rootByThreadId.get(metadata.parentThreadId) ?? metadata.parentThreadId
    this.registerAgent(rootThreadId, metadata.parentThreadId, metadata.threadId, metadata.path, atMs, {
      nickname: metadata.nickname,
      ...(metadata.depth === null ? {} : { depth: metadata.depth }),
    })
    this.migrateOrphanProgress(metadata.threadId, rootThreadId, atMs)
    return rootThreadId
  }

  private migrateOrphanProgress(threadId: string, rootThreadId: string, atMs: number): void {
    if (threadId === rootThreadId) return
    const orphan = this.progressByRootThreadId.get(threadId)
    if (!orphan) return
    const target = this.ensureProgress(rootThreadId, atMs, 0)
    const node = target.agentsByThreadId.get(threadId)
    if (node) {
      node.startedAtMs = Math.min(node.startedAtMs, orphan.startedAtMs)
      node.lastActivityAtMs = Math.max(node.lastActivityAtMs, orphan.lastActivityAtMs)
      node.completedAtMs = orphan.status === 'running' || orphan.status === 'idle'
        ? node.completedAtMs
        : orphan.lastActivityAtMs
      node.status = orphan.status === 'completed'
        ? 'completed'
        : orphan.status === 'interrupted'
          ? 'interrupted'
          : orphan.status === 'failed'
            ? 'errored'
            : 'running'
      node.currentActivity = node.status === 'running' ? orphan.phase : ''
      node.resultAvailable = node.resultAvailable || orphan.status === 'completed'
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
      this.rootByThreadId.set(orphanAgent.threadId, rootThreadId)
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
    if (agent.status === 'completed' || agent.status === 'interrupted' || agent.status === 'errored') {
      agent.completedAtMs = null
      agent.resultAvailable = false
    }
    agent.status = 'running'
    agent.currentActivity = 'working'
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
