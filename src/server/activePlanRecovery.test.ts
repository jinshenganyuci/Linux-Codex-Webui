import { describe, expect, it, vi } from 'vitest'
import type { ActivePlanSnapshot } from '../types/codex'
import { verifyRestoredPlans } from './activePlanRecovery'
const snapshot = (threadId: string, turnId = 'turn'): ActivePlanSnapshot => ({ threadId, turnId, kind: 'checklist', messageId: 'plan', steps: [], text: 'task', revision: 2, generation: 5, lifecycle: 'unconfirmed', createdAtIso: '', updatedAtIso: '' })
describe('restored plan verification', () => {
  it('uses one bounded summary page for both kinds and reconciles only the requested turn', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: 'turn', status: 'completed' }, { id: 'other', status: 'failed' }] }))
    const reconcile = vi.fn()
    await verifyRestoredPlans({ snapshots: [snapshot('thread'), { ...snapshot('thread'), kind: 'proposal', itemId: 'item' }], rpc, reconcile, isDisposed: () => false })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/turns/list', { threadId: 'thread', cursor: null, limit: 10, sortDirection: 'desc', itemsView: 'summary' })
    expect(reconcile).toHaveBeenCalledExactlyOnceWith('thread', 'turn', 'completed')
  })
  it('does not convert query failure or absent history to a completed plan', async () => {
    const reconcile = vi.fn()
    await verifyRestoredPlans({ snapshots: [snapshot('one'), snapshot('two')], rpc: vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValueOnce({ data: [] }), reconcile, isDisposed: () => false })
    expect(reconcile).not.toHaveBeenCalled()
  })
  it('stops after timeout rather than piling more RPCs over an unresolved native read', async () => {
    const rpc = vi.fn(() => new Promise(() => {})), reconcile = vi.fn()
    await verifyRestoredPlans({ snapshots: [snapshot('one'), snapshot('two')], rpc, reconcile, isDisposed: () => false, timeoutMs: 5 })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
  })
  it('does not launch probes while foreground RPC is pending or after disposal', async () => {
    const rpc = vi.fn(), reconcile = vi.fn()
    await verifyRestoredPlans({ snapshots: [snapshot('one')], rpc, reconcile, isDisposed: () => true })
    await verifyRestoredPlans({ snapshots: [snapshot('one')], rpc, reconcile, isDisposed: () => false, isBusy: () => true })
    expect(rpc).not.toHaveBeenCalled()
  })
})
