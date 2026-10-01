import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES,
  ACTIVE_PLAN_SNAPSHOT_MAX_TOTAL_BYTES,
  ActivePlanSnapshotStore,
} from './activePlanSnapshots'

describe('ActivePlanSnapshotStore', () => {
  it('keeps checklist and proposal identities independent in the same turn', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', { threadId: 'thread-a', turnId: 'turn-a', explanation: 'Ship safely', plan: [{ step: 'Build', status: 'completed' }, { step: 'Publish', status: 'in_progress' }] }, 1)
    store.applyNotification('item/plan/delta', { threadId: 'thread-a', turnId: 'turn-a', itemId: 'draft-a', delta: 'Draft proposal' }, 1)
    const rows = store.getSnapshots()
    expect(rows).toHaveLength(2)
    expect(store.getSnapshot('turn-a')).toMatchObject({ kind: 'checklist', messageId: 'turn-a:plan', revision: 1, steps: [{ step: 'Build', status: 'completed' }, { step: 'Publish', status: 'inProgress' }] })
    expect(rows.find(row => row.kind === 'proposal')).toMatchObject({ itemId: 'draft-a', messageId: 'draft-a', steps: [], text: 'Draft proposal', revision: 1 })
  })

  it('retains terminal plans briefly and expires them without affecting another turn', () => {
    let nowMs = 1_000
    const store = new ActivePlanSnapshotStore({ now: () => nowMs, terminalRetentionMs: 30_000 })
    for (const turnId of ['turn-a', 'turn-b']) {
      store.applyNotification('turn/plan/updated', {
        threadId: 'thread-a',
        turnId,
        plan: [{ step: turnId, status: 'inProgress' }],
      }, 2)
    }
    store.applyNotification('turn/completed', {
      threadId: 'thread-a',
      turn: { id: 'turn-a', status: 'failed' },
    }, 2)

    expect(store.getSnapshots().map((snapshot) => [snapshot.turnId, snapshot.lifecycle]).sort()).toEqual([
      ['turn-a', 'failed'],
      ['turn-b', 'live'],
    ])
    nowMs += 30_000
    expect(store.getSnapshots().map((snapshot) => snapshot.turnId)).toEqual(['turn-b'])
  })

  it('marks an older live plan incomplete when a new turn starts', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      plan: [{ step: 'Old task', status: 'inProgress' }],
    })
    store.applyNotification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-b' },
    })
    expect(store.getSnapshots()[0]?.lifecycle).toBe('incomplete')
  })

  it('bounds snapshot count, steps, and UTF-8 text', () => {
    const store = new ActivePlanSnapshotStore({ maxCount: 2, maxSteps: 2 })
    for (const turnId of ['turn-a', 'turn-b', 'turn-c']) {
      store.applyNotification('turn/plan/updated', {
        threadId: 'thread-a',
        turnId,
        explanation: '你'.repeat(ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES),
        plan: [
          { step: 'one', status: 'pending' },
          { step: 'two', status: 'pending' },
          { step: 'three', status: 'pending' },
        ],
      })
    }
    const snapshots = store.getSnapshots()
    expect(snapshots.map((snapshot) => snapshot.turnId)).toEqual(['turn-b', 'turn-c'])
    expect(snapshots.every((snapshot) => snapshot.steps.length === 2)).toBe(true)
    expect(snapshots.every((snapshot) => Buffer.byteLength(snapshot.text, 'utf8') <= ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES)).toBe(true)
  })

  it('bounds the aggregate ready payload and retains the newest plans', () => {
    let nowMs = 1_000
    const store = new ActivePlanSnapshotStore({
      maxCount: 64,
      maxTextBytes: 256,
      maxTotalBytes: 1_024,
      now: () => nowMs,
    })
    for (const turnId of ['turn-a', 'turn-b', 'turn-c', 'turn-d']) {
      store.applyNotification('turn/plan/updated', {
        threadId: 'thread-a',
        turnId,
        explanation: turnId,
        plan: [{ step: 'x'.repeat(180), status: 'inProgress' }],
      })
      nowMs += 1
    }

    const snapshots = store.getSnapshots()
    const serializedBytes = snapshots.reduce(
      (sum, snapshot) => sum + Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
      0,
    )
    expect(serializedBytes).toBeLessThanOrEqual(1_024)
    expect(snapshots.at(-1)?.turnId).toBe('turn-d')
    expect(snapshots.length).toBeLessThan(4)
    expect(ACTIVE_PLAN_SNAPSHOT_MAX_TOTAL_BYTES).toBe(512 * 1024)
  })

  it('ignores malformed notifications and empty deltas', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', { threadId: '', turnId: 'turn-a', plan: [] })
    store.applyNotification('item/plan/delta', { threadId: 'thread-a', turnId: 'turn-a', delta: '' })
    store.applyNotification('other/event', { threadId: 'thread-a', turnId: 'turn-a' })
    expect(store.getSnapshots()).toEqual([])
  })
})

