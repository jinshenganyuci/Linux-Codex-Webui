type RpcExecutor = {
  rpc: (method: string, params: unknown) => Promise<unknown>
}

export const FULL_TURN_HISTORY_MAX_PAGES = 16
export const FULL_TURN_HISTORY_MAX_ITEMS = 1_600
export const FULL_TURN_HISTORY_MAX_BYTES = 8 * 1024 * 1024
const MAX_PAYLOAD_NODES = 64_000
const MAX_PAYLOAD_DEPTH = 32

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isUnsupportedThreadItemsListError(error: unknown): boolean {
  const record = asRecord(error)
  const detail = asRecord(record?.error) ?? record
  if (typeof detail?.code === 'number') return detail.code === -32601
  const message = error instanceof Error
    ? error.message
    : typeof detail?.message === 'string' ? detail.message : ''
  return /(?:\bmethod\s+not\s+found\b|(?:^|\s)-32601\b|thread\/items\/list["']?\s*(?::\s*|is\s+)?not\s+supported\b|\bnot\s+supported(?:\s+yet)?\s*:?\s*["']?thread\/items\/list)/iu.test(message)
}

function historyLimitError(reason: string): Error {
  return new Error(`History lookup incomplete: ${reason}. No complete result was returned.`)
}

type PayloadBudget = { bytes: number; nodes: number }

// Bound decoded text and structural work without serializing/copying a whole
// page. One upstream full turn can still exceed the budget before it arrives;
// request one turn at a time and reject that page before returning any result.
function consumePayloadBudget(value: unknown, budget: PayloadBudget, depth = 0): void {
  budget.nodes += 1
  budget.bytes += 16
  if (budget.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) {
    throw historyLimitError('the full-turn payload exceeds the structural limit')
  }
  if (typeof value === 'string') {
    if (value.length > FULL_TURN_HISTORY_MAX_BYTES - budget.bytes) {
      throw historyLimitError('the full-turn payload exceeds the 8 MiB read budget')
    }
    budget.bytes += Buffer.byteLength(value, 'utf8')
  }
  if (budget.bytes > FULL_TURN_HISTORY_MAX_BYTES) {
    throw historyLimitError('the full-turn payload exceeds the 8 MiB read budget')
  }
  if (Array.isArray(value)) {
    for (const entry of value) consumePayloadBudget(entry, budget, depth + 1)
  } else if (value !== null && typeof value === 'object') {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      consumePayloadBudget(key, budget, depth + 1)
      consumePayloadBudget((value as Record<string, unknown>)[key], budget, depth + 1)
    }
  }
}

/** Visit newest items first; a missing result is definitive only at EOF. */
export async function readBoundedFullTurnItem<T>(
  appServer: RpcExecutor,
  threadId: string,
  visit: (item: Record<string, unknown>, turnId: string) => T | null,
): Promise<T | null> {
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  const budget: PayloadBudget = { bytes: 0, nodes: 0 }
  let itemCount = 0

  for (let pageIndex = 0; pageIndex < FULL_TURN_HISTORY_MAX_PAGES; pageIndex += 1) {
    const page = asRecord(await appServer.rpc('thread/turns/list', {
      threadId,
      cursor,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    }))
    if (!page || !Array.isArray(page.data)) {
      throw new Error('thread/turns/list returned an invalid full-turn page')
    }
    if (page.data.length > 1) {
      throw historyLimitError('thread/turns/list exceeded the requested one-turn page size')
    }
    for (const turnValue of page.data) {
      const turn = asRecord(turnValue)
      if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
        throw new Error('thread/turns/list returned an invalid full turn')
      }
      itemCount += turn.items.length
      if (itemCount > FULL_TURN_HISTORY_MAX_ITEMS) {
        throw historyLimitError('the full-turn history exceeds the 1600-item read budget')
      }
    }
    consumePayloadBudget(page, budget)
    for (const turnValue of page.data) {
      const turn = turnValue as { id: string; items: unknown[] }
      for (let index = turn.items.length - 1; index >= 0; index -= 1) {
        const item = asRecord(turn.items[index])
        if (!item) continue
        const result = visit(item, turn.id)
        if (result !== null) return result
      }
    }
    if (page.nextCursor === null || page.nextCursor === undefined) return null
    if (typeof page.nextCursor !== 'string' || !page.nextCursor.trim()) {
      throw new Error('thread/turns/list returned an invalid next cursor')
    }
    if (seenCursors.has(page.nextCursor)) {
      throw historyLimitError('thread/turns/list repeated a pagination cursor')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw historyLimitError('the full-turn history exceeds the 16-page read budget')
}

export function readCompleteCommandOutput(item: Record<string, unknown>): string | null {
  if (item.type !== 'commandExecution' || typeof item.aggregatedOutput !== 'string') return null
  if (
    item.aggregatedOutputTruncated === true
    || (typeof item.aggregatedOutputOriginalBytes === 'number'
      && item.aggregatedOutputOriginalBytes > Buffer.byteLength(item.aggregatedOutput, 'utf8'))
  ) {
    throw historyLimitError('the runtime returned truncated command output')
  }
  return item.aggregatedOutput
}
