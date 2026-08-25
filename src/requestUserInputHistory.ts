import type {
  UiMessage,
  UiRequestUserInputHistoryState,
  UiRequestUserInputQuestionSummary,
  UiRequestUserInputSummary,
  UiRequestUserInputSummaryStatus,
  UiServerRequest,
} from './types/codex'

export const MAX_REQUEST_USER_INPUT_THREADS = 2_000
export const MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD = 64
const MAX_QUESTIONS_PER_SUMMARY = 12
const MAX_ANSWERS_PER_QUESTION = 8
const MAX_DISPLAY_TEXT_LENGTH = 4_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readTrimmedString(value: unknown, maxLength = MAX_DISPLAY_TEXT_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function readSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function normalizeIso(value: unknown, fallback: string): string {
  const text = readTrimmedString(value, 64)
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback
}

function normalizeQuestion(value: unknown): UiRequestUserInputQuestionSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readTrimmedString(record.id, 256)
  if (!id) return null
  const isSecret = record.isSecret === true || record.secret === true
  const answers = isSecret
    ? []
    : (Array.isArray(record.answers) ? record.answers : [])
      .map((answer) => readTrimmedString(answer))
      .filter(Boolean)
      .slice(0, MAX_ANSWERS_PER_QUESTION)
  return {
    id,
    header: readTrimmedString(record.header),
    question: readTrimmedString(record.question),
    answers,
    isSecret,
  }
}

export function normalizeRequestUserInputSummary(value: unknown): UiRequestUserInputSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const requestId = readSafeInteger(record.requestId)
  const generation = readSafeInteger(record.generation)
  const threadId = readTrimmedString(record.threadId, 512)
  const id = readTrimmedString(record.id, 512)
  const status = record.status === 'answered' || record.status === 'unanswered'
    ? record.status as UiRequestUserInputSummaryStatus
    : null
  if (!id || !threadId || requestId === null || generation === null || !status) return null
  const nowIso = new Date().toISOString()
  const requestedAtIso = normalizeIso(record.requestedAtIso, nowIso)
  const resolvedAtIso = normalizeIso(record.resolvedAtIso, requestedAtIso)
  const questions = (Array.isArray(record.questions) ? record.questions : [])
    .map(normalizeQuestion)
    .filter((question): question is UiRequestUserInputQuestionSummary => question !== null)
    .slice(0, MAX_QUESTIONS_PER_SUMMARY)
  if (questions.length === 0) return null
  return {
    id,
    threadId,
    turnId: readTrimmedString(record.turnId, 512),
    itemId: readTrimmedString(record.itemId, 512),
    requestId,
    generation,
    status,
    questions,
    requestedAtIso,
    resolvedAtIso,
  }
}

function latestSummaryTime(summaries: UiRequestUserInputSummary[]): number {
  return summaries.reduce((latest, summary) => Math.max(latest, Date.parse(summary.resolvedAtIso) || 0), 0)
}

export function normalizeRequestUserInputHistoryState(value: unknown): UiRequestUserInputHistoryState {
  const record = asRecord(value)
  const threadsRecord = asRecord(record?.threads) ?? record
  if (!threadsRecord) return {}

  const entries: Array<[string, UiRequestUserInputSummary[]]> = []
  for (const [rawThreadId, rawSummaries] of Object.entries(threadsRecord)) {
    if (rawThreadId === 'version') continue
    const threadId = readTrimmedString(rawThreadId, 512)
    if (!threadId || !Array.isArray(rawSummaries)) continue
    const byId = new Map<string, UiRequestUserInputSummary>()
    for (const rawSummary of rawSummaries) {
      const summary = normalizeRequestUserInputSummary(rawSummary)
      if (summary?.threadId === threadId) byId.set(summary.id, summary)
    }
    const summaries = [...byId.values()]
      .sort((first, second) => first.requestedAtIso.localeCompare(second.requestedAtIso))
      .slice(-MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD)
    if (summaries.length > 0) entries.push([threadId, summaries])
  }

  entries.sort((first, second) => latestSummaryTime(second[1]) - latestSummaryTime(first[1]))
  return Object.fromEntries(entries.slice(0, MAX_REQUEST_USER_INPUT_THREADS))
}

