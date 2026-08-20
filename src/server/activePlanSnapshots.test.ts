import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PLAN_SNAPSHOT_MAX_TEXT_BYTES,
  ActivePlanSnapshotStore,
} from './activePlanSnapshots'

describe('ActivePlanSnapshotStore', () => {
  it('keeps a structured plan current across full and delta updates', () => {
    let nowMs = Date.parse('2026-08-20T00:00:00.000Z')
    const store = new ActivePlanSnapshotStore({ now: () => nowMs })
    store.applyNotification('turn/started', { threadId: 'thread-a', turn: { id: 'turn-a' } }, 1)
    store.applyNotification('turn/plan/updated', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      explanation: 'Ship safely',
      plan: [
        { step: 'Build', status: 'completed' },
        { step: 'Publish', status: 'in_progress' },
      ],
    }, 1)
    nowMs += 10
    store.applyNotification('item/plan/delta', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      delta: '\nchecking registry',
    }, 1)

    expect(store.getSnapshots()).toEqual([expect.objectContaining({
      threadId: 'thread-a',
      turnId: 'turn-a',
      messageId: 'turn-a:plan',
      explanation: 'Ship safely',
      steps: [
        { step: 'Build', status: 'completed' },
        { step: 'Publish', status: 'inProgress' },
      ],
      revision: 2,
      lifecycle: 'live',
      text: expect.stringMatching(/Publish\nchecking registry$/u),
    })])
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

  it('ignores malformed notifications and empty deltas', () => {
    const store = new ActivePlanSnapshotStore()
    store.applyNotification('turn/plan/updated', { threadId: '', turnId: 'turn-a', plan: [] })
    store.applyNotification('item/plan/delta', { threadId: 'thread-a', turnId: 'turn-a', delta: '' })
    store.applyNotification('other/event', { threadId: 'thread-a', turnId: 'turn-a' })
    expect(store.getSnapshots()).toEqual([])
  })
})
