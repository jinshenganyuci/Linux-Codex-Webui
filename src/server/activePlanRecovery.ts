import type { ActivePlanSnapshot } from '../types/codex'

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** One bounded summary page per recovered thread; no full-history fallback. */
export async function verifyRestoredPlans(options: {
  snapshots: ActivePlanSnapshot[]
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
  reconcile: (threadId: string, turnId: string, status: string) => void
  isDisposed: () => boolean
  isBusy?: () => boolean
  timeoutMs?: number
}): Promise<'done' | 'deferred'> {
  const byThread = new Map<string, Set<string>>()
  for (const snapshot of options.snapshots) if (snapshot.lifecycle === 'unconfirmed') {
    const ids = byThread.get(snapshot.threadId) ?? new Set<string>()
    ids.add(snapshot.turnId); byThread.set(snapshot.threadId, ids)
  }
  for (const [threadId, turnIds] of [...byThread].slice(0, 32)) {
    if (options.isDisposed()) return 'done'
    // Maintenance never queues behind a busy foreground connection. The next
    // native event can still resolve an unconfirmed card without this probe.
    if (options.isBusy?.()) return 'deferred'
    let timer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    try {
      const result = await Promise.race([
        options.rpc('thread/turns/list', { threadId, cursor: null, limit: 10, sortDirection: 'desc', itemsView: 'summary' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Plan recovery timed out')) }, options.timeoutMs ?? 5000); timer.unref() }),
      ])
      if (options.isDisposed()) return 'done'
      const rows = record(result).data
      for (const row of (Array.isArray(rows) ? rows : []).slice(0, 10)) {
        const turn = record(row)
        if (typeof turn.id === 'string' && turnIds.has(turn.id) && typeof turn.status === 'string') options.reconcile(threadId, turn.id, turn.status)
      }
    } catch {
      // Query failures are uncertainty, never proof of completion. A timed-out
      // native request may remain in flight, so do not start another probe.
      if (timedOut) return 'done'
    } finally { if (timer) clearTimeout(timer) }
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  return 'done'
}
