import type { UiMessage } from '../../types/codex'

function extractLocalImagePathFromUrl(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    return url.pathname === '/codex-local-image' ? url.searchParams.get('path')?.trim() ?? '' : ''
  } catch { return '' }
}

export function timelineIdentity(message: UiMessage): string {
  return message.turnId ? `${message.turnId}\u0000${message.id}` : message.id
}

const fingerprints = new WeakMap<UiMessage, string>()

function fingerprint(message: UiMessage): string {
  const cached = fingerprints.get(message)
  if (cached !== undefined) return cached
  const imagePaths = (message.images ?? []).map(image => extractLocalImagePathFromUrl(image) || image)
  const files = (message.fileAttachments ?? []).filter(file => !imagePaths.includes(file.path.trim()))
  const result = JSON.stringify([
    message.role, message.messageType?.replace(/\.(?:optimistic|live)$/, ''),
    message.text.trim().replace(/\r\n/g, '\n'), imagePaths,
    files.map(file => file.path), (message.skills ?? []).map(skill => [skill.name, skill.path]),
    message.commandExecution?.command,
  ])
  fingerprints.set(message, result)
  return result
}

function provisional(message: UiMessage): boolean {
  return /^item-\d+$/.test(message.id) || message.messageType === 'userMessage.optimistic'
}

export function reconcileTimeline(
  previous: UiMessage[], incoming: UiMessage[], preserveMissing = true,
  equal: (first: UiMessage, second: UiMessage) => boolean = (first, second) => first === second,
): UiMessage[] {
  const previousById = new Map(previous.map(message => [timelineIdentity(message), message]))
  const incomingIds = new Set(incoming.map(timelineIdentity))
  const candidates = new Map<string, UiMessage[]>()
  const unknownTurns = new Set(incoming.filter(message => !previousById.has(timelineIdentity(message))).map(message => message.turnId))
  for (const message of previous) {
    if (incomingIds.has(timelineIdentity(message))) continue
    if (!unknownTurns.size || (message.turnId && !unknownTurns.has(message.turnId))) continue
    const key = fingerprint(message)
    const bucket = candidates.get(key) ?? []
    bucket.push(message)
    candidates.set(key, bucket)
  }
  const consumed = new Set<UiMessage>()
  const replacement = new Map<UiMessage, UiMessage>()
  const nextIncoming = incoming.map(message => {
    let before = previousById.get(timelineIdentity(message))
    if (!before) {
      before = candidates.get(fingerprint(message))?.find(candidate => (
        !consumed.has(candidate)
        && (candidate.turnId === message.turnId || (!candidate.turnId && candidate.messageType === 'userMessage.optimistic'))
        && (provisional(candidate) !== provisional(message))
      ))
    }
    if (!before) return message
    consumed.add(before)
    if (before === message) { replacement.set(before, before); return before }
    const sameIdentity = timelineIdentity(before) === timelineIdentity(message)
    const next = {
      ...message,
      ...(provisional(message) && !provisional(before) ? { id: before.id } : {}),
      ...(before.timelineOrder !== undefined ? { timelineOrder: before.timelineOrder } : {}),
      ...(before.renderKey || !sameIdentity ? { renderKey: before.renderKey || timelineIdentity(before) } : {}),
    }
    const value = equal(before, next) ? before : next
    replacement.set(before, value)
    return value
  })
  if (!preserveMissing) return nextIncoming
  const result = previous.map(message => replacement.get(message) ?? message)
  const known = new Set(result.map(timelineIdentity))
  for (let index = 0; index < nextIncoming.length; index += 1) {
    const message = nextIncoming[index]
    if (known.has(timelineIdentity(message))) continue
    const following = nextIncoming.slice(index + 1).find(next => known.has(timelineIdentity(next)))
    let insertAt = following ? result.findIndex(next => timelineIdentity(next) === timelineIdentity(following)) : -1
    if (insertAt < 0 && message.turnId) {
      let lastTurnIndex = -1
      for (let turnIndex = result.length - 1; turnIndex >= 0; turnIndex -= 1) {
        if (result[turnIndex].turnId === message.turnId) { lastTurnIndex = turnIndex; break }
      }
      if (lastTurnIndex >= 0) insertAt = lastTurnIndex + 1
    }
    result.splice(insertAt < 0 ? result.length : insertAt, 0, message)
    known.add(timelineIdentity(message))
  }
  return result
}

export function assignTimelineOrder(messages: UiMessage[], allocate: () => number): UiMessage[] {
  let previousOrder: number | undefined
  const result = [...messages]
  for (let index = 0; index < result.length;) {
    if (result[index].timelineOrder !== undefined) {
      previousOrder = result[index].timelineOrder
      index += 1
      continue
    }
    let end = index
    while (end < result.length && result[end].timelineOrder === undefined) end += 1
    const following = result[end]?.timelineOrder
    const count = end - index
    for (let offset = 0; offset < count; offset += 1) {
      const order = following === undefined ? allocate()
        : previousOrder === undefined ? following - count + offset
          : previousOrder + (following - previousOrder) * (offset + 1) / (count + 1)
      result[index + offset] = { ...result[index + offset], timelineOrder: order }
    }
    previousOrder = result[end - 1].timelineOrder
    index = end
  }
  return result
}

export function orderedTimeline(persisted: UiMessage[], live: UiMessage[]): UiMessage[] {
  return reconcileTimeline(persisted, live).sort((first, second) => (
    (first.timelineOrder ?? 0) - (second.timelineOrder ?? 0)
  ))
}