describe('authoritative plan lifecycle', () => {
  const update = (status = 'inProgress') => ({ threadId: 'thread', turnId: 'turn', plan: [{ step: 'Do the task', status }] })
  it('marks a completed turn with unfinished checklist incomplete; duplicated and late notifications cannot revive it', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', update())
    expect(store.applyNotification('turn/plan/updated', update())).toEqual([])
    store.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
    const completed = store.getSnapshot('turn')
    expect(completed).toMatchObject({ lifecycle: 'incomplete', revision: 2 })
    expect(store.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })).toEqual([])
    expect(store.applyNotification('turn/plan/updated', update('completed'))).toEqual([])
    expect(store.applyNotification('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'late', delta: 'late' })).toEqual([])
    expect(store.getSnapshot('turn')).toEqual(completed)
  })
  it('completes only fully done checklists and preserves full proposal item content', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', update('completed'))
    store.applyNotification('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'par' })
    store.applyNotification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'plan', text: 'Full proposed plan' } })
    expect(store.getSnapshots().find(row => row.kind === 'proposal')).toMatchObject({ text: 'Full proposed plan', lifecycle: 'completed', revision: 2 })
    store.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
    expect(store.getSnapshot('turn')?.lifecycle).toBe('completed')
  })
  it('restores live plans as unconfirmed with monotonic revision and only trusts explicit native state', () => {
    const original = new ActivePlanSnapshotStore()
    original.applyNotification('turn/plan/updated', update())
    const store = new ActivePlanSnapshotStore()
    store.restore(original.getPersistedSnapshots())
    expect(store.getSnapshot('turn')).toMatchObject({ lifecycle: 'unconfirmed', revision: 2 })
    expect(store.reconcileTurn('thread', 'turn', '')).toEqual([])
    store.reconcileTurn('thread', 'turn', 'inProgress')
    expect(store.getSnapshot('turn')).toMatchObject({ lifecycle: 'live', revision: 3 })
    store.reconcileTurn('thread', 'turn', 'completed')
    expect(store.getSnapshot('turn')).toMatchObject({ lifecycle: 'incomplete', revision: 4 })
  })
  it('merges a notification received during disk load without losing persisted revision', () => {
    const old = new ActivePlanSnapshotStore()
    old.applyNotification('turn/plan/updated', update())
    const saved = { ...old.getSnapshot('turn')!, revision: 25 }
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', update('completed'), 1)
    store.restore([saved])
    expect(store.getSnapshot('turn')).toMatchObject({ lifecycle: 'live', revision: 26, steps: [{ step: 'Do the task', status: 'completed' }] })
  })
  it('deduplicates identified delta events without suppressing legitimate repeated words', () => {
    const store = new ActivePlanSnapshotStore()
    const delta = { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'ha', eventId: 'event-1' }
    store.applyNotification('item/plan/delta', delta)
    expect(store.applyNotification('item/plan/delta', delta)).toEqual([])
    store.applyNotification('item/plan/delta', { ...delta, eventId: 'event-2' })
    expect(store.getSnapshots()[0]).toMatchObject({ text: 'haha', revision: 2 })
  })
  it('does not allow one thread turn identifier to overwrite another and deletes all kinds', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', update())
    store.applyNotification('turn/plan/updated', { ...update(), threadId: 'other' })
    store.applyNotification('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'proposal' })
    store.deleteThread('thread')
    expect(store.getPersistedSnapshots()).toHaveLength(1)
    expect(store.getSnapshots()[0]?.threadId).toBe('other')
  })
})


it('retains older active work before newer terminal snapshots when capacity is full', () => {
  let now = 1000
  const store = new ActivePlanSnapshotStore({ maxCount: 2, now: () => now++ })
  for (const turnId of ['active', 'done-one', 'done-two']) {
    store.applyNotification('turn/plan/updated', { threadId: turnId, turnId, plan: [{ step: 'task', status: 'completed' }] })
    if (turnId !== 'active') store.applyNotification('turn/completed', { threadId: turnId, turn: { id: turnId, status: 'completed' } })
  }
  expect(store.getPersistedSnapshots().map(row => row.turnId)).toContain('active')
  expect(store.getSnapshot('active')?.lifecycle).toBe('live')
})

it('merges delta-only notifications received before disk load onto the saved proposal prefix', () => {
  const original = new ActivePlanSnapshotStore()
  original.applyNotification('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'saved prefix ' })
  const restored = new ActivePlanSnapshotStore()
  restored.applyNotification('item/plan/delta', { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'new suffix' })
  restored.restore(original.getPersistedSnapshots())
  expect(restored.getSnapshot('turn')).toMatchObject({ text: 'saved prefix new suffix', revision: 2 })
})

it('preserves completion received before disk load and never revives it as unconfirmed', () => {
  const original = new ActivePlanSnapshotStore()
  original.applyNotification('turn/plan/updated', { threadId: 'thread', turnId: 'turn', plan: [{ step: 'task', status: 'inProgress' }] })
  const restored = new ActivePlanSnapshotStore()
  restored.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed' } })
  restored.restore(original.getPersistedSnapshots())
  expect(restored.getSnapshot('turn')).toMatchObject({ lifecycle: 'failed', revision: 2 })
})

it('never declares a truncated checklist completed when a dropped step may still be pending', () => {
  const store = new ActivePlanSnapshotStore()
  store.applyNotification('turn/plan/updated', { threadId: 'thread', turnId: 'turn', plan: [...Array.from({ length: 64 }, () => ({ step: 'done', status: 'completed' })), { step: 'not done', status: 'pending' }] })
  store.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect(store.getSnapshot('turn')).toMatchObject({ lifecycle: 'incomplete', truncated: true })
  const tiny = new ActivePlanSnapshotStore({ maxTextBytes: 256 })
  tiny.applyNotification('turn/plan/updated', { threadId: 'thread', turnId: 'turn', plan: [{ step: 'x'.repeat(500), status: 'completed' }, { step: 'not done', status: 'pending' }] })
  tiny.applyNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } })
  expect(tiny.getSnapshot('turn')).toMatchObject({ lifecycle: 'incomplete', truncated: true })
})
