import { describe, expect, it } from 'vitest'
import type { UiMessage, UiPlanSummary } from './types/codex'
import {
  MAX_PLAN_SUMMARIES_PER_THREAD,
  MAX_PLAN_SUMMARY_TEXT_LENGTH,
  mergePlanSummaryMessages,
  planIdentity,
  normalizePlanSummary,
  normalizePlanSummaryHistoryState,
  upsertPlanSummary,
} from './planSummaryHistory'

function summary(turnId: string, overrides: Partial<UiPlanSummary> = {}): UiPlanSummary {
  return {
    id: `plan-summary:${turnId}`,
    kind: 'checklist',
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

  it('retains multiple plan identities in one turn and rejects stale revisions', () => {
    const checklist = summary('same-turn')
    const firstProposal = summary('same-turn', { kind: 'proposal', itemId: 'proposal-a', messageId: 'proposal-a', text: 'Draft A', steps: [] })
    const secondProposal = summary('same-turn', { kind: 'proposal', itemId: 'proposal-b', messageId: 'proposal-b', text: 'Draft B', steps: [] })
    let rows = upsertPlanSummary([], checklist)
    rows = upsertPlanSummary(rows, firstProposal)
    rows = upsertPlanSummary(rows, secondProposal)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(planIdentity)).size).toBe(3)
    expect(upsertPlanSummary(rows, { ...firstProposal, revision: 1, text: 'stale' })).toBe(rows)
    expect(normalizePlanSummaryHistoryState({ 'thread-a': rows })['thread-a']).toHaveLength(3)
  })

  it('does not declare a partial checklist completed just because its turn ended', () => {
    expect(normalizePlanSummary(summary('partial', { steps: [{ step: 'unfinished', status: 'inProgress' }] }))?.lifecycle).toBe('incomplete')
    expect(normalizePlanSummary(summary('done'))?.lifecycle).toBe('completed')
    expect(normalizePlanSummary(summary('draft', { kind: 'proposal', steps: [], text: 'Draft only' }))?.lifecycle).toBe('completed')
    expect(normalizePlanSummary({ ...summary('unconfirmed'), lifecycle: 'unconfirmed' })).toBeNull()
  })

  it('marks a truncated checklist incomplete when omitted steps may still be pending', () => {
    const normalized = normalizePlanSummary(summary('too-many', { steps: [
      ...Array.from({ length: 64 }, () => ({ step: 'Known done', status: 'completed' as const })),
      { step: 'Omitted pending work', status: 'pending' },
    ] }))
    expect(normalized).toMatchObject({ lifecycle: 'incomplete', truncated: true })
    expect(normalized?.steps).toHaveLength(64)
    expect(normalizePlanSummary(summary('already-cut', { truncated: true }))?.lifecycle).toBe('incomplete')
    expect(normalizePlanSummary(summary('cut-text', { steps: [{ step: 'x'.repeat(5_000), status: 'completed' }] }))).toMatchObject({ truncated: true, lifecycle: 'incomplete' })
  })

  it('bounds aggregate structured plan text instead of multiplying the per-step limit', () => {
    const normalized = normalizePlanSummary({
      ...summary('turn-large'),
      explanation: 'e'.repeat(4_096),
      steps: Array.from({ length: 64 }, (_, index) => ({
        step: `${index}:${'x'.repeat(4_096)}`,
        status: 'pending',
      })),
    })
    expect(normalized).not.toBeNull()
    const structuredCharacters = (normalized?.explanation?.length ?? 0)
      + (normalized?.steps.reduce((sum, step) => sum + step.step.length, 0) ?? 0)
    expect(structuredCharacters).toBeLessThanOrEqual(MAX_PLAN_SUMMARY_TEXT_LENGTH)
    expect(normalized?.text.length).toBeLessThanOrEqual(MAX_PLAN_SUMMARY_TEXT_LENGTH)
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

  it('does not append unloaded summaries or confuse a native proposal with a checklist', () => {
    expect(mergePlanSummaryMessages(messages, [summary('turn-missing')])).toEqual(messages)
    const nativePlan: UiMessage = {
      id: 'native-plan',
      role: 'assistant',
      text: '- [x] native',
      messageType: 'plan',
      turnId: 'turn-a',
    }
    const merged = mergePlanSummaryMessages([...messages, nativePlan], [summary('turn-a')])
    expect(merged).toContainEqual(expect.objectContaining({ messageType: 'plan.summary', plan: expect.objectContaining({ kind: 'checklist' }) }))
    expect(merged.find((message) => message.id === 'native-plan')).toEqual(nativePlan)
  })

  it('merges proposal metadata only into the native item with the same identity', () => {
    const native = (id: string): UiMessage => ({ id, role: 'assistant', text: 'Historical draft', messageType: 'plan', turnId: 'turn-a', plan: { kind: 'proposal', itemId: id, steps: [] } })
    const proposal = summary('turn-a', { kind: 'proposal', itemId: 'draft-a', messageId: 'draft-a', text: 'Authoritative completed draft', steps: [] })
    const merged = mergePlanSummaryMessages([...messages, native('draft-a'), native('draft-b')], [summary('turn-a'), proposal])
    expect(merged.filter(row => row.plan?.kind === 'proposal')).toHaveLength(2)
    expect(merged.find(row => row.id === 'draft-a')?.text).toBe('Authoritative completed draft')
    expect(merged.find(row => row.id === 'draft-b')?.text).toBe('Historical draft')
    expect(merged.filter(row => row.plan?.kind === 'checklist')).toHaveLength(1)
  })

})
