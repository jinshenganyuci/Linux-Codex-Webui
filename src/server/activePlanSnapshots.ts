import type { ActivePlanSnapshot, UiPlanKind, UiPlanLifecycle, UiPlanStep } from '../types/codex'

export const ACTIVE_PLAN_SNAPSHOT_MAX_COUNT = 64
export const ACTIVE_PLAN_SNAPSHOT_MAX_STEPS = 64
export const ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES = 64 * 1024
export const ACTIVE_PLAN_SNAPSHOT_MAX_TOTAL_BYTES = 512 * 1024
export const ACTIVE_PLAN_TERMINAL_RETENTION_MS = 30_000

type Options = { maxCount?: number; maxSteps?: number; maxTextBytes?: number; maxTotalBytes?: number; terminalRetentionMs?: number; now?: () => number }
type Stored = ActivePlanSnapshot & { terminalAtMs: number | null; updatedAtMs: number }
function rec(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function str(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function terminal(lifecycle: UiPlanLifecycle): boolean { return lifecycle !== 'live' && lifecycle !== 'unconfirmed' }
function cap(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value
  let result = '', bytes = 0
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > max) break; result += character; bytes += size }
  return result
}
export function activePlanIdentity(snapshot: Pick<ActivePlanSnapshot, 'threadId' | 'turnId' | 'kind' | 'itemId'>): string {
  const kind = snapshot.kind ?? 'checklist'
  return JSON.stringify([snapshot.threadId, snapshot.turnId, kind, kind === 'proposal' ? snapshot.itemId ?? '' : ''])
}
function turnKey(threadId: string, turnId: string): string { return JSON.stringify([threadId, turnId]) }
function clone(snapshot: Stored): ActivePlanSnapshot { const { terminalAtMs: _terminal, updatedAtMs: _updated, ...result } = snapshot; return { ...result, steps: snapshot.steps.map(step => ({ ...step })) } }

