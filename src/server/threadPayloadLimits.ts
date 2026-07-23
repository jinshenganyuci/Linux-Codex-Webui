export const THREAD_RESPONSE_TURN_LIMIT = 10
export const THREAD_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024
export const THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES = 512 * 1024
export const THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER = '[较早输出已省略]\n'
export const THREAD_METHODS_WITH_TURNS: ReadonlySet<string> = new Set([
  'thread/read',
  'thread/resume',
  'thread/fork',
  'thread/rollback',
])

type ThreadHistorySortDirection = 'asc' | 'desc'

type CommandOutputBudget = {
  remainingBytes: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readSortDirection(value: unknown, fallback: ThreadHistorySortDirection): ThreadHistorySortDirection {
  const direction = asRecord(value)?.sortDirection
  return direction === 'asc' || direction === 'desc' ? direction : fallback
}

function readOriginalOutputBytes(item: Record<string, unknown>, currentBytes: number): number {
  const originalBytes = item.aggregatedOutputOriginalBytes
  return item.aggregatedOutputTruncated === true
    && typeof originalBytes === 'number'
    && Number.isSafeInteger(originalBytes)
    && originalBytes >= currentBytes
    ? originalBytes
    : currentBytes
}

function truncateCommandOutput(
  output: string,
  maxBytes: number,
): { output: string; currentBytes: number; retainedBytes: number } | null {
  const currentBytes = Buffer.byteLength(output, 'utf8')
  if (currentBytes <= maxBytes) return null

  const markerBytes = Buffer.byteLength(THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER, 'utf8')
  if (maxBytes < markerBytes) {
    return { output: '', currentBytes, retainedBytes: 0 }
  }

  const encoded = Buffer.from(output, 'utf8')
  const tailBudget = Math.max(0, maxBytes - markerBytes)
  let tailStart = Math.max(0, encoded.byteLength - tailBudget)

  // A byte-count slice can land inside a multi-byte character. Move to the
  // next UTF-8 leading byte so the retained suffix is valid text.
  while (tailStart < encoded.byteLength && (encoded[tailStart]! & 0xc0) === 0x80) {
    tailStart += 1
  }

  const nextOutput = THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER + encoded.subarray(tailStart).toString('utf8')
  return {
    output: nextOutput,
    currentBytes,
    retainedBytes: Buffer.byteLength(nextOutput, 'utf8'),
  }
}

function limitCommandExecutionOutput(item: unknown, budget: CommandOutputBudget): unknown {
  const itemRecord = asRecord(item)
  if (
    itemRecord?.type !== 'commandExecution'
    || typeof itemRecord.aggregatedOutput !== 'string'
  ) {
    return item
  }

  const allowedBytes = Math.min(THREAD_COMMAND_OUTPUT_MAX_BYTES, budget.remainingBytes)
  const truncated = truncateCommandOutput(itemRecord.aggregatedOutput, allowedBytes)
  if (!truncated) {
    budget.remainingBytes = Math.max(
      0,
      budget.remainingBytes - Buffer.byteLength(itemRecord.aggregatedOutput, 'utf8'),
    )
    return item
  }

  budget.remainingBytes = Math.max(0, budget.remainingBytes - truncated.retainedBytes)
  return {
    ...itemRecord,
    aggregatedOutput: truncated.output,
    aggregatedOutputTruncated: true,
    aggregatedOutputOriginalBytes: readOriginalOutputBytes(itemRecord, truncated.currentBytes),
  }
}

function limitCommandOutputsInItems(items: unknown[], budget: CommandOutputBudget): unknown[] {
  let nextItems = items
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex]
    const nextItem = limitCommandExecutionOutput(item, budget)
    if (nextItem === item) continue
    if (nextItems === items) nextItems = items.slice()
    nextItems[itemIndex] = nextItem
  }
  return nextItems
}

