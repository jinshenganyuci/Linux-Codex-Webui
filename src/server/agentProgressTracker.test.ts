import { describe, expect, it } from 'vitest'
import { AgentProgressTracker } from './agentProgressTracker'

describe('AgentProgressTracker', () => {
  it('tracks parallel and nested agents from real app-server item shapes', () => {
    let now = 1_000
    const tracker = new AgentProgressTracker({ now: () => now })
    const rootThreadId = 'root-thread'

    tracker.handleNotification('turn/started', {
      threadId: rootThreadId,
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, now)

    for (const [index, path] of ['package_scripts', 'thread_live_overlay', 'bridge_item_events'].entries()) {
      now += 100
      tracker.handleNotification('item/completed', {
        threadId: rootThreadId,
        turnId: 'root-turn',
        item: {
          type: 'subAgentActivity',
          id: `spawn-${index}`,
          agentPath: `/root/${path}`,
          agentThreadId: `child-${index}`,
          kind: 'started',
        },
        completedAtMs: now,
      }, 1, now)
    }

    now += 100
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'child-1',
        parentThreadId: rootThreadId,
        agentNickname: 'Wegener',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: rootThreadId,
              depth: 1,
              agent_path: '/root/thread_live_overlay',
              agent_nickname: 'Wegener',
            },
          },
        },
      },
    }, 1, now)

    now += 100
    tracker.handleNotification('item/completed', {
      threadId: 'child-1',
      turnId: 'child-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-grandchild',
        agentPath: '/root/thread_live_overlay/types_scan',
        agentThreadId: 'grandchild',
        kind: 'started',
      },
      completedAtMs: now,
    }, 1, now)

    now += 100
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'grandchild',
        parentThreadId: 'child-1',
        agentNickname: 'Ohm',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'child-1',
              depth: 2,
              agent_path: '/root/thread_live_overlay/types_scan',
              agent_nickname: 'Ohm',
            },
          },
        },
      },
    }, 1, now)

    now += 100
    tracker.handleNotification('turn/completed', {
      threadId: 'grandchild',
      turn: { id: 'grandchild-turn', status: 'completed' },
      completedAtMs: now,
    }, 1, now)

    now += 100
    tracker.handleNotification('item/completed', {
      threadId: rootThreadId,
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'interrupt-parent',
        agentPath: '/root/thread_live_overlay',
        agentThreadId: 'child-1',
        kind: 'interrupted',
      },
      completedAtMs: now,
    }, 1, now)

    const snapshot = tracker.getSnapshot(rootThreadId)
    expect(snapshot?.phase).toBe('dispatching')
    expect(snapshot?.agents).toHaveLength(4)
    expect(snapshot?.agents.find((agent) => agent.threadId === 'child-1')).toMatchObject({
      nickname: 'Wegener',
      depth: 1,
      status: 'interrupted',
    })
    expect(snapshot?.agents.find((agent) => agent.threadId === 'grandchild')).toMatchObject({
      nickname: 'Ohm',
      parentThreadId: 'child-1',
      depth: 2,
      status: 'completed',
      resultAvailable: true,
    })
  })

  it('keeps a completed agent terminal after trailing telemetry notifications', () => {
    let now = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => now })

    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, now)

    now += 100
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-child',
        agentPath: '/root/child',
        agentThreadId: 'child',
        kind: 'started',
      },
      completedAtMs: now,
    }, 1, now)

    now += 100
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress' },
    }, 1, now)

    now += 100
    tracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { type: 'agentMessage', id: 'child-result', text: '7' },
      completedAtMs: now,
    }, 1, now)

    now += 100
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
      completedAtMs: now,
    }, 1, now)
    const childCompletedAtMs = now

    now += 100
    expect(tracker.handleNotification('thread/tokenUsage/updated', {
      threadId: 'child',
      turnId: 'child-turn',
      tokenUsage: { total: { totalTokens: 42 } },
    }, 1, now)).toEqual([])

    now += 100
    expect(tracker.handleNotification('thread/goal/cleared', {
      threadId: 'child',
    }, 1, now)).toEqual([])

    now += 100
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed' },
      completedAtMs: now,
    }, 1, now)

    expect(tracker.getSnapshot('root')).toMatchObject({
      status: 'completed',
      phase: 'completed',
      agents: [{
        threadId: 'child',
        status: 'completed',
        completedAtMs: childCompletedAtMs,
        resultAvailable: true,
      }],
    })
  })

  it('uses wait calls only as a root phase and does not require agent state fields', () => {
    const tracker = new AgentProgressTracker({ now: () => 2_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-1', status: 'inProgress' },
    })
    tracker.handleNotification('item/started', {
      threadId: 'root',
      turnId: 'turn-1',
      item: {
        type: 'collabAgentToolCall',
        id: 'wait-1',
        tool: 'wait',
        status: 'inProgress',
        receiverThreadIds: [],
        agentsStates: {},
      },
    })

    expect(tracker.getSnapshot('root')?.phase).toBe('waitingForAgents')

    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-1',
      item: {
        type: 'collabAgentToolCall',
        id: 'wait-1',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [],
        agentsStates: {},
      },
    })
    expect(tracker.getSnapshot('root')?.phase).toBe('reasoning')
  })

  it('hydrates an interrupted root and completed child from thread reads and runtime states', () => {
    let now = 10_000
    const tracker = new AgentProgressTracker({ now: () => now })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'root-turn',
          status: 'interrupted',
          items: [{
            type: 'subAgentActivity',
            id: 'spawn-child',
            agentPath: '/root/frontend',
            agentThreadId: 'child',
            kind: 'started',
          }],
        }],
      },
    }, now)

    now += 100
    tracker.ingestThreadRead({
      thread: {
        id: 'child',
        parentThreadId: 'root',
        agentNickname: 'Copernicus',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'root',
              depth: 1,
              agent_path: '/root/frontend',
              agent_nickname: 'Copernicus',
            },
          },
        },
        turns: [{
          id: 'child-turn',
          status: 'completed',
          items: [{ type: 'agentMessage', id: 'answer', text: 'done' }],
        }],
      },
    }, now)

    tracker.applyRuntimeStates('root', [
      { threadId: 'root', state: 'interrupted' },
      { threadId: 'child', state: 'completed' },
    ], now)

    expect(tracker.getSnapshot('root')).toMatchObject({
      status: 'interrupted',
      phase: 'interrupted',
      agents: [{
        threadId: 'child',
        nickname: 'Copernicus',
        status: 'completed',
        resultAvailable: true,
      }],
    })
  })

  it('restores elapsed time from persisted turn timestamps instead of hydration time', () => {
    const startedAtMs = 1_700_000_000_000
    const completedAtMs = startedAtMs + 123_000
    const tracker = new AgentProgressTracker({ now: () => completedAtMs + 999_000 })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'root-turn',
          status: 'completed',
          startedAt: startedAtMs,
          completedAt: completedAtMs,
          items: [],
        }],
      },
    }, completedAtMs + 999_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      startedAtMs,
      updatedAtMs: completedAtMs,
      lastActivityAtMs: completedAtMs,
      status: 'completed',
    })

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      state: 'completed',
      startedAtIso: new Date(startedAtMs).toISOString(),
      completedAtIso: new Date(completedAtMs).toISOString(),
    }], completedAtMs + 999_000)
    tracker.handleNotification('thread/status/changed', {
      threadId: 'root',
      status: { type: 'idle' },
    }, 0, completedAtMs + 999_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      startedAtMs,
      updatedAtMs: completedAtMs,
      lastActivityAtMs: completedAtMs,
      status: 'completed',
    })
  })

  it('hydrates a later completion instead of an overlapping orphaned turn', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [
          { id: 'completed-turn', status: 'completed', startedAtMs: baseMs + 1_000, completedAtMs: baseMs + 4_000, items: [] },
          { id: 'orphaned-turn', status: 'inProgress', startedAtMs: baseMs + 2_000, completedAtMs: null, items: [] },
        ],
      },
    }, baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'completed-turn',
      status: 'completed',
      phase: 'completed',
      startedAtMs: baseMs + 1_000,
      updatedAtMs: baseMs + 4_000,
    })

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'orphaned-turn',
      state: 'interrupted',
      startedAtIso: new Date(baseMs + 2_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'completed-turn',
      status: 'completed',
      phase: 'completed',
      updatedAtMs: baseMs + 4_000,
    })
  })

  it('keeps child activity from an overlapping orphaned turn while correcting the root completion', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [
          {
            id: 'completed-turn',
            status: 'completed',
            startedAtMs: baseMs + 1_000,
            completedAtMs: baseMs + 4_000,
            items: [],
          },
          {
            id: 'orphaned-turn',
            status: 'inProgress',
            startedAtMs: baseMs + 2_000,
            completedAtMs: null,
            items: [{
              type: 'subAgentActivity',
              id: 'spawn-child',
              agentPath: '/root/child',
              agentThreadId: 'child',
              kind: 'started',
            }],
          },
        ],
      },
    }, baseMs + 10_000)
    tracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn',
      state: 'interrupted',
      startedAtIso: new Date(baseMs + 2_500).toISOString(),
      completedAtIso: new Date(baseMs + 3_000).toISOString(),
    }], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'completed-turn',
      status: 'completed',
      phase: 'completed',
      agents: [{ threadId: 'child', status: 'interrupted' }],
    })
  })

  it('does not downgrade completed root or child state with older interruption evidence', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'root-turn',
          status: 'completed',
          startedAtMs: baseMs + 1_000,
          completedAtMs: baseMs + 5_000,
          items: [{ type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' }],
        }],
      },
    }, baseMs + 10_000)
    tracker.ingestThreadRead({
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/child' } } },
        turns: [{
          id: 'child-turn',
          status: 'completed',
          startedAtMs: baseMs + 2_000,
          completedAtMs: baseMs + 4_000,
          items: [{ type: 'agentMessage', id: 'answer', text: 'done' }],
        }],
      },
    }, baseMs + 10_000)

    tracker.applyRuntimeStates('root', [
      { threadId: 'root', turnId: 'root-turn', state: 'interrupted', startedAtIso: new Date(baseMs + 1_000).toISOString(), completedAtIso: new Date(baseMs + 3_000).toISOString() },
      { threadId: 'child', turnId: 'child-turn', state: 'interrupted', startedAtIso: new Date(baseMs + 2_000).toISOString(), completedAtIso: new Date(baseMs + 3_000).toISOString() },
    ], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      status: 'completed',
      phase: 'completed',
      updatedAtMs: baseMs + 5_000,
      agents: [{ threadId: 'child', status: 'completed', completedAtMs: baseMs + 4_000, resultAvailable: true }],
    })
  })

  it('switches to a fresh mismatched runtime turn instead of hiding active work', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: { id: 'root', turns: [{ id: 'completed-turn', status: 'completed', startedAtMs: baseMs + 1_000, completedAtMs: baseMs + 4_000, items: [] }] },
    }, baseMs + 10_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'live-turn',
      state: 'running',
      startedAtIso: new Date(baseMs + 2_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'live-turn', status: 'running', phase: 'preparing', startedAtMs: baseMs + 2_000 })
  })

  it('keeps agents hydrated from the fresh runtime turn when another overlapping turn ended later', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [
          {
            id: 'terminal-turn',
            status: 'interrupted',
            startedAtMs: baseMs + 1_000,
            completedAtMs: baseMs + 5_000,
            items: [],
          },
          {
            id: 'live-turn',
            status: 'inProgress',
            startedAtMs: baseMs + 2_000,
            completedAtMs: null,
            items: [{
              type: 'subAgentActivity',
              id: 'spawn-child',
              agentPath: '/root/child',
              agentThreadId: 'child',
              kind: 'started',
            }],
          },
        ],
      },
    }, baseMs + 10_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'live-turn',
      state: 'running',
      startedAtIso: new Date(baseMs + 2_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'live-turn',
      status: 'running',
      agents: [{ threadId: 'child', status: 'running' }],
    })
  })

  it('applies a later interruption from a different overlapping turn', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.ingestThreadRead({
      thread: { id: 'root', turns: [{ id: 'turn-a', status: 'completed', startedAtMs: baseMs + 1_000, completedAtMs: baseMs + 4_000, items: [] }] },
    }, baseMs + 10_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-b',
      state: 'interrupted',
      startedAtIso: new Date(baseMs + 2_000).toISOString(),
      completedAtIso: new Date(baseMs + 5_000).toISOString(),
    }], baseMs + 10_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-b', status: 'interrupted', phase: 'interrupted', updatedAtMs: baseMs + 5_000 })
  })

  it('revives an interrupted turn when runtime still has a fresh owner', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 10_000 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-b' } }, 1, baseMs + 1_000)
    tracker.markProcessExit(baseMs + 2_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-b',
      state: 'running',
      startedAtIso: new Date(baseMs + 1_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'preparing' })
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-b',
      item: { type: 'subAgentActivity', id: 'fresh-child-start', agentPath: '/root/child-a', agentThreadId: 'child-a', kind: 'started' },
    }, 1, baseMs + 4_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-b',
      item: { type: 'collabAgentToolCall', id: 'fresh-collab-spawn', tool: 'spawnAgent', receiverThreadIds: ['child-b'] },
    }, 1, baseMs + 4_100)
    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'turn-b',
          status: 'inProgress',
          startedAtMs: baseMs + 1_000,
          items: [{ type: 'subAgentActivity', id: 'persisted-child-start', agentPath: '/root/child-c', agentThreadId: 'child-c', kind: 'started' }],
        }],
      },
    }, baseMs + 4_200)
    expect(tracker.getSnapshot('root')?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'child-a', status: 'running' }),
      expect.objectContaining({ threadId: 'child-b', status: 'running' }),
      expect.objectContaining({ threadId: 'child-c', status: 'running' }),
    ]))
  })

  it('records the turn identity when completion arrives before its start event', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 2_000 })

    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: {
        id: 'turn-b',
        status: 'completed',
        startedAtMs: baseMs + 1_000,
        completedAtMs: baseMs + 2_000,
      },
    }, 1, baseMs + 2_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-b',
      status: 'completed',
      startedAtMs: baseMs + 1_000,
    })
  })

  it('fills a missing turn identity from an authoritative running runtime', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { status: 'completed' },
    }, 1, baseMs + 2_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-b',
      state: 'running',
      startedAtIso: new Date(baseMs + 1_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-b',
      status: 'running',
      phase: 'preparing',
    })
  })

  it('fills a missing turn identity from an authoritative completed runtime', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { status: 'completed' },
    }, 1, baseMs + 2_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-b',
      state: 'completed',
      startedAtIso: new Date(baseMs + 1_000).toISOString(),
      completedAtIso: new Date(baseMs + 2_000).toISOString(),
    }], baseMs + 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-b',
      status: 'completed',
      phase: 'completed',
    })
  })

  it('replaces an unidentified terminal state with a later authoritative interruption', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 4_000 })
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { status: 'completed' },
    }, 1, baseMs + 2_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-b',
      state: 'interrupted',
      startedAtIso: new Date(baseMs + 1_000).toISOString(),
      completedAtIso: new Date(baseMs + 3_000).toISOString(),
    }], baseMs + 4_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-b',
      status: 'interrupted',
      phase: 'interrupted',
    })
  })

  it('does not replace a confirmed errored child with generic completed runtime state', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 5_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-child',
        agentPath: '/root/child',
        agentThreadId: 'child',
        kind: 'started',
      },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'failed' },
      completedAtMs: baseMs + 3_000,
    }, 1, baseMs + 3_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn',
      state: 'completed',
      startedAtIso: new Date(baseMs + 2_000).toISOString(),
      completedAtIso: new Date(baseMs + 3_000).toISOString(),
    }], baseMs + 5_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      agents: [{ threadId: 'child', status: 'errored' }],
    })
  })

  it.each([
    ['completed', 'completed'],
    ['interrupted', 'interrupted'],
    ['failed', 'errored'],
  ] as const)('does not revive a %s child from replayed active or started events', (completedStatus, expectedStatus) => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 6_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, baseMs + 1_000)
    const spawnItem = {
      type: 'subAgentActivity',
      id: 'spawn-child',
      agentPath: '/root/child',
      agentThreadId: 'child',
      kind: 'started',
    }
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: spawnItem,
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress' },
    }, 1, baseMs + 2_100)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: completedStatus },
      completedAtMs: baseMs + 3_000,
    }, 1, baseMs + 3_000)

    tracker.handleNotification('thread/status/changed', {
      threadId: 'child',
      status: 'active',
    }, 1, baseMs + 4_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: spawnItem,
      completedAtMs: baseMs + 4_100,
    }, 1, baseMs + 4_100)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress' },
    }, 1, baseMs + 4_200)

    expect(tracker.getSnapshot('root')).toMatchObject({
      agents: [{
        threadId: 'child',
        status: expectedStatus,
        completedAtMs: baseMs + 3_000,
      }],
    })

    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-2', status: 'inProgress' },
    }, 1, baseMs + 5_000)
    expect(tracker.getSnapshot('root')).toMatchObject({
      agents: [{ threadId: 'child', status: 'running', completedAtMs: null }],
    })
  })

  it('restores child timestamps from seconds and prefers explicit millisecond fields', () => {
    const rootStartedAtMs = 1_700_000_000_000
    const rootCompletedAtMs = rootStartedAtMs + 123_000
    const childStartedAtMs = rootStartedAtMs + 20_000
    const childCompletedAtMs = rootStartedAtMs + 80_000
    const hydrationAtMs = rootCompletedAtMs + 999_000
    const tracker = new AgentProgressTracker({ now: () => hydrationAtMs })

    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'root-turn',
          status: 'completed',
          startedAtMs: rootStartedAtMs,
          startedAt: (rootStartedAtMs - 5_000) / 1000,
          completedAtMs: rootCompletedAtMs,
          completedAt: (rootCompletedAtMs - 5_000) / 1000,
          items: [],
        }],
      },
    }, hydrationAtMs)
    tracker.ingestThreadRead({
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'root',
              depth: 1,
              agent_path: '/root/child',
            },
          },
        },
        turns: [{
          id: 'child-turn',
          status: 'completed',
          startedAt: childStartedAtMs / 1000,
          completedAt: childCompletedAtMs / 1000,
          items: [{ type: 'agentMessage', id: 'answer', text: 'done' }],
        }],
      },
    }, hydrationAtMs)

    expect(tracker.getSnapshot('root')).toMatchObject({
      startedAtMs: rootStartedAtMs,
      updatedAtMs: rootCompletedAtMs,
      agents: [{
        threadId: 'child',
        startedAtMs: childStartedAtMs,
        lastActivityAtMs: childCompletedAtMs,
        completedAtMs: childCompletedAtMs,
        status: 'completed',
        currentActivity: '',
        resultAvailable: true,
      }],
    })
  })

  it('marks only active progress as interrupted when the app-server exits', () => {
    const tracker = new AgentProgressTracker({ now: () => 4_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-1', status: 'inProgress' },
    })
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-child',
        agentPath: '/root/child',
        agentThreadId: 'child',
        kind: 'started',
      },
    })

    expect(tracker.markProcessExit(5_000)).toEqual(['root'])
    expect(tracker.getSnapshot('root')).toMatchObject({
      status: 'interrupted',
      phase: 'interrupted',
      agents: [{ status: 'interrupted', completedAtMs: 5_000 }],
    })
  })

  it('bounds structural events and ignores duplicate replay frames', () => {
    let now = 1_000
    const tracker = new AgentProgressTracker({ now: () => now, eventLimit: 20 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-1', status: 'inProgress' },
    })
    for (let index = 0; index < 40; index += 1) {
      now += 1
      const params = {
        threadId: 'root',
        turnId: 'turn-1',
        item: {
          type: 'subAgentActivity',
          id: `spawn-${index}`,
          agentPath: `/root/agent-${index}`,
          agentThreadId: `agent-${index}`,
          kind: 'started',
        },
        completedAtMs: now,
      }
      tracker.handleNotification('item/completed', params, 1, now)
      tracker.handleNotification('item/completed', params, 1, now)
    }

    const snapshot = tracker.getSnapshot('root')
    expect(snapshot?.events.length).toBeLessThanOrEqual(20)
    expect(snapshot?.agents).toHaveLength(40)
  })

  it('ignores notifications from an older app-server generation', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'new-turn', status: 'inProgress' },
    }, 2, 2_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'old-turn', status: 'completed' },
    }, 1, 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'new-turn',
      status: 'running',
      phase: 'preparing',
    })
  })

  it('keeps a newer overlapping turn running when an older turn completes', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_000_000 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-a', status: 'inProgress' } }, 1, 1_700_000_001_000)
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-b', status: 'inProgress' } }, 1, 1_700_000_002_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'completed' },
      completedAtMs: 1_700_000_003_000,
    }, 1, 1_700_000_003_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'preparing' })
  })

  it('lets a later overlapping completion correct an interrupted turn', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_000_000 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-a', status: 'inProgress' } }, 1, 1_700_000_001_000)
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-b', status: 'inProgress' } }, 1, 1_700_000_002_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-b',
      item: { type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
      completedAtMs: 1_700_000_002_100,
    }, 1, 1_700_000_002_100)
    tracker.markProcessExit(1_700_000_002_500)
    tracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { type: 'agentMessage', id: 'late-child-result', text: 'done' },
      completedAtMs: 1_700_000_005_000,
    }, 1, 1_700_000_005_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'completed', startedAtMs: 1_700_000_001_000 },
      completedAtMs: 1_700_000_004_000,
    }, 1, 1_700_000_004_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-a',
      status: 'completed',
      phase: 'completed',
      agents: [{ threadId: 'child', status: 'interrupted' }],
    })
  })

  it('uses root lifecycle time when runtime corrects a turn after later child activity', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_006_000 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-a', status: 'inProgress' } }, 1, 1_700_000_001_000)
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'turn-b', status: 'inProgress' } }, 1, 1_700_000_002_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'turn-b',
      item: { type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
      completedAtMs: 1_700_000_002_100,
    }, 1, 1_700_000_002_100)
    tracker.markProcessExit(1_700_000_003_000)
    tracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { type: 'agentMessage', id: 'late-child-result', text: 'done' },
      completedAtMs: 1_700_000_005_000,
    }, 1, 1_700_000_005_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'root',
      turnId: 'turn-a',
      state: 'completed',
      startedAtIso: new Date(1_700_000_001_000).toISOString(),
      completedAtIso: new Date(1_700_000_004_000).toISOString(),
    }], 1_700_000_006_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'turn-a',
      status: 'completed',
      phase: 'completed',
      mainLastActivityAtMs: 1_700_000_004_000,
      updatedAtMs: 1_700_000_005_000,
      agents: [{ threadId: 'child', status: 'interrupted' }],
    })
  })

  it('reparents a child turn that arrived before its thread metadata', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress' },
    }, 1, 1_000)
    tracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-grandchild',
        agentPath: '/root/child/grandchild',
        agentThreadId: 'grandchild',
        kind: 'started',
      },
    }, 1, 1_100)
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'root',
              depth: 1,
              agent_path: '/root/child',
            },
          },
        },
      },
    }, 1, 1_200)

    expect(tracker.getSnapshot('root')?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'child', parentThreadId: 'root', depth: 1 }),
      expect.objectContaining({ threadId: 'grandchild', parentThreadId: 'child', depth: 2 }),
    ]))
    expect(tracker.getSnapshot('child')?.rootThreadId).toBe('root')
  })

  it('applies each child session model without borrowing another agent value', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    })
    for (const threadId of ['child-a', 'child-b']) {
      tracker.handleNotification('item/completed', {
        threadId: 'root',
        turnId: 'root-turn',
        item: {
          type: 'subAgentActivity',
          id: `spawn-${threadId}`,
          agentPath: `/root/${threadId}`,
          agentThreadId: threadId,
          kind: 'started',
        },
      })
    }

    expect(tracker.applyAgentModelDetails('root', [
      { threadId: 'child-a', model: 'gpt-child-a', reasoningEffort: 'high' },
      { threadId: 'child-b', model: 'gpt-child-b', reasoningEffort: 'ultra' },
      { threadId: 'unknown-child', model: 'not-used', reasoningEffort: 'low' },
    ])).toBe(true)
    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child-a', model: 'gpt-child-a', reasoningEffort: 'high' }),
      expect.objectContaining({ threadId: 'child-b', model: 'gpt-child-b', reasoningEffort: 'ultra' }),
    ])
  })

  it('does not let an old child completion stop a newer child turn', () => {
    const tracker = new AgentProgressTracker({ now: () => 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, 1_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-child',
        agentPath: '/root/child',
        agentThreadId: 'child',
        kind: 'started',
      },
      completedAtMs: 1_100,
    }, 1, 1_100)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'inProgress' },
    }, 1, 1_200)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-b', status: 'inProgress' },
    }, 1, 2_000)

    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'completed' },
      completedAtMs: 3_000,
    }, 1, 3_000)

    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])
  })

  it('does not let an old root-turn item interrupt a child reused by the active turn', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 4_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn-a',
      item: { type: 'subAgentActivity', id: 'spawn-a', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
    }, 1, baseMs + 1_100)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'inProgress', startedAtMs: baseMs + 1_200 },
    }, 1, baseMs + 1_200)
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn-b', status: 'inProgress', startedAtMs: baseMs + 2_000 },
    }, 1, baseMs + 2_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn-b',
      item: { type: 'subAgentActivity', id: 'spawn-b', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
    }, 1, baseMs + 2_100)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-b', status: 'inProgress', startedAtMs: baseMs + 2_200 },
    }, 1, baseMs + 2_200)

    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn-a',
      item: { type: 'collabAgentToolCall', id: 'late-spawn-a', tool: 'spawnAgent', receiverThreadIds: ['child'] },
    }, 1, baseMs + 3_900)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn-a',
      item: { type: 'subAgentActivity', id: 'late-interrupt-a', agentPath: '/root/child', agentThreadId: 'child', kind: 'interrupted' },
    }, 1, baseMs + 4_000)

    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])
  })

  it('uses child runtime turn identity for terminal and restart corrections', () => {
    const tracker = new AgentProgressTracker({ now: () => 4_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, 1_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-child',
        agentPath: '/root/child',
        agentThreadId: 'child',
        kind: 'started',
      },
      completedAtMs: 1_100,
    }, 1, 1_100)
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'inProgress' },
    }, 1, 1_200)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'completed' },
      completedAtMs: 2_000,
    }, 1, 2_000)

    tracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn-b',
      state: 'running',
      startedAtIso: new Date(3_000).toISOString(),
      completedAtIso: null,
    }], 3_000)
    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])

    tracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn-a',
      state: 'interrupted',
      startedAtIso: new Date(1_200).toISOString(),
      completedAtIso: new Date(4_000).toISOString(),
    }], 4_000)
    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])
  })

  it('accepts a newer child terminal turn when its start notification was missed', () => {
    const baseMs = 1_700_000_000_000
    const setupCompletedChild = () => {
      const tracker = new AgentProgressTracker({ now: () => baseMs + 4_000 })
      tracker.handleNotification('turn/started', {
        threadId: 'root',
        turn: { id: 'root-turn', status: 'inProgress', startedAtMs: baseMs + 1_000 },
      }, 1, baseMs + 1_000)
      tracker.handleNotification('item/completed', {
        threadId: 'root',
        turnId: 'root-turn',
        item: {
          type: 'subAgentActivity',
          id: 'spawn-child',
          agentPath: '/root/child',
          agentThreadId: 'child',
          kind: 'started',
        },
        completedAtMs: baseMs + 1_100,
      }, 1, baseMs + 1_100)
      tracker.handleNotification('turn/started', {
        threadId: 'child',
        turn: { id: 'child-turn-a', status: 'inProgress', startedAtMs: baseMs + 1_200 },
      }, 1, baseMs + 1_200)
      tracker.handleNotification('turn/completed', {
        threadId: 'child',
        turn: { id: 'child-turn-a', status: 'completed', startedAtMs: baseMs + 1_200 },
        completedAtMs: baseMs + 2_000,
      }, 1, baseMs + 2_000)
      return tracker
    }

    const notificationTracker = setupCompletedChild()
    notificationTracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn-b', status: 'interrupted', startedAtMs: baseMs + 3_000 },
      completedAtMs: baseMs + 4_000,
    }, 1, baseMs + 4_000)
    expect(notificationTracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'interrupted', completedAtMs: baseMs + 4_000 }),
    ])

    const runtimeTracker = setupCompletedChild()
    runtimeTracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn-b',
      state: 'interrupted',
      startedAtIso: new Date(baseMs + 3_000).toISOString(),
      completedAtIso: new Date(baseMs + 4_000).toISOString(),
    }], baseMs + 4_000)
    expect(runtimeTracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'interrupted', completedAtMs: baseMs + 4_000 }),
    ])

    const threadReadTracker = setupCompletedChild()
    threadReadTracker.ingestThreadRead({
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/child' } } },
        turns: [{
          id: 'child-turn-b',
          status: 'interrupted',
          startedAtMs: baseMs + 3_000,
          completedAtMs: baseMs + 4_000,
          items: [],
        }],
      },
    }, baseMs + 4_000)
    expect(threadReadTracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'interrupted', completedAtMs: baseMs + 4_000 }),
    ])
  })

  it('preserves an orphan child turn identity when metadata reparents it', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 4_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn-a', status: 'completed', startedAtMs: baseMs + 1_000 },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/child' } } },
      },
    }, 1, baseMs + 2_500)

    tracker.applyRuntimeStates('root', [{
      threadId: 'child',
      turnId: 'child-turn-b',
      state: 'running',
      startedAtIso: new Date(baseMs + 3_000).toISOString(),
      completedAtIso: null,
    }], baseMs + 3_000)

    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])
  })

  it('does not let same-turn orphan running state overwrite a terminal child', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress', startedAtMs: baseMs + 1_100 },
    }, 1, baseMs + 1_100)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: { type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
      completedAtMs: baseMs + 1_200,
    }, 1, baseMs + 1_200)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed', startedAtMs: baseMs + 1_000 },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/child' } } },
      },
    }, 1, baseMs + 3_000)

    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({
        threadId: 'child',
        status: 'completed',
        completedAtMs: baseMs + 2_000,
        currentActivity: '',
        resultAvailable: true,
      }),
    ])
  })

  it('does not let a late start revive an overlapping turn already known terminal', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 5_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-b', status: 'inProgress', startedAtMs: baseMs + 2_000 },
    }, 1, baseMs + 2_000)
    tracker.markProcessExit(baseMs + 3_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'completed', startedAtMs: baseMs + 1_000 },
      completedAtMs: baseMs + 4_000,
    }, 1, baseMs + 4_000)

    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-b', status: 'inProgress', startedAtMs: baseMs + 2_000 },
    }, 1, baseMs + 5_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-a', status: 'completed', phase: 'completed' })
  })

  it('does not revive terminal root or child turns from stale running thread reads', () => {
    const baseMs = 1_700_000_000_000
    const rootTracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    rootTracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    rootTracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed', startedAtMs: baseMs + 1_000 },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    rootTracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{
          id: 'root-turn',
          status: 'inProgress',
          startedAtMs: baseMs + 1_000,
          items: [{ type: 'subAgentActivity', id: 'stale-spawn', agentPath: '/root/stale-child', agentThreadId: 'stale-child', kind: 'started' }],
        }],
      },
    }, baseMs + 3_000)
    expect(rootTracker.getSnapshot('root')).toMatchObject({ turnId: 'root-turn', status: 'completed', phase: 'completed', agents: [] })

    const childTracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    childTracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    childTracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: { type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
      completedAtMs: baseMs + 1_100,
    }, 1, baseMs + 1_100)
    childTracker.handleNotification('turn/started', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'inProgress', startedAtMs: baseMs + 1_200 },
    }, 1, baseMs + 1_200)
    childTracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed', startedAtMs: baseMs + 1_200 },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)
    childTracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { type: 'subAgentActivity', id: 'late-direct-nested', agentPath: '/root/child/grandchild', agentThreadId: 'grandchild', kind: 'started' },
    }, 1, baseMs + 2_100)
    childTracker.handleNotification('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { type: 'collabAgentToolCall', id: 'late-direct-collab', tool: 'spawnAgent', receiverThreadIds: ['grandchild'] },
    }, 1, baseMs + 2_200)
    childTracker.ingestThreadRead({
      thread: {
        id: 'child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/child' } } },
        turns: [{
          id: 'child-turn',
          status: 'inProgress',
          startedAtMs: baseMs + 1_200,
          items: [{ type: 'subAgentActivity', id: 'stale-nested-spawn', agentPath: '/root/child/grandchild', agentThreadId: 'grandchild', kind: 'started' }],
        }],
      },
    }, baseMs + 3_000)
    expect(childTracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'completed', completedAtMs: baseMs + 2_000 }),
    ])
  })

  it('keeps a newer running root when an older running thread read arrives', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-b', status: 'inProgress', startedAtMs: baseMs + 2_000 },
    }, 1, baseMs + 2_000)

    tracker.ingestThreadRead({
      thread: {
        id: 'root',
        turns: [{ id: 'turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000, items: [] }],
      },
    }, baseMs + 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'preparing' })

    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'turn-a', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 4_000)
    expect(tracker.getSnapshot('root')).toMatchObject({ turnId: 'turn-b', status: 'running', phase: 'preparing' })
  })

  it('uses UUIDv7 order when child turn timestamps are absent', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_010_000 })
    const childTurnA = '018bcfe5-6cb0-7000-8000-000000000001'
    const childTurnB = '018bcfe5-73b8-7000-8000-000000000002'
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'root-turn', status: 'inProgress' } }, 1, 1_700_000_001_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: { type: 'subAgentActivity', id: 'spawn-child', agentPath: '/root/child', agentThreadId: 'child', kind: 'started' },
    }, 1, 1_700_000_001_100)
    tracker.handleNotification('turn/started', { threadId: 'child', turn: { id: childTurnA, status: 'inProgress', startedAt: null } }, 1, 1_700_000_002_000)
    tracker.handleNotification('turn/started', { threadId: 'child', turn: { id: childTurnB, status: 'inProgress', startedAt: null } }, 1, 1_700_000_003_000)
    tracker.handleNotification('turn/started', { threadId: 'child', turn: { id: childTurnA, status: 'inProgress', startedAt: null } }, 1, 1_700_000_004_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: childTurnA, status: 'completed', startedAt: null },
    }, 1, 1_700_000_005_000)
    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'running', completedAtMs: null }),
    ])

    tracker.handleNotification('turn/completed', {
      threadId: 'child',
      turn: { id: childTurnB, status: 'interrupted', startedAt: null },
    }, 1, 1_700_000_006_000)
    expect(tracker.getSnapshot('root')?.agents).toEqual([
      expect.objectContaining({ threadId: 'child', status: 'interrupted' }),
    ])
  })

  it('keeps orphan turn indexes bounded when the node limit is full', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_000_000, nodeLimit: 4 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'root-turn', status: 'inProgress' } })
    for (let index = 0; index < 4; index += 1) {
      tracker.handleNotification('item/completed', {
        threadId: 'root',
        turnId: 'root-turn',
        item: { type: 'subAgentActivity', id: `spawn-${index}`, agentPath: `/root/child-${index}`, agentThreadId: `child-${index}`, kind: 'started' },
      })
    }
    for (let index = 0; index < 20; index += 1) {
      const threadId = `orphan-${index}`
      tracker.handleNotification('turn/started', { threadId, turn: { id: `orphan-turn-${index}`, status: 'inProgress' } })
      tracker.handleNotification('thread/started', {
        thread: {
          id: threadId,
          parentThreadId: 'root',
          source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: `/root/${threadId}` } } },
        },
      })
    }

    const internals = tracker as unknown as {
      progressByRootThreadId: Map<string, {
        agentTurnIdByThreadId: Map<string, string>
        agentTurnStartedAtMsByThreadId: Map<string, number>
      }>
      rootByThreadId: Map<string, string>
    }
    const progress = internals.progressByRootThreadId.get('root')
    expect(tracker.getSnapshot('root')?.agents).toHaveLength(4)
    expect(progress?.agentTurnIdByThreadId.size ?? 0).toBeLessThanOrEqual(4)
    expect(progress?.agentTurnStartedAtMsByThreadId.size ?? 0).toBeLessThanOrEqual(4)
    expect(internals.rootByThreadId.size).toBeLessThanOrEqual(5)
  })

  it('cleans nested orphan indexes that cannot fit during partial migration', () => {
    const tracker = new AgentProgressTracker({ now: () => 1_700_000_000_000, nodeLimit: 4 })
    tracker.handleNotification('turn/started', { threadId: 'root', turn: { id: 'root-turn', status: 'inProgress' } })
    for (let index = 0; index < 3; index += 1) {
      tracker.handleNotification('item/completed', {
        threadId: 'root',
        turnId: 'root-turn',
        item: { type: 'subAgentActivity', id: `spawn-${index}`, agentPath: `/root/child-${index}`, agentThreadId: `child-${index}`, kind: 'started' },
      })
    }
    tracker.handleNotification('turn/started', {
      threadId: 'orphan-parent',
      turn: { id: 'orphan-turn', status: 'inProgress' },
    })
    for (let index = 0; index < 4; index += 1) {
      tracker.handleNotification('item/completed', {
        threadId: 'orphan-parent',
        turnId: 'orphan-turn',
        item: {
          type: 'subAgentActivity',
          id: `spawn-nested-${index}`,
          agentPath: `/root/orphan-parent/nested-${index}`,
          agentThreadId: `nested-${index}`,
          kind: 'started',
        },
      })
    }
    tracker.handleNotification('thread/started', {
      thread: {
        id: 'orphan-parent',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/orphan-parent' } } },
      },
    })

    const internals = tracker as unknown as {
      progressByRootThreadId: Map<string, unknown>
      rootByThreadId: Map<string, string>
    }
    expect(tracker.getSnapshot('root')?.agents).toHaveLength(4)
    expect(internals.progressByRootThreadId.size).toBe(1)
    expect(internals.rootByThreadId.size).toBeLessThanOrEqual(5)
  })

  it('keeps a terminal root turn terminal after late same-turn activity', () => {
    const tracker = new AgentProgressTracker({ now: () => 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, 1_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed' },
      completedAtMs: 2_000,
    }, 1, 2_000)
    tracker.handleNotification('item/started', {
      threadId: 'root',
      turnId: 'root-turn',
      startedAtMs: 3_000,
      item: { type: 'reasoning', id: 'late-reasoning' },
    }, 1, 3_000)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: { type: 'subAgentActivity', id: 'late-child-start', agentPath: '/root/late-child', agentThreadId: 'late-child', kind: 'started' },
    }, 1, 3_100)
    tracker.handleNotification('item/completed', {
      threadId: 'root',
      turnId: 'root-turn',
      item: { type: 'collabAgentToolCall', id: 'late-collab-spawn', tool: 'spawnAgent', receiverThreadIds: ['late-child'] },
    }, 1, 3_200)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'root-turn',
      status: 'completed',
      phase: 'completed',
      agents: [],
    })
  })

  it('keeps a terminal root turn terminal after a duplicate start', () => {
    const tracker = new AgentProgressTracker({ now: () => 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
    }, 1, 1_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed' },
      completedAtMs: 2_000,
    }, 1, 2_000)
    const originalStartedAtMs = tracker.getSnapshot('root')?.startedAtMs

    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress' },
      startedAtMs: 3_000,
    }, 1, 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'root-turn',
      status: 'completed',
      phase: 'completed',
      startedAtMs: originalStartedAtMs,
    })
  })

  it('does not register late child metadata as running under a terminal root', () => {
    const baseMs = 1_700_000_000_000
    const tracker = new AgentProgressTracker({ now: () => baseMs + 3_000 })
    tracker.handleNotification('turn/started', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'inProgress', startedAtMs: baseMs + 1_000 },
    }, 1, baseMs + 1_000)
    tracker.handleNotification('turn/completed', {
      threadId: 'root',
      turn: { id: 'root-turn', status: 'completed', startedAtMs: baseMs + 1_000 },
      completedAtMs: baseMs + 2_000,
    }, 1, baseMs + 2_000)

    tracker.handleNotification('thread/started', {
      thread: {
        id: 'late-child',
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/late-child' } } },
      },
    }, 1, baseMs + 3_000)

    expect(tracker.getSnapshot('root')).toMatchObject({
      turnId: 'root-turn',
      status: 'completed',
      phase: 'completed',
      agents: [expect.objectContaining({ threadId: 'late-child', status: 'interrupted' })],
    })
  })
})