/** Independent identities for executable checklists and authored plan documents. */
export class ActivePlanSnapshotStore {
  private readonly snapshots = new Map<string, Stored>()
  private readonly closedTurns = new Map<string, string>()
  private readonly fullProposalIdentities = new Set<string>()
  private readonly snapshotSizes = new Map<string, number>()
  private readonly deltaTokens = new Map<string, Set<string>>()
  private readonly now: () => number
  private readonly maxCount: number
  private readonly maxSteps: number
  private readonly maxText: number
  private readonly maxTotal: number
  private readonly retention: number
  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now
    this.maxCount = Math.max(1, options.maxCount ?? ACTIVE_PLAN_SNAPSHOT_MAX_COUNT)
    this.maxSteps = Math.max(1, options.maxSteps ?? ACTIVE_PLAN_SNAPSHOT_MAX_STEPS)
    this.maxText = Math.max(256, options.maxTextBytes ?? ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES)
    this.maxTotal = Math.max(this.maxText * 2, options.maxTotalBytes ?? ACTIVE_PLAN_SNAPSHOT_MAX_TOTAL_BYTES)
    this.retention = Math.max(0, options.terminalRetentionMs ?? ACTIVE_PLAN_TERMINAL_RETENTION_MS)
  }

  applyNotification(method: string, params: unknown, generation = 0, atIso?: string): ActivePlanSnapshot[] {
    if (method === 'codex-ui/runtime-stopped') return this.markUnconfirmed()
    const row = rec(params), turn = rec(row.turn), item = rec(row.item)
    const threadId = str(row.threadId) || str(row.thread_id) || str(row.conversationId) || str(row.conversation_id) || str(rec(row.thread).id) || str(turn.threadId) || str(turn.thread_id)
    const turnId = str(row.turnId) || str(row.turn_id) || str(turn.id)
    if (!threadId || !turnId) return []
    if (method === 'turn/started') {
      const changed: ActivePlanSnapshot[] = []
      for (const snapshot of this.snapshots.values()) if (snapshot.threadId === threadId && snapshot.turnId !== turnId && !terminal(snapshot.lifecycle)) {
        this.closeTurn(snapshot.threadId, snapshot.turnId)
        changed.push(this.setLifecycle(snapshot, 'incomplete', generation, atIso))
      }
      return changed
    }
    if (method === 'turn/completed') {
      this.closeTurn(threadId, turnId, str(turn.status))
      return this.finishTurn(threadId, turnId, str(turn.status), generation, atIso)
    }
    const checklist = method === 'turn/plan/updated'
    const delta = method === 'item/plan/delta'
    const fullProposal = (method === 'item/started' || method === 'item/completed') && item.type === 'plan'
    if (!checklist && !delta && !fullProposal) return []
    if (this.closedTurns.has(turnKey(threadId, turnId))) return []
    const kind: UiPlanKind = checklist ? 'checklist' : 'proposal'
    const itemId = kind === 'proposal' ? str(row.itemId) || str(row.item_id) || str(item.id) || `${turnId}:proposal` : undefined
    const identity = activePlanIdentity({ threadId, turnId, kind, itemId })
    const previous = this.snapshots.get(identity)
    if (previous && terminal(previous.lifecycle)) return []
    const timestamp = atIso || new Date(this.now()).toISOString()
    let explanation: string | undefined, steps: UiPlanStep[] = [], text = '', truncated = false
    if (checklist) {
      const structuredBudget = Math.max(128, Math.floor(this.maxText / 2))
      explanation = cap(str(row.explanation), Math.max(64, Math.floor(structuredBudget / 2))) || undefined
      let remaining = structuredBudget - Buffer.byteLength(explanation ?? '')
      for (const raw of (Array.isArray(row.plan) ? row.plan : []).slice(0, this.maxSteps)) {
        const step = rec(raw), label = cap(str(step.step), remaining)
        if (!label) continue
        steps.push({ step: label, status: step.status === 'completed' ? 'completed' : step.status === 'in_progress' || step.status === 'inProgress' ? 'inProgress' : 'pending' })
        remaining -= Buffer.byteLength(label)
        if (remaining <= 0) break
      }
      truncated = (Array.isArray(row.plan) ? row.plan : []).length > steps.length
      text = cap([...(explanation ? [explanation] : []), ...steps.map(step => `- [${step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '}] ${step.step}`)].join('\n'), this.maxText - structuredBudget)
    } else if (delta) {
      const value = typeof row.delta === 'string' ? row.delta : ''
      if (!value) return []
      const token = str(row.eventId) || (typeof row.sequence === 'number' ? `sequence:${row.sequence}` : typeof row.offset === 'number' ? `offset:${row.offset}` : '')
      if (token) {
        const seen = this.deltaTokens.get(identity) ?? new Set<string>()
        if (seen.has(token)) return []
        seen.add(token); if (seen.size > 2048) seen.delete(seen.values().next().value!)
        this.deltaTokens.set(identity, seen)
      }
      text = cap(`${previous?.text ?? ''}${value}`, this.maxText)
    } else {
      this.fullProposalIdentities.add(identity)
      text = cap(typeof item.text === 'string' && item.text ? item.text : typeof item.plan === 'string' ? item.plan : previous?.text ?? '', this.maxText)
    }
    const lifecycle: UiPlanLifecycle = fullProposal && method === 'item/completed' ? 'completed' : 'live'
    if (previous && previous.text === text && previous.explanation === explanation && JSON.stringify(previous.steps) === JSON.stringify(steps) && previous.lifecycle === lifecycle && Boolean(previous.truncated) === truncated) return []
    const snapshot: Stored = {
      threadId, turnId, kind, ...(truncated ? { truncated: true } : {}), ...(itemId ? { itemId } : {}), messageId: kind === 'checklist' ? `${turnId}:plan` : itemId!, text, explanation, steps,
      revision: (previous?.revision ?? 0) + 1, createdAtIso: previous?.createdAtIso ?? timestamp, updatedAtIso: timestamp,
      generation, lifecycle, terminalAtMs: terminal(lifecycle) ? this.now() : null, updatedAtMs: this.now(),
    }
    this.store(identity, snapshot)
    this.enforceCapacity()
    return [clone(snapshot)]
  }

  private closeTurn(threadId: string, turnId: string, status = 'incomplete'): void {
    this.closedTurns.set(turnKey(threadId, turnId), status)
    while (this.closedTurns.size > 2048) this.closedTurns.delete(this.closedTurns.keys().next().value!)
  }
  private finishTurn(threadId: string, turnId: string, status: string, generation: number, atIso?: string): ActivePlanSnapshot[] {
    const changed: ActivePlanSnapshot[] = []
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.threadId !== threadId || snapshot.turnId !== turnId || terminal(snapshot.lifecycle)) continue
      const complete = snapshot.kind === 'proposal' || (!snapshot.truncated && snapshot.steps.length > 0 && snapshot.steps.every(step => step.status === 'completed'))
      const lifecycle: UiPlanLifecycle = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : status === 'completed' && complete ? 'completed' : 'incomplete'
      changed.push(this.setLifecycle(snapshot, lifecycle, generation, atIso))
    }
    return changed
  }
  private setLifecycle(snapshot: Stored, lifecycle: UiPlanLifecycle, generation: number, atIso?: string): ActivePlanSnapshot {
    const updated: Stored = { ...snapshot, lifecycle, generation, revision: snapshot.revision + 1,
      updatedAtIso: atIso || new Date(this.now()).toISOString(), updatedAtMs: this.now(), terminalAtMs: terminal(lifecycle) ? this.now() : null }
    this.store(activePlanIdentity(snapshot), updated)
    return clone(updated)
  }

  markUnconfirmed(): ActivePlanSnapshot[] {
    const changed: ActivePlanSnapshot[] = []
    for (const snapshot of this.snapshots.values()) if (snapshot.lifecycle === 'live') changed.push(this.setLifecycle(snapshot, 'unconfirmed', snapshot.generation))
    return changed
  }

  /** Restore before background native verification; never infer success from a restart. */
  restore(snapshots: ActivePlanSnapshot[]): ActivePlanSnapshot[] {
    const restored: ActivePlanSnapshot[] = []
    for (const input of snapshots.slice(-this.maxCount)) {
      if (!input.threadId || !input.turnId || !Array.isArray(input.steps)) continue
      const kind = input.kind ?? (input.steps.length ? 'checklist' : 'proposal')
      const normalized = { ...input, kind, ...(kind === 'checklist' ? { itemId: undefined } : {}) }
      const identity = activePlanIdentity(normalized), current = this.snapshots.get(identity)
      if (terminal(input.lifecycle) && kind === 'checklist') this.closeTurn(input.threadId, input.turnId, input.lifecycle)
      const source = current && (terminal(current.lifecycle) || !terminal(input.lifecycle)) ? clone(current) : normalized
      if (current && kind === 'proposal' && !this.fullProposalIdentities.has(identity) && !terminal(input.lifecycle)) source.text = cap(`${input.text}${current.text}`, this.maxText)
      const closedStatus = this.closedTurns.get(turnKey(input.threadId, input.turnId))
      let lifecycle: UiPlanLifecycle = terminal(source.lifecycle) ? source.lifecycle : current ? source.lifecycle : 'unconfirmed'
      if (closedStatus && !terminal(lifecycle)) {
        const allDone = kind === 'proposal' || (!source.truncated && source.steps.length > 0 && source.steps.every(step => step.status === 'completed'))
        lifecycle = closedStatus === 'failed' ? 'failed' : closedStatus === 'interrupted' ? 'interrupted' : closedStatus === 'completed' && allDone ? 'completed' : 'incomplete'
      }
      const snapshot: Stored = { ...source, text: cap(source.text, this.maxText), steps: source.steps.slice(0, this.maxSteps), lifecycle,
        revision: Math.max(input.revision, current?.revision ?? 0) + (lifecycle !== input.lifecycle || current ? 1 : 0),
        updatedAtIso: lifecycle !== input.lifecycle || current ? new Date(this.now()).toISOString() : source.updatedAtIso,
        updatedAtMs: Date.parse(source.updatedAtIso) || this.now(), terminalAtMs: terminal(lifecycle) ? Date.parse(source.updatedAtIso) || this.now() : null }
      this.store(identity, snapshot); restored.push(clone(snapshot))
    }
    this.enforceCapacity()
    return restored.filter(snapshot => this.snapshots.has(activePlanIdentity(snapshot)))
  }

  /** Apply only explicitly observed native turn state; missing/error stays unconfirmed. */
  reconcileTurn(threadId: string, turnId: string, status: string): ActivePlanSnapshot[] {
    if (status === 'completed' || status === 'failed' || status === 'interrupted') {
      this.closeTurn(threadId, turnId, status)
      return this.finishTurn(threadId, turnId, status, this.getSnapshotsForTurn(threadId, turnId)[0]?.generation ?? 0)
    }
    if (status !== 'inProgress' && status !== 'in_progress') return []
    const changed: ActivePlanSnapshot[] = []
    for (const snapshot of this.snapshots.values()) if (snapshot.threadId === threadId && snapshot.turnId === turnId && snapshot.lifecycle === 'unconfirmed') changed.push(this.setLifecycle(snapshot, 'live', snapshot.generation))
    return changed
  }
  getSnapshots(): ActivePlanSnapshot[] {
    const now = this.now()
    return this.getPersistedSnapshots().filter(snapshot => !terminal(snapshot.lifecycle) || now - (Date.parse(snapshot.updatedAtIso) || now) < this.retention)
  }
  getPersistedSnapshots(): ActivePlanSnapshot[] { return [...this.snapshots.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs).map(clone) }
  getSnapshotsForTurn(threadId: string, turnId: string): ActivePlanSnapshot[] { return this.getPersistedSnapshots().filter(snapshot => snapshot.threadId === threadId && snapshot.turnId === turnId) }
  getSnapshot(turnId: string): ActivePlanSnapshot | null { const rows = this.getSnapshots().filter(snapshot => snapshot.turnId === turnId); return rows.find(snapshot => snapshot.kind === 'checklist') ?? rows.at(-1) ?? null }
  deleteThread(threadId: string): void {
    for (const [key, snapshot] of this.snapshots) if (snapshot.threadId === threadId) { this.closeTurn(threadId, snapshot.turnId); this.snapshots.delete(key); this.deltaTokens.delete(key); this.snapshotSizes.delete(key); this.fullProposalIdentities.delete(key) }
  }
  private store(identity: string, snapshot: Stored): void {
    this.snapshots.set(identity, snapshot)
    this.snapshotSizes.set(identity, Buffer.byteLength(JSON.stringify(clone(snapshot))))
  }
  private enforceCapacity(): void {
    const oldest = [...this.snapshots.entries()].sort((a, b) => Number(!terminal(a[1].lifecycle)) - Number(!terminal(b[1].lifecycle)) || a[1].updatedAtMs - b[1].updatedAtMs)
    let bytes = oldest.reduce((sum, [identity]) => sum + (this.snapshotSizes.get(identity) ?? 0), 0)
    while (this.snapshots.size > this.maxCount || bytes > this.maxTotal) {
      const row = oldest.shift(); if (!row) break
      this.snapshots.delete(row[0]); this.deltaTokens.delete(row[0]); this.fullProposalIdentities.delete(row[0]); bytes -= this.snapshotSizes.get(row[0]) ?? 0; this.snapshotSizes.delete(row[0])
    }
  }
}
