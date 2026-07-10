import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'

export type ThreadRuntimeStateKind = 'running' | 'completed' | 'interrupted' | 'idle'

export type ThreadRuntimeOwner = {
  instanceId: string
  processId: number
  processIdentity: string
  port: number | null
  local: boolean
  heartbeatAtIso: string
}

export type ThreadRuntimeStateSnapshot = {
  threadId: string
  turnId: string
  state: ThreadRuntimeStateKind
  isRunning: boolean
  source: 'session' | 'local' | 'external' | 'none'
  startedAtIso: string | null
  completedAtIso: string | null
  owner: ThreadRuntimeOwner | null
}

export type SessionRuntimeTurn = {
  turnId: string
  startedAtMs: number
  completedAtMs: number | null
  startOrder: number
}

export type SessionRuntimeSnapshot = {
  latestTurnId: string
  turns: SessionRuntimeTurn[]
}

export type RuntimeTurnEvidence = {
  threadId: string
  turnId: string
  startedAtMs: number
  completedAtMs: number | null
  status: 'running' | 'completed' | 'interrupted'
}

export type RuntimeLeaseTurn = {
  threadId: string
  turnId: string
  startedAtMs: number
  sessionPath: string
}

export type RuntimeInstanceLease = {
  version: 1
  instanceId: string
  processId: number
  processIdentity: string
  port: number | null
  heartbeatAtMs: number
  turns: RuntimeLeaseTurn[]
}

type MutableSessionState = {
  latestTurnId: string
  nextOrder: number
  turnsById: Map<string, SessionRuntimeTurn>
}

type SessionCacheEntry = {
  size: number
  mtimeMs: number
  inode: number
  remainder: string
  state: MutableSessionState
}

type ThreadRuntimeStateOptions = {
  codexHome?: string
  instanceId?: string
  processId?: number
  processStartedAtMs?: number
  heartbeatIntervalMs?: number
  leaseTtlMs?: number
  now?: () => number
  port?: () => number | null
}

const LEASE_VERSION = 1
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000
const DEFAULT_LEASE_TTL_MS = 10_000
const LEASE_DIRECTORY_NAME = 'thread-runtime-leases'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readEpochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value)
}

function readIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function uuidV7TimestampMs(turnId: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(turnId)) {
    return null
  }
  const timestamp = Number.parseInt(turnId.replace(/-/gu, '').slice(0, 12), 16)
  return Number.isFinite(timestamp) ? timestamp : null
}

function turnSortTimestamp(turnId: string, startedAtMs: number): number {
  return uuidV7TimestampMs(turnId) ?? startedAtMs
}

function toIso(value: number | null): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null
}

function createMutableSessionState(): MutableSessionState {
  return {
    latestTurnId: '',
    nextOrder: 0,
    turnsById: new Map(),
  }
}

function applySessionLine(state: MutableSessionState, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let row: Record<string, unknown> | null = null
  try {
    row = asRecord(JSON.parse(trimmed) as unknown)
  } catch {
    return
  }
  if (row?.type !== 'event_msg') return

  const payload = asRecord(row.payload)
  const eventType = readString(payload?.type)
  if (eventType !== 'task_started' && eventType !== 'task_complete') return

  const turnId = readString(payload?.turn_id) || readString(payload?.turnId)
  if (!turnId) return

  const rowTimestampMs = readIsoMs(row.timestamp)
  const existing = state.turnsById.get(turnId)

  if (eventType === 'task_started') {
    const startedAtMs = readEpochMs(payload?.started_at)
      ?? readEpochMs(payload?.startedAt)
      ?? rowTimestampMs
      ?? uuidV7TimestampMs(turnId)
      ?? 0
    const next: SessionRuntimeTurn = {
      turnId,
      startedAtMs,
      completedAtMs: existing?.completedAtMs ?? null,
      startOrder: ++state.nextOrder,
    }
    state.turnsById.set(turnId, next)
    state.latestTurnId = turnId
    return
  }

  const completedAtMs = readEpochMs(payload?.completed_at)
    ?? readEpochMs(payload?.completedAt)
    ?? rowTimestampMs
    ?? Date.now()
  state.turnsById.set(turnId, {
    turnId,
    startedAtMs: existing?.startedAtMs ?? uuidV7TimestampMs(turnId) ?? completedAtMs,
    completedAtMs,
    startOrder: existing?.startOrder ?? ++state.nextOrder,
  })
  if (!state.latestTurnId) state.latestTurnId = turnId
}

