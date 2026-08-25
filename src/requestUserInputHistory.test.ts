import { describe, expect, it } from 'vitest'
import type { UiMessage, UiRequestUserInputSummary, UiServerRequest } from './types/codex'
import {
  buildRequestUserInputSummary,
  MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD,
  mergeRequestUserInputSummaryMessages,
  normalizeRequestUserInputHistoryState,
  upsertRequestUserInputSummary,
} from './requestUserInputHistory'

function request(overrides: Partial<UiServerRequest> = {}): UiServerRequest {
  return {
    id: 7,
    generation: 3,
    method: 'item/tool/requestUserInput',
    threadId: 'thread-a',
    turnId: 'turn-a',
    itemId: 'item-a',
    receivedAtIso: '2026-08-25T10:00:00.000Z',
    params: {
      questions: [
        { id: 'kind', header: 'Website type', question: 'What are you building?' },
        { id: 'token', header: 'Token', question: 'Paste a token', isSecret: true },
      ],
    },
    ...overrides,
  }
}

function answeredSummary(overrides: Partial<UiRequestUserInputSummary> = {}): UiRequestUserInputSummary {
  const summary = buildRequestUserInputSummary(request(), 'answered', {
    answers: {
      kind: { answers: ['Product site'] },
      token: { answers: ['must-not-persist'] },
    },
  }, '2026-08-25T10:00:10.000Z')
  if (!summary) throw new Error('fixture summary was not created')
  return { ...summary, ...overrides }
}

describe('request user input history', () => {
  it('builds an answered summary and redacts secret answers', () => {
    const summary = answeredSummary()
    expect(summary.status).toBe('answered')
    expect(summary.questions[0]?.answers).toEqual(['Product site'])
    expect(summary.questions[1]).toMatchObject({ isSecret: true, answers: [] })
  })

  it('records an invalidated request as unanswered without inventing answers', () => {
    const summary = buildRequestUserInputSummary(request(), 'unanswered')
    expect(summary?.questions.every((question) => question.answers.length === 0)).toBe(true)
    expect(summary?.status).toBe('unanswered')
  })

  it('inserts a compact history message at its chronological position in the turn', () => {
    const messages: UiMessage[] = [
      { id: 'user', role: 'user', text: 'Build it', turnId: 'turn-a', timestampIso: '2026-08-25T09:59:00.000Z' },
      { id: 'before', role: 'assistant', text: 'One question', turnId: 'turn-a', timestampIso: '2026-08-25T09:59:59.000Z' },
      { id: 'after', role: 'assistant', text: 'Continuing', turnId: 'turn-a', timestampIso: '2026-08-25T10:00:20.000Z' },
    ]
    const merged = mergeRequestUserInputSummaryMessages(messages, [answeredSummary()])
    expect(merged.map((message) => message.id)).toEqual([
      'user',
      'before',
      'request-user-input:3:7',
      'after',
    ])
    expect(merged[2]?.messageType).toBe('requestUserInput.summary')
  })

  it('replaces the same request and caps each thread to the latest summaries', () => {
    let summaries: UiRequestUserInputSummary[] = []
    for (let index = 0; index < MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD + 3; index += 1) {
      summaries = upsertRequestUserInputSummary(summaries, answeredSummary({
        id: `summary-${index}`,
        requestId: index,
        requestedAtIso: new Date(Date.UTC(2026, 7, 25, 10, 0, index)).toISOString(),
      }))
    }
    expect(summaries).toHaveLength(MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD)
    expect(summaries[0]?.id).toBe('summary-3')
  })

  it('drops malformed and cross-thread entries during state normalization', () => {
    expect(normalizeRequestUserInputHistoryState({
      threads: {
        'thread-a': [answeredSummary(), answeredSummary({ threadId: 'thread-b', id: 'wrong' }), { broken: true }],
      },
    })).toEqual({ 'thread-a': [answeredSummary()] })
  })
})
