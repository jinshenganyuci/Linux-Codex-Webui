import { describe, expect, it } from 'vitest'
import type { UiMessage, UiPlanSummary } from './types/codex'
import {
  MAX_PLAN_SUMMARIES_PER_THREAD,
  mergePlanSummaryMessages,
  normalizePlanSummary,
  normalizePlanSummaryHistoryState,
  upsertPlanSummary,
} from './planSummaryHistory'

function summary(turnId: string, overrides: Partial<UiPlanSummary> = {}): UiPlanSummary {
  return {
    id: `plan-summary:${turnId}`,
    threadId: 'thread-a',
    turnId,
    messageId: `${turnId}:plan`,
    text: `- [x] ${turnId}`,
    steps: [{ step: turnId, status: 'completed' }],
    revision: 2,
    lifecycle: 'completed',
    createdAtIso: '2026-08-26T10:00:05.000Z',
    updatedAtIso: '2026-08-26T10:00:10.000Z',
    ...overrides,
  }
}

describe('plan summary history normalization', () => {
  it('accepts terminal summaries and rejects live snapshots', () => {
    expect(normalizePlanSummary(summary('turn-a'))).toEqual(summary('turn-a'))
    expect(normalizePlanSummary({ ...summary('turn-a'), lifecycle: 'live' })).toBeNull()
  })

  it('deduplicates by turn and bounds retained summaries', () => {
    let rows: UiPlanSummary[] = []
    for (let index = 0; index <= MAX_PLAN_SUMMARIES_PER_THREAD; index += 1) {
      rows = upsertPlanSummary(rows, summary(`turn-${index}`, {
        createdAtIso: new Date(Date.UTC(2026, 7, 26, 10, 0, index)).toISOString(),
      }))
    }
    rows = upsertPlanSummary(rows, summary('turn-128', {
      lifecycle: 'failed',
      revision: 3,
      createdAtIso: new Date(Date.UTC(2026, 7, 26, 10, 0, 128)).toISOString(),
    }))
    expect(rows).toHaveLength(MAX_PLAN_SUMMARIES_PER_THREAD)
    expect(rows[0]?.turnId).toBe('turn-1')
    expect(rows.at(-1)).toMatchObject({ turnId: 'turn-128', lifecycle: 'failed', revision: 3 })
    expect(normalizePlanSummaryHistoryState({ threads: { 'thread-a': rows } })).toEqual({ 'thread-a': rows })
  })
})

describe('mergePlanSummaryMessages', () => {
  const messages: UiMessage[] = [
    {
      id: 'user-a',
      role: 'user',
      text: 'start',
      turnId: 'turn-a',
      turnIndex: 4,
      timestampIso: '2026-08-26T10:00:00.000Z',
    },
    {
      id: 'answer-a',
      role: 'assistant',
      text: 'done',
      turnId: 'turn-a',
      turnIndex: 4,
      timestampIso: '2026-08-26T10:00:20.000Z',
    },
    {
      id: 'user-b',
      role: 'user',
      text: 'next',
      turnId: 'turn-b',
      turnIndex: 5,
      timestampIso: '2026-08-26T10:01:00.000Z',
    },
  ]

  it('inserts a terminal summary inside its own turn instead of appending it to the tail', () => {
    const merged = mergePlanSummaryMessages(messages, [summary('turn-a')])
    expect(merged.map((message) => message.id)).toEqual(['user-a', 'plan-summary:turn-a', 'answer-a', 'user-b'])
    expect(merged[1]).toMatchObject({
      messageType: 'plan.summary',
      turnId: 'turn-a',
      turnIndex: 4,
      plan: { lifecycle: 'completed', isStreaming: false },
    })
  })

  it('does not append summaries for unloaded turns and lets a native plan win', () => {
    expect(mergePlanSummaryMessages(messages, [summary('turn-missing')])).toEqual(messages)
    const nativePlan: UiMessage = {
      id: 'native-plan',
      role: 'assistant',
      text: '- [x] native',
      messageType: 'plan',
      turnId: 'turn-a',
    }
    const merged = mergePlanSummaryMessages([...messages, nativePlan], [summary('turn-a')])
    expect(merged).not.toContainEqual(expect.objectContaining({ messageType: 'plan.summary' }))
    expect(merged.find((message) => message.id === 'native-plan')).toMatchObject({
      plan: { lifecycle: 'completed', isStreaming: false },
    })
  })
})
