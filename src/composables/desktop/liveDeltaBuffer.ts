export const LIVE_DELTA_FLUSH_MS = 180
export const LIVE_AGENT_TEXT_MAX_BYTES = 512 * 1024
export const LIVE_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024
export const LIVE_REASONING_TEXT_MAX_BYTES = 128 * 1024

type PendingLiveTextDelta = {
  threadId: string
  itemId: string
  turnId: string
  chunks: string[]
}

type LiveDeltaTimerHandle = ReturnType<typeof setTimeout>

export type LiveDeltaTimer = {
  schedule: (callback: () => void, delayMs: number) => LiveDeltaTimerHandle
  cancel: (handle: LiveDeltaTimerHandle) => void
}

export type LiveDeltaBufferOptions = {
  flushMs?: number
  agentTextMaxBytes?: number
  commandOutputMaxBytes?: number
  reasoningTextMaxBytes?: number
  timer?: LiveDeltaTimer
  getAgentText: (threadId: string, itemId: string, turnId: string) => string
  setAgentText: (threadId: string, itemId: string, text: string, turnId: string) => void
  updateCommandOutput: (
    threadId: string,
    itemId: string,
    update: (currentOutput: string) => string,
    turnId: string,
  ) => void
  getReasoningText: (threadId: string) => string
  setReasoningText: (threadId: string, text: string) => void
}

export type LiveDeltaBuffer = {
  queueAgentText: (threadId: string, itemId: string, delta: string, turnId?: string) => void
  queueCommandOutput: (threadId: string, itemId: string, delta: string, turnId?: string) => void
  queueReasoningText: (threadId: string, delta: string) => void
  flush: (threadId?: string, itemId?: string, turnId?: string) => void
  discardThread: (threadId: string) => void
  discardReasoningForThread: (threadId: string) => void
  reset: () => void
}

const defaultTimer: LiveDeltaTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
}

export function capUtf8Tail(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) return ''
  const marker = '…\n'
  if (typeof TextEncoder === 'undefined' || typeof TextDecoder === 'undefined') {
    if (text.length <= maxBytes) return text
    const charLimit = Math.max(0, Math.floor((maxBytes - marker.length) / 4))
    return `${marker}${charLimit > 0 ? text.slice(-charLimit) : ''}`
  }
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const markerBytes = new TextEncoder().encode(marker)
  if (markerBytes.byteLength >= maxBytes) {
    return new TextDecoder().decode(markerBytes.subarray(0, maxBytes)).replace(/\uFFFD+$/u, '')
  }
  const tailBytes = maxBytes - markerBytes.byteLength
  const tail = new TextDecoder().decode(encoded.subarray(encoded.byteLength - tailBytes)).replace(/^\uFFFD+/u, '')
  return `${marker}${tail}`
}

