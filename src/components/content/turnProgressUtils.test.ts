import { describe, expect, it } from 'vitest'
import type { UiAgentProgressNode, UiTurnProgress } from '../../types/codex'
import {
  agentDisplayName,
  agentModelDetailSegments,
  countAgentProgress,
  formatProgressDuration,
  isAgentNodeStale,
  isAgentProgressStale,
  orderedAgentProgressNodes,
  agentDurationMs,
  progressDurationMs,
} from './turnProgressUtils'

function agent(threadId: string, parentThreadId: string, depth: number, status: UiAgentProgressNode['status'] = 'running'): UiAgentProgressNode {
  return {
    threadId,
    parentThreadId,
    path: `/root/${threadId}`,
    nickname: '',
    depth,
    taskSummary: '',
    model: '',
    reasoningEffort: '',
    status,
    startedAtMs: depth * 100,
    lastActivityAtMs: 1_000,
    completedAtMs: null,
    currentActivity: '',
    resultAvailable: status === 'completed',
  }
}

function progress(agents: UiAgentProgressNode[]): UiTurnProgress {
  return {
    rootThreadId: 'root',
    turnId: 'turn',
    status: 'running',
    phase: 'dispatching',
    startedAtMs: 100,
    lastActivityAtMs: 1_000,
    mainLastActivityAtMs: 900,
    updatedAtMs: 1_000,
    agents,
    events: [],
  }
}

describe('turnProgressUtils', () => {
  it('orders six parallel and nested agents as one stable tree', () => {
    const snapshot = progress([
      agent('child-b', 'root', 1),
      agent('grandchild-a', 'child-a', 2),
      agent('child-a', 'root', 1),
      agent('child-c', 'root', 1),
      agent('grandchild-b', 'child-b', 2),
      agent('child-d', 'root', 1),
    ])
    expect(orderedAgentProgressNodes(snapshot).map((node) => node.threadId)).toEqual([
      'child-a',
      'grandchild-a',
      'child-b',
      'grandchild-b',
      'child-c',
      'child-d',
    ])
  })

  it('counts active, completed, interrupted, and failed agents', () => {
    const snapshot = progress([
      agent('a', 'root', 1, 'starting'),
      agent('b', 'root', 1, 'running'),
      agent('c', 'root', 1, 'completed'),
      agent('d', 'root', 1, 'interrupted'),
      agent('e', 'root', 1, 'errored'),
    ])
    expect(countAgentProgress(snapshot)).toEqual({ total: 5, active: 2, completed: 1, interrupted: 1, failed: 1 })
  })

  it('marks silent work stale only while the notification stream is connected', () => {
    const snapshot = progress([agent('a', 'root', 1)])
    expect(isAgentProgressStale(snapshot, 50_000, 'connected')).toBe(true)
    expect(isAgentProgressStale(snapshot, 50_000, 'reconnecting')).toBe(false)
    expect(isAgentNodeStale(snapshot.agents[0], 50_000, 'connected')).toBe(true)
  })

  it('formats names and elapsed durations compactly', () => {
    expect(agentDisplayName(agent('frontend_scan', 'root', 1), 0)).toBe('frontend_scan')
    expect(formatProgressDuration(65_000)).toBe('1m 5s')
  })

  it('shows only model details supplied by that child agent', () => {
    expect(agentModelDetailSegments({
      ...agent('child', 'root', 1),
      model: 'gpt-child',
      reasoningEffort: 'ultra',
    })).toEqual(['Model: gpt-child', 'Thinking: ultra'])
    expect(agentModelDetailSegments({
      ...agent('child', 'root', 1),
      model: 'gpt-child',
    })).toEqual(['Model: gpt-child'])
    expect(agentModelDetailSegments(agent('child', 'root', 1))).toEqual([])
  })

  it('freezes root and agent durations after they reach a terminal state', () => {
    const completedAgent = {
      ...agent('completed-agent', 'root', 1, 'completed'),
      startedAtMs: 2_000,
      lastActivityAtMs: 7_000,
      completedAtMs: 8_000,
    }
    const completedProgress = {
      ...progress([completedAgent]),
      status: 'completed' as const,
      phase: 'completed' as const,
      startedAtMs: 1_000,
      updatedAtMs: 11_000,
      events: [{
        id: 'turn:turn:completed',
        atMs: 11_000,
        kind: 'turnCompleted',
        threadId: 'root',
        agentThreadId: '',
        phase: 'completed' as const,
        detail: 'completed',
      }],
    }

    expect(progressDurationMs(completedProgress, 20_000)).toBe(10_000)
    expect(progressDurationMs(completedProgress, 80_000)).toBe(10_000)
    expect(progressDurationMs({ ...completedProgress, updatedAtMs: 70_000 }, 80_000)).toBe(10_000)
    expect(agentDurationMs(completedAgent, 20_000)).toBe(6_000)
    expect(agentDurationMs(completedAgent, 80_000)).toBe(6_000)
  })

  it('continues active durations against the current clock', () => {
    const runningAgent = {
      ...agent('running-agent', 'root', 1),
      startedAtMs: 2_000,
    }
    const runningProgress = {
      ...progress([runningAgent]),
      startedAtMs: 1_000,
    }

    expect(progressDurationMs(runningProgress, 11_000)).toBe(10_000)
    expect(agentDurationMs(runningAgent, 12_000)).toBe(10_000)
  })
})