function snapshotSessionState(state: MutableSessionState): SessionRuntimeSnapshot {
  return {
    latestTurnId: state.latestTurnId,
    turns: Array.from(state.turnsById.values()).sort((first, second) => first.startOrder - second.startOrder),
  }
}

export function parseSessionRuntimeEvents(raw: string): SessionRuntimeSnapshot {
  const state = createMutableSessionState()
  for (const line of raw.split(/\r?\n/u)) {
    applySessionLine(state, line)
  }
  return snapshotSessionState(state)
}

function isLeaseFresh(lease: RuntimeInstanceLease, nowMs: number, leaseTtlMs: number): boolean {
  return lease.heartbeatAtMs > 0 && nowMs - lease.heartbeatAtMs <= leaseTtlMs
}

function normalizeLease(value: unknown): RuntimeInstanceLease | null {
  const row = asRecord(value)
  if (!row || row.version !== LEASE_VERSION) return null

  const instanceId = readString(row.instanceId)
  const processIdentity = readString(row.processIdentity)
  const processId = typeof row.processId === 'number' && Number.isInteger(row.processId) ? row.processId : 0
  const heartbeatAtMs = typeof row.heartbeatAtMs === 'number' && Number.isFinite(row.heartbeatAtMs)
    ? row.heartbeatAtMs
    : 0
  const port = typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0 ? row.port : null
  if (!instanceId || !processIdentity || processId <= 0 || heartbeatAtMs <= 0) return null

  const turns: RuntimeLeaseTurn[] = []
  for (const rawTurn of Array.isArray(row.turns) ? row.turns : []) {
    const turn = asRecord(rawTurn)
    const threadId = readString(turn?.threadId)
    const turnId = readString(turn?.turnId)
    const startedAtMs = typeof turn?.startedAtMs === 'number' && Number.isFinite(turn.startedAtMs)
      ? turn.startedAtMs
      : uuidV7TimestampMs(turnId) ?? 0
    const sessionPath = readString(turn?.sessionPath)
    if (!threadId || !turnId || startedAtMs <= 0) continue
    turns.push({ threadId, turnId, startedAtMs, sessionPath })
  }

  return {
    version: LEASE_VERSION,
    instanceId,
    processId,
    processIdentity,
    port,
    heartbeatAtMs,
    turns,
  }
}

type Candidate = {
  turnId: string
  startedAtMs: number
}

function pickNewestCandidate(candidates: Candidate[]): Candidate | null {
  let newest: Candidate | null = null
  for (const candidate of candidates) {
    if (!candidate.turnId) continue
    if (!newest) {
      newest = candidate
      continue
    }
    const candidateTimestamp = turnSortTimestamp(candidate.turnId, candidate.startedAtMs)
    const newestTimestamp = turnSortTimestamp(newest.turnId, newest.startedAtMs)
    if (candidateTimestamp > newestTimestamp || (candidateTimestamp === newestTimestamp && candidate.startedAtMs > newest.startedAtMs)) {
      newest = candidate
    }
  }
  return newest
}

