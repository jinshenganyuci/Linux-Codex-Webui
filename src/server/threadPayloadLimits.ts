const UTF8_MAX_BYTES_PER_UTF16_CODE_UNIT = 3

export const THREAD_RESPONSE_TURN_LIMIT = 10
export const THREAD_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024
export const THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER = '[较早输出已省略]\n'
export const THREAD_METHODS_WITH_TURNS: ReadonlySet<string> = new Set([
  'thread/read',
  'thread/resume',
  'thread/fork',
  'thread/rollback',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function truncateCommandOutput(output: string): { output: string; originalBytes: number } | null {
  // Most command output is short. This length check avoids allocating a Buffer
  // when even the worst-case UTF-8 encoding cannot exceed the response limit.
  if (output.length <= Math.floor(THREAD_COMMAND_OUTPUT_MAX_BYTES / UTF8_MAX_BYTES_PER_UTF16_CODE_UNIT)) {
    return null
  }

  const encoded = Buffer.from(output, 'utf8')
  if (encoded.byteLength <= THREAD_COMMAND_OUTPUT_MAX_BYTES) return null

  const markerBytes = Buffer.byteLength(THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER, 'utf8')
  const tailBudget = Math.max(0, THREAD_COMMAND_OUTPUT_MAX_BYTES - markerBytes)
  let tailStart = Math.max(0, encoded.byteLength - tailBudget)

  // A byte-count slice can land inside a multi-byte character. Move to the
  // next UTF-8 leading byte so the retained suffix is valid text.
  while (tailStart < encoded.byteLength && (encoded[tailStart]! & 0xc0) === 0x80) {
    tailStart += 1
  }

  return {
    output: THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER + encoded.subarray(tailStart).toString('utf8'),
    originalBytes: encoded.byteLength,
  }
}

function limitCommandExecutionOutput(item: unknown): unknown {
  const itemRecord = asRecord(item)
  if (
    itemRecord?.type !== 'commandExecution'
    || typeof itemRecord.aggregatedOutput !== 'string'
  ) {
    return item
  }

  const truncated = truncateCommandOutput(itemRecord.aggregatedOutput)
  if (!truncated) return item

  return {
    ...itemRecord,
    aggregatedOutput: truncated.output,
    aggregatedOutputTruncated: true,
    aggregatedOutputOriginalBytes: truncated.originalBytes,
  }
}

/**
 * Limits command output in exactly the supplied turns. Unchanged turns, items,
 * and arrays retain their references; oversized command items are cloned.
 */
export function limitCommandOutputsInTurns(turns: unknown[]): unknown[] {
  let turnsChanged = false
  const nextTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !items || items.length === 0) return turn

    let itemsChanged = false
    const nextItems = items.map((item) => {
      const nextItem = limitCommandExecutionOutput(item)
      if (nextItem !== item) itemsChanged = true
      return nextItem
    })
    if (!itemsChanged) return turn

    turnsChanged = true
    return {
      ...turnRecord,
      items: nextItems,
    }
  })

  return turnsChanged ? nextTurns : turns
}

/** Limits command output in a standard app-server `{ thread: { turns } }` result. */
export function limitThreadCommandOutputs(result: unknown): unknown {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length === 0) return result

  const nextTurns = limitCommandOutputsInTurns(turns)
  if (nextTurns === turns) return result

  return {
    ...record,
    thread: {
      ...thread,
      turns: nextTurns,
    },
  }
}

/**
 * Applies the existing RPC turn-count window before scanning command outputs.
 * This prevents discarded history from adding work to the byte-limit pass.
 */
export function trimAndLimitThreadCommandOutputs(method: string, result: unknown): unknown {
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns) return result

  let responseResult = result
  if (turns.length > THREAD_RESPONSE_TURN_LIMIT) {
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

  return limitThreadCommandOutputs(responseResult)
}