function limitCommandOutputsInItemEntries(
  entries: unknown[],
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown[] {
  let nextEntries = entries
  const startIndex = sortDirection === 'desc' ? 0 : entries.length - 1
  const endIndex = sortDirection === 'desc' ? entries.length : -1
  const step = sortDirection === 'desc' ? 1 : -1

  for (let entryIndex = startIndex; entryIndex !== endIndex; entryIndex += step) {
    const entry = entries[entryIndex]
    const entryRecord = asRecord(entry)
    if (!entryRecord) continue

    const nextItem = limitCommandExecutionOutput(entryRecord.item, budget)
    if (nextItem === entryRecord.item) continue
    if (nextEntries === entries) nextEntries = entries.slice()
    nextEntries[entryIndex] = {
      ...entryRecord,
      item: nextItem,
    }
  }

  return nextEntries
}

function limitCommandOutputsInTurnsWithBudget(
  turns: unknown[],
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown[] {
  let nextTurns = turns
  const startIndex = sortDirection === 'desc' ? 0 : turns.length - 1
  const endIndex = sortDirection === 'desc' ? turns.length : -1
  const step = sortDirection === 'desc' ? 1 : -1

  for (let turnIndex = startIndex; turnIndex !== endIndex; turnIndex += step) {
    const turn = turns[turnIndex]
    const turnRecord = asRecord(turn)
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !items || items.length === 0) continue

    // Items within a turn are chronological regardless of the turn-page order.
    const nextItems = limitCommandOutputsInItems(items, budget)
    if (nextItems === items) continue
    if (nextTurns === turns) nextTurns = turns.slice()
    nextTurns[turnIndex] = {
      ...turnRecord,
      items: nextItems,
    }
  }

  return nextTurns
}

/**
 * Limits command output across exactly the supplied turns. The newest commands
 * consume the shared response budget first, while each command keeps only its
 * newest UTF-8 suffix. Unchanged ancestry retains its references.
 */
export function limitCommandOutputsInTurns(
  turns: unknown[],
  sortDirection: ThreadHistorySortDirection = 'asc',
): unknown[] {
  return limitCommandOutputsInTurnsWithBudget(
    turns,
    { remainingBytes: THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES },
    sortDirection,
  )
}

function limitThreadCommandOutputsWithBudget(
  result: unknown,
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length === 0) return result

  const nextTurns = limitCommandOutputsInTurnsWithBudget(turns, budget, sortDirection)
  if (nextTurns === turns) return result

  return {
    ...record,
    thread: {
      ...thread,
      turns: nextTurns,
    },
  }
}

/** Limits command output in a standard app-server `{ thread: { turns } }` result. */
export function limitThreadCommandOutputs(result: unknown): unknown {
  return limitThreadCommandOutputsWithBudget(
    result,
    { remainingBytes: THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES },
    'asc',
  )
}

function limitTurnsPageCommandOutputs(
  result: unknown,
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown {
  const record = asRecord(result)
  const turns = Array.isArray(record?.data) ? record.data : null
  if (!record || !turns || turns.length === 0) return result

  const nextTurns = limitCommandOutputsInTurnsWithBudget(turns, budget, sortDirection)
  if (nextTurns === turns) return result

  return {
    ...record,
    data: nextTurns,
  }
}

function limitItemsPageCommandOutputs(
  result: unknown,
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown {
  const record = asRecord(result)
  const entries = Array.isArray(record?.data) ? record.data : null
  if (!record || !entries || entries.length === 0) return result

  const nextEntries = limitCommandOutputsInItemEntries(entries, budget, sortDirection)
  if (nextEntries === entries) return result

  return {
    ...record,
    data: nextEntries,
  }
}

function limitInitialTurnsPageCommandOutputs(
  result: unknown,
  budget: CommandOutputBudget,
  sortDirection: ThreadHistorySortDirection,
): unknown {
  const record = asRecord(result)
  const initialTurnsPage = asRecord(record?.initialTurnsPage)
  if (!record || !initialTurnsPage) return result

  const nextInitialTurnsPage = limitTurnsPageCommandOutputs(initialTurnsPage, budget, sortDirection)
  if (nextInitialTurnsPage === initialTurnsPage) return result

  return {
    ...record,
    initialTurnsPage: nextInitialTurnsPage,
  }
}

/**
 * Applies the existing RPC turn-count window before scanning command outputs.
 * Native pages retain their official shape and cursors. All command outputs in
 * one response share a 512 KiB budget in newest-command-first order.
 */
export function trimAndLimitThreadCommandOutputs(method: string, result: unknown, params?: unknown): unknown {
  if (method === 'thread/turns/list') {
    return limitTurnsPageCommandOutputs(
      result,
      { remainingBytes: THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES },
      readSortDirection(params, 'desc'),
    )
  }
  if (method === 'thread/items/list') {
    return limitItemsPageCommandOutputs(
      result,
      { remainingBytes: THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES },
      readSortDirection(params, 'asc'),
    )
  }
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null

  let responseResult = result
  if (record && thread && turns && turns.length > THREAD_RESPONSE_TURN_LIMIT) {
    const startTurnIndex = Math.max(0, turns.length - THREAD_RESPONSE_TURN_LIMIT)
    responseResult = {
      ...record,
      threadTurnStartIndex: startTurnIndex,
      thread: {
        ...thread,
        turns: turns.slice(startTurnIndex),
      },
    }
  }

  const budget = { remainingBytes: THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES }
  if (method === 'thread/resume') {
    // A native initial page is the requested current window; reserve the shared
    // budget for it before any compatibility turns that may also be present.
    const initialTurnsPageParams = asRecord(params)?.initialTurnsPage
    responseResult = limitInitialTurnsPageCommandOutputs(
      responseResult,
      budget,
      readSortDirection(initialTurnsPageParams, 'desc'),
    )
  }

  return limitThreadCommandOutputsWithBudget(responseResult, budget, 'asc')
}