export function resolveThreadRuntimeSnapshot(input: {
  threadId: string
  session: SessionRuntimeSnapshot | null
  localTurns?: RuntimeTurnEvidence[]
  leases?: RuntimeInstanceLease[]
  localInstanceId?: string
  nowMs?: number
  leaseTtlMs?: number
}): ThreadRuntimeStateSnapshot {
  const threadId = input.threadId.trim()
  const nowMs = input.nowMs ?? Date.now()
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const localTurns = (input.localTurns ?? []).filter((turn) => turn.threadId === threadId)
  const freshLeases = (input.leases ?? []).filter((lease) => isLeaseFresh(lease, nowMs, leaseTtlMs))
  const sessionTurnsById = new Map((input.session?.turns ?? []).map((turn) => [turn.turnId, turn]))
  const latestSessionTurn = input.session?.latestTurnId
    ? sessionTurnsById.get(input.session.latestTurnId) ?? null
    : null

  const candidates: Candidate[] = []
  if (latestSessionTurn) {
    candidates.push({ turnId: latestSessionTurn.turnId, startedAtMs: latestSessionTurn.startedAtMs })
  }
  for (const turn of localTurns) {
    candidates.push({ turnId: turn.turnId, startedAtMs: turn.startedAtMs })
  }
  for (const lease of freshLeases) {
    for (const turn of lease.turns) {
      if (turn.threadId === threadId) candidates.push({ turnId: turn.turnId, startedAtMs: turn.startedAtMs })
    }
  }

  const newest = pickNewestCandidate(candidates)
  if (!newest) {
    return {
      threadId,
      turnId: '',
      state: 'idle',
      isRunning: false,
      source: 'none',
      startedAtIso: null,
      completedAtIso: null,
      owner: null,
    }
  }

  const sessionTurn = sessionTurnsById.get(newest.turnId) ?? null
  const matchingLocalTurns = localTurns.filter((turn) => turn.turnId === newest.turnId)
  const completedLocalTurn = matchingLocalTurns.find((turn) => turn.status === 'completed') ?? null
  const completedAtMs = sessionTurn?.completedAtMs ?? completedLocalTurn?.completedAtMs ?? null
  if (completedAtMs) {
    return {
      threadId,
      turnId: newest.turnId,
      state: 'completed',
      isRunning: false,
      source: sessionTurn?.completedAtMs ? 'session' : 'local',
      startedAtIso: toIso(newest.startedAtMs),
      completedAtIso: toIso(completedAtMs),
      owner: null,
    }
  }

  const runningLocalTurn = matchingLocalTurns.find((turn) => turn.status === 'running') ?? null
  if (runningLocalTurn) {
    const localLease = freshLeases.find((lease) => lease.instanceId === input.localInstanceId)
    return {
      threadId,
      turnId: newest.turnId,
      state: 'running',
      isRunning: true,
      source: 'local',
      startedAtIso: toIso(newest.startedAtMs),
      completedAtIso: null,
      owner: localLease
        ? {
            instanceId: localLease.instanceId,
            processId: localLease.processId,
            processIdentity: localLease.processIdentity,
            port: localLease.port,
            local: true,
            heartbeatAtIso: new Date(localLease.heartbeatAtMs).toISOString(),
          }
        : null,
    }
  }

  const externalLease = freshLeases.find((lease) => (
    lease.instanceId !== input.localInstanceId &&
    lease.turns.some((turn) => turn.threadId === threadId && turn.turnId === newest.turnId)
  ))
  if (externalLease) {
    return {
      threadId,
      turnId: newest.turnId,
      state: 'running',
      isRunning: true,
      source: 'external',
      startedAtIso: toIso(newest.startedAtMs),
      completedAtIso: null,
      owner: {
        instanceId: externalLease.instanceId,
        processId: externalLease.processId,
        processIdentity: externalLease.processIdentity,
        port: externalLease.port,
        local: false,
        heartbeatAtIso: new Date(externalLease.heartbeatAtMs).toISOString(),
      },
    }
  }

  return {
    threadId,
    turnId: newest.turnId,
    state: 'interrupted',
    isRunning: false,
    source: sessionTurn ? 'session' : 'local',
    startedAtIso: toIso(newest.startedAtMs),
    completedAtIso: null,
    owner: null,
  }
}