function readRequestQuestions(request: UiServerRequest): UiRequestUserInputQuestionSummary[] {
  const params = asRecord(request.params)
  return (Array.isArray(params?.questions) ? params.questions : [])
    .map((rawQuestion): UiRequestUserInputQuestionSummary | null => {
      const question = asRecord(rawQuestion)
      const id = readTrimmedString(question?.id, 256)
      if (!id) return null
      return {
        id,
        header: readTrimmedString(question?.header),
        question: readTrimmedString(question?.question),
        answers: [] as string[],
        isSecret: question?.isSecret === true || question?.secret === true,
      }
    })
    .filter((question): question is UiRequestUserInputQuestionSummary => question !== null)
    .slice(0, MAX_QUESTIONS_PER_SUMMARY)
}

function readReplyAnswers(result: unknown): Record<string, string[]> {
  const answerRows = asRecord(asRecord(result)?.answers)
  const answers: Record<string, string[]> = {}
  for (const [questionId, rawAnswer] of Object.entries(answerRows ?? {})) {
    const values = Array.isArray(asRecord(rawAnswer)?.answers) ? asRecord(rawAnswer)?.answers as unknown[] : []
    answers[questionId] = values
      .map((answer) => readTrimmedString(answer))
      .filter(Boolean)
      .slice(0, MAX_ANSWERS_PER_QUESTION)
  }
  return answers
}

export function buildRequestUserInputSummary(
  request: UiServerRequest,
  status: UiRequestUserInputSummaryStatus,
  result?: unknown,
  resolvedAtIso = new Date().toISOString(),
): UiRequestUserInputSummary | null {
  if (request.method !== 'item/tool/requestUserInput') return null
  const questions = readRequestQuestions(request)
  if (questions.length === 0) return null
  const replyAnswers = status === 'answered' ? readReplyAnswers(result) : {}
  const summary = normalizeRequestUserInputSummary({
    id: `request-user-input:${request.generation}:${request.id}`,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    requestId: request.id,
    generation: request.generation,
    status,
    questions: questions.map((question) => ({
      ...question,
      answers: question.isSecret ? [] : replyAnswers[question.id] ?? [],
    })),
    requestedAtIso: request.receivedAtIso,
    resolvedAtIso,
  })
  return summary
}

export function upsertRequestUserInputSummary(
  current: UiRequestUserInputSummary[],
  input: UiRequestUserInputSummary,
): UiRequestUserInputSummary[] {
  const summary = normalizeRequestUserInputSummary(input)
  if (!summary) return current
  const next = current.filter((entry) => entry.id !== summary.id)
  next.push(summary)
  return next
    .sort((first, second) => first.requestedAtIso.localeCompare(second.requestedAtIso))
    .slice(-MAX_REQUEST_USER_INPUT_SUMMARIES_PER_THREAD)
}

function summaryMessage(summary: UiRequestUserInputSummary): UiMessage {
  return {
    id: summary.id,
    role: 'system',
    text: summary.status === 'answered' ? 'Planning questions answered' : 'Planning questions left unanswered',
    timestampIso: summary.resolvedAtIso,
    messageType: 'requestUserInput.summary',
    requestUserInputSummary: summary,
    turnId: summary.turnId || undefined,
  }
}

export function mergeRequestUserInputSummaryMessages(
  messages: UiMessage[],
  summaries: UiRequestUserInputSummary[],
): UiMessage[] {
  if (summaries.length === 0) return messages
  const next = [...messages]
  const existingIds = new Set(messages.map((message) => message.id))

  for (const summary of summaries) {
    if (existingIds.has(summary.id)) continue
    const message = summaryMessage(summary)
    let insertAt = next.length
    if (summary.turnId) {
      const sameTurnIndexes = next
        .map((entry, index) => entry.turnId === summary.turnId ? index : -1)
        .filter((index) => index >= 0)
      if (sameTurnIndexes.length > 0) {
        insertAt = sameTurnIndexes[sameTurnIndexes.length - 1] + 1
        const requestedAt = Date.parse(summary.requestedAtIso)
        if (Number.isFinite(requestedAt)) {
          const laterIndex = sameTurnIndexes.find((index) => {
            const timestamp = Date.parse(next[index]?.timestampIso ?? '')
            return Number.isFinite(timestamp) && timestamp > requestedAt
          })
          if (laterIndex !== undefined) insertAt = laterIndex
        }
      }
    }
    next.splice(insertAt, 0, message)
    existingIds.add(summary.id)
  }
  return next
}