export function createLiveDeltaBuffer(options: LiveDeltaBufferOptions): LiveDeltaBuffer {
  const flushMs = options.flushMs ?? LIVE_DELTA_FLUSH_MS
  const agentTextMaxBytes = options.agentTextMaxBytes ?? LIVE_AGENT_TEXT_MAX_BYTES
  const commandOutputMaxBytes = options.commandOutputMaxBytes ?? LIVE_COMMAND_OUTPUT_MAX_BYTES
  const reasoningTextMaxBytes = options.reasoningTextMaxBytes ?? LIVE_REASONING_TEXT_MAX_BYTES
  const timer = options.timer ?? defaultTimer
  const pendingAgentTextByKey = new Map<string, PendingLiveTextDelta>()
  const pendingCommandOutputByKey = new Map<string, PendingLiveTextDelta>()
  const pendingReasoningByThreadId = new Map<string, PendingLiveTextDelta>()
  let flushTimer: LiveDeltaTimerHandle | null = null

  function scheduleFlush(): void {
    if (flushTimer !== null) return
    flushTimer = timer.schedule(() => {
      flushTimer = null
      flush()
    }, flushMs)
  }

  function queue(
    target: Map<string, PendingLiveTextDelta>,
    key: string,
    threadId: string,
    itemId: string,
    delta: string,
    turnId = '',
  ): void {
    if (!threadId || !itemId || !delta) return
    const pending = target.get(key)
    if (pending) pending.chunks.push(delta)
    else target.set(key, { threadId, itemId, turnId, chunks: [delta] })
    scheduleFlush()
  }

  function queueAgentText(threadId: string, itemId: string, delta: string, turnId = ''): void {
    queue(pendingAgentTextByKey, JSON.stringify([threadId, turnId, itemId]), threadId, itemId, delta, turnId)
  }

  function queueCommandOutput(threadId: string, itemId: string, delta: string, turnId = ''): void {
    queue(pendingCommandOutputByKey, JSON.stringify([threadId, turnId, itemId]), threadId, itemId, delta, turnId)
  }

  function queueReasoningText(threadId: string, delta: string): void {
    queue(pendingReasoningByThreadId, threadId, threadId, threadId, delta)
  }

  function flush(threadId = '', itemId = '', turnId?: string): void {
    if (flushTimer !== null) {
      timer.cancel(flushTimer)
      flushTimer = null
    }
    const matches = (pending: PendingLiveTextDelta) => (
      (!threadId || pending.threadId === threadId)
      && (!itemId || pending.itemId === itemId)
      && (turnId === undefined || pending.turnId === turnId)
    )

    for (const [key, pending] of pendingAgentTextByKey) {
      if (!matches(pending)) continue
      pendingAgentTextByKey.delete(key)
      options.setAgentText(
        pending.threadId,
        pending.itemId,
        capUtf8Tail(
          `${options.getAgentText(pending.threadId, pending.itemId, pending.turnId)}${pending.chunks.join('')}`,
          agentTextMaxBytes,
        ),
        pending.turnId,
      )
    }

    for (const [key, pending] of pendingCommandOutputByKey) {
      if (!matches(pending)) continue
      pendingCommandOutputByKey.delete(key)
      options.updateCommandOutput(
        pending.threadId,
        pending.itemId,
        (currentOutput) => capUtf8Tail(
          `${currentOutput}${pending.chunks.join('')}`,
          commandOutputMaxBytes,
        ),
        pending.turnId,
      )
    }

    for (const [key, pending] of pendingReasoningByThreadId) {
      if (!matches(pending)) continue
      pendingReasoningByThreadId.delete(key)
      options.setReasoningText(
        pending.threadId,
        capUtf8Tail(
          `${options.getReasoningText(pending.threadId)}${pending.chunks.join('')}`,
          reasoningTextMaxBytes,
        ),
      )
    }

    if (
      pendingAgentTextByKey.size > 0
      || pendingCommandOutputByKey.size > 0
      || pendingReasoningByThreadId.size > 0
    ) {
      scheduleFlush()
    }
  }

  function discardThread(threadId: string): void {
    for (const [key, pending] of pendingAgentTextByKey) {
      if (pending.threadId === threadId) pendingAgentTextByKey.delete(key)
    }
    for (const [key, pending] of pendingCommandOutputByKey) {
      if (pending.threadId === threadId) pendingCommandOutputByKey.delete(key)
    }
    pendingReasoningByThreadId.delete(threadId)
  }

  function discardReasoningForThread(threadId: string): void {
    pendingReasoningByThreadId.delete(threadId)
  }

  function reset(): void {
    if (flushTimer !== null) {
      timer.cancel(flushTimer)
      flushTimer = null
    }
    pendingAgentTextByKey.clear()
    pendingCommandOutputByKey.clear()
    pendingReasoningByThreadId.clear()
  }

  return {
    queueAgentText,
    queueCommandOutput,
    queueReasoningText,
    flush,
    discardThread,
    discardReasoningForThread,
    reset,
  }
}