function readSessionPath(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ''
  const candidate = readString(record.path) || readString(record.rolloutPath) || readString(record.rollout_path)
  return candidate && isAbsolute(candidate) ? candidate : ''
}

function readThreadId(value: unknown): string {
  const record = asRecord(value)
  return readString(record?.id) || readString(record?.threadId) || readString(record?.thread_id)
}

function readTurnId(value: unknown): string {
  const record = asRecord(value)
  return readString(record?.id) || readString(record?.turnId) || readString(record?.turn_id)
}

function readNotificationThreadId(params: unknown): string {
  const record = asRecord(params)
  return readString(record?.threadId)
    || readString(record?.thread_id)
    || readString(asRecord(record?.thread)?.id)
    || readString(asRecord(record?.turn)?.threadId)
    || readString(asRecord(record?.turn)?.thread_id)
}

function readNotificationTurnId(params: unknown): string {
  const record = asRecord(params)
  return readString(asRecord(record?.turn)?.id)
    || readString(record?.turnId)
    || readString(record?.turn_id)
}

function defaultPortReader(): number | null {
  const parsed = Number.parseInt(process.env.CODEXUI_SERVER_PORT ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export class ThreadRuntimeState {
  readonly instanceId: string
  readonly processId: number
  readonly processIdentity: string
  readonly leaseTtlMs: number

  private readonly now: () => number
  private readonly readPort: () => number | null
  private readonly leaseDirectory: string
  private readonly leasePath: string
  private readonly heartbeatIntervalMs: number
  private readonly localTurnsByThreadId = new Map<string, Map<string, RuntimeTurnEvidence>>()
  private readonly sessionPathByThreadId = new Map<string, string>()
  private readonly sessionCacheByPath = new Map<string, SessionCacheEntry>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private leaseWriteChain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: ThreadRuntimeStateOptions = {}) {
    const codexHome = options.codexHome?.trim()
      || process.env.CODEX_HOME?.trim()
      || join(homedir(), '.codex')
    const processStartedAtMs = options.processStartedAtMs ?? Math.round(Date.now() - process.uptime() * 1000)
    this.instanceId = options.instanceId?.trim() || randomUUID()
    this.processId = options.processId ?? process.pid
    this.processIdentity = `${String(this.processId)}:${String(processStartedAtMs)}:${this.instanceId}`
    this.now = options.now ?? Date.now
    this.readPort = options.port ?? defaultPortReader
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.leaseDirectory = join(codexHome, 'linux-codex-webui-runtime', LEASE_DIRECTORY_NAME)
    this.leasePath = join(this.leaseDirectory, `${this.instanceId}.json`)
  }

  beginTurn(threadId: string): string {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return ''
    const pendingTurnId = `pending:${this.instanceId}:${randomUUID()}`
    this.upsertLocalTurn({
      threadId: normalizedThreadId,
      turnId: pendingTurnId,
      startedAtMs: this.now(),
      completedAtMs: null,
      status: 'running',
    })
    return pendingTurnId
  }

  rejectTurnStart(threadId: string, pendingTurnId: string): void {
    this.removeLocalTurn(threadId, pendingTurnId)
    this.queueLeaseWrite()
  }

  observeRpcResult(method: string, params: unknown, result: unknown, pendingTurnId = ''): void {
    this.observeThreadPayload(result)
    if (method !== 'turn/start') return

    const threadId = readNotificationThreadId(params)
    const turnId = readTurnId(asRecord(result)?.turn)
    if (!threadId) return
    if (!turnId) {
      if (pendingTurnId) this.rejectTurnStart(threadId, pendingTurnId)
      return
    }
    this.promotePendingTurn(threadId, pendingTurnId, turnId)
  }

  observeThreadPayload(payload: unknown): void {
    const record = asRecord(payload)
    if (!record) return
    const directThread = asRecord(record.thread)
    if (directThread) this.rememberThreadPath(directThread)
    for (const row of Array.isArray(record.data) ? record.data : []) {
      this.rememberThreadPath(row)
    }
  }

  observeNotification(method: string, params: unknown): void {
    if (method !== 'turn/started' && method !== 'turn/completed') return
    const threadId = readNotificationThreadId(params)
    const turnId = readNotificationTurnId(params)
    if (!threadId || !turnId) return

    const paramsRecord = asRecord(params)
    const turnRecord = asRecord(paramsRecord?.turn)
    if (method === 'turn/started') {
      const startedAtMs = readIsoMs(turnRecord?.startedAt)
        ?? readIsoMs(paramsRecord?.startedAt)
        ?? uuidV7TimestampMs(turnId)
        ?? this.now()
      this.promotePendingTurn(threadId, '', turnId, startedAtMs)
      return
    }

    const completedAtMs = readIsoMs(turnRecord?.completedAt)
      ?? readIsoMs(paramsRecord?.completedAt)
      ?? this.now()
    const existing = this.localTurnsByThreadId.get(threadId)?.get(turnId)
    this.upsertLocalTurn({
      threadId,
      turnId,
      startedAtMs: existing?.startedAtMs ?? uuidV7TimestampMs(turnId) ?? completedAtMs,
      completedAtMs,
      status: 'completed',
    })
  }

  clearLocalActivity(): void {
    let changed = false
    const interruptedAtMs = this.now()
    for (const [threadId, turns] of this.localTurnsByThreadId) {
      for (const [turnId, turn] of turns) {
        if (turn.status !== 'running') continue
        turns.set(turnId, { ...turn, status: 'interrupted', completedAtMs: null })
        changed = true
      }
      this.pruneLocalTurns(threadId, interruptedAtMs)
    }
    if (changed) this.queueLeaseWrite()
  }

  hasSessionPath(threadId: string): boolean {
    return this.sessionPathByThreadId.has(threadId.trim())
  }

  async getStates(threadIds: string[]): Promise<ThreadRuntimeStateSnapshot[]> {
    const normalizedThreadIds = Array.from(new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)))
    if (normalizedThreadIds.length === 0) return []

    const leases = await this.readLeases()
    for (const lease of leases) {
      for (const turn of lease.turns) {
        if (turn.sessionPath && isAbsolute(turn.sessionPath)) {
          this.sessionPathByThreadId.set(turn.threadId, turn.sessionPath)
        }
      }
    }

    const nowMs = this.now()
    return Promise.all(normalizedThreadIds.map(async (threadId) => {
      const sessionPath = this.sessionPathByThreadId.get(threadId) ?? ''
      const session = sessionPath ? await this.readSessionSnapshot(sessionPath) : null
      const localTurns = Array.from(this.localTurnsByThreadId.get(threadId)?.values() ?? [])
      return resolveThreadRuntimeSnapshot({
        threadId,
        session,
        localTurns,
        leases,
        localInstanceId: this.instanceId,
        nowMs,
        leaseTtlMs: this.leaseTtlMs,
      })
    }))
  }

  async flush(): Promise<void> {
    await this.leaseWriteChain
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.localTurnsByThreadId.clear()
    this.queueLeaseWrite()
    await this.flush()
  }

  private rememberThreadPath(value: unknown): void {
    const threadId = readThreadId(value)
    const sessionPath = readSessionPath(value)
    if (!threadId || !sessionPath) return
    this.sessionPathByThreadId.set(threadId, sessionPath)
  }

  private promotePendingTurn(threadId: string, pendingTurnId: string, turnId: string, startedAtMs?: number): void {
    const normalizedThreadId = threadId.trim()
    const normalizedTurnId = turnId.trim()
    if (!normalizedThreadId || !normalizedTurnId) return

    const turns = this.localTurnsByThreadId.get(normalizedThreadId)
    let pending = pendingTurnId ? turns?.get(pendingTurnId) : undefined
    if (!pending && turns) {
      pending = Array.from(turns.values())
        .filter((turn) => turn.status === 'running' && turn.turnId.startsWith('pending:'))
        .sort((first, second) => second.startedAtMs - first.startedAtMs)[0]
    }
    if (pending) this.removeLocalTurn(normalizedThreadId, pending.turnId, false)

    const existing = this.localTurnsByThreadId.get(normalizedThreadId)?.get(normalizedTurnId)
    this.upsertLocalTurn({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      startedAtMs: existing?.startedAtMs ?? startedAtMs ?? pending?.startedAtMs ?? uuidV7TimestampMs(normalizedTurnId) ?? this.now(),
      completedAtMs: existing?.completedAtMs ?? null,
      status: existing?.status === 'completed' ? 'completed' : 'running',
    })
  }

  private upsertLocalTurn(turn: RuntimeTurnEvidence): void {
    let turns = this.localTurnsByThreadId.get(turn.threadId)
    if (!turns) {
      turns = new Map()
      this.localTurnsByThreadId.set(turn.threadId, turns)
    }
    turns.set(turn.turnId, turn)
    this.pruneLocalTurns(turn.threadId, this.now())
    this.queueLeaseWrite()
  }

  private removeLocalTurn(threadId: string, turnId: string, writeLease = true): void {
    const normalizedThreadId = threadId.trim()
    const turns = this.localTurnsByThreadId.get(normalizedThreadId)
    if (!turns || !turnId || !turns.delete(turnId)) return
    if (turns.size === 0) this.localTurnsByThreadId.delete(normalizedThreadId)
    if (writeLease) this.queueLeaseWrite()
  }

  private pruneLocalTurns(threadId: string, nowMs: number): void {
    const turns = this.localTurnsByThreadId.get(threadId)
    if (!turns || turns.size <= 12) return
    const removable = Array.from(turns.values())
      .filter((turn) => turn.status !== 'running')
      .sort((first, second) => (
        (first.completedAtMs ?? first.startedAtMs) - (second.completedAtMs ?? second.startedAtMs)
      ))
    while (turns.size > 12 && removable.length > 0) {
      const oldest = removable.shift()
      if (oldest) turns.delete(oldest.turnId)
    }
    for (const [turnId, turn] of turns) {
      if (turn.status === 'interrupted' && nowMs - turn.startedAtMs > 60_000) turns.delete(turnId)
    }
    if (turns.size === 0) this.localTurnsByThreadId.delete(threadId)
  }

  private activeLeaseTurns(): RuntimeLeaseTurn[] {
    const turns: RuntimeLeaseTurn[] = []
    for (const [threadId, threadTurns] of this.localTurnsByThreadId) {
      for (const turn of threadTurns.values()) {
        if (turn.status !== 'running' || turn.turnId.startsWith('pending:')) continue
        turns.push({
          threadId,
          turnId: turn.turnId,
          startedAtMs: turn.startedAtMs,
          sessionPath: this.sessionPathByThreadId.get(threadId) ?? '',
        })
      }
    }
    return turns
  }

  private queueLeaseWrite(): void {
    if (this.disposed && this.localTurnsByThreadId.size > 0) return
    const turns = this.activeLeaseTurns()
    const heartbeatAtMs = this.now()
    const lease: RuntimeInstanceLease = {
      version: LEASE_VERSION,
      instanceId: this.instanceId,
      processId: this.processId,
      processIdentity: this.processIdentity,
      port: this.readPort(),
      heartbeatAtMs,
      turns,
    }

    this.leaseWriteChain = this.leaseWriteChain
      .catch(() => {})
      .then(async () => {
        if (lease.turns.length === 0) {
          await rm(this.leasePath, { force: true }).catch(() => {})
          return
        }
        await mkdir(this.leaseDirectory, { recursive: true, mode: 0o700 })
        const temporaryPath = `${this.leasePath}.${randomUUID()}.tmp`
        await writeFile(temporaryPath, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(temporaryPath, this.leasePath)
      })
      .catch(() => {
        // Runtime leases are best-effort; local app-server state remains authoritative.
      })

    if (turns.length > 0 && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.activeLeaseTurns().length === 0) {
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
          return
        }
        this.queueLeaseWrite()
      }, this.heartbeatIntervalMs)
      this.heartbeatTimer.unref()
    }
    if (turns.length === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async readLeases(): Promise<RuntimeInstanceLease[]> {
    let entries: string[]
    try {
      entries = await readdir(this.leaseDirectory)
    } catch {
      return this.buildLocalLeaseFallback()
    }

    const leases: RuntimeInstanceLease[] = []
    const nowMs = this.now()
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(this.leaseDirectory, entry)
      try {
        const lease = normalizeLease(JSON.parse(await readFile(path, 'utf8')) as unknown)
        if (!lease) continue
        if (nowMs - lease.heartbeatAtMs > this.leaseTtlMs * 6) {
          void rm(path, { force: true }).catch(() => {})
          continue
        }
        leases.push(lease)
      } catch {
        // A concurrent atomic replacement or malformed stale file is ignored.
      }
    }

    const hasOwnLease = leases.some((lease) => lease.instanceId === this.instanceId)
    if (!hasOwnLease) leases.push(...this.buildLocalLeaseFallback())
    return leases
  }

  private buildLocalLeaseFallback(): RuntimeInstanceLease[] {
    const turns = this.activeLeaseTurns()
    if (turns.length === 0) return []
    return [{
      version: LEASE_VERSION,
      instanceId: this.instanceId,
      processId: this.processId,
      processIdentity: this.processIdentity,
      port: this.readPort(),
      heartbeatAtMs: this.now(),
      turns,
    }]
  }

  private async readSessionSnapshot(sessionPath: string): Promise<SessionRuntimeSnapshot | null> {
    try {
      const info = await stat(sessionPath)
      if (!info.isFile()) return null
      const cached = this.sessionCacheByPath.get(sessionPath)
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.inode === info.ino) {
        return snapshotSessionState(cached.state)
      }

      let entry: SessionCacheEntry
      let appendedText = ''
      const canAppend = Boolean(cached && cached.inode === info.ino && info.size > cached.size && info.mtimeMs >= cached.mtimeMs)
      if (cached && canAppend) {
        entry = cached
        appendedText = await this.readFileRange(sessionPath, cached.size, info.size - cached.size)
      } else {
        entry = {
          size: 0,
          mtimeMs: 0,
          inode: info.ino,
          remainder: '',
          state: createMutableSessionState(),
        }
        appendedText = await readFile(sessionPath, 'utf8')
      }

      const combined = `${entry.remainder}${appendedText}`
      const lines = combined.split('\n')
      entry.remainder = lines.pop() ?? ''
      for (const line of lines) applySessionLine(entry.state, line.replace(/\r$/u, ''))
      entry.size = info.size
      entry.mtimeMs = info.mtimeMs
      entry.inode = info.ino
      this.sessionCacheByPath.set(sessionPath, entry)
      return snapshotSessionState(entry.state)
    } catch {
      this.sessionCacheByPath.delete(sessionPath)
      return null
    }
  }

  private async readFileRange(path: string, offset: number, length: number): Promise<string> {
    if (length <= 0) return ''
    const handle = await open(path, 'r')
    try {
      const chunks: Buffer[] = []
      let position = offset
      let remaining = length
      while (remaining > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead <= 0) break
        chunks.push(buffer.subarray(0, bytesRead))
        position += bytesRead
        remaining -= bytesRead
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      await handle.close()
    }
  }
}
