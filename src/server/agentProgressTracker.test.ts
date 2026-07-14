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
})
