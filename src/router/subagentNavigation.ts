import { computed } from 'vue'
import { useRoute } from 'vue-router'

const MAX_RETURN_DEPTH = 16
const isThreadId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,128}$/.test(value)

// Carry the origin in the link itself so reloads and new tabs retain a way back.
export function readThreadReturnPath(threadId: string, from: unknown): string[] {
  const values = Array.isArray(from) ? from : [from]
  const path: string[] = []
  for (const value of values.slice(0, MAX_RETURN_DEPTH)) {
    if (!isThreadId(value)) continue
    if (value === threadId || path.includes(value)) break
    path.push(value)
  }
  return path
}

function threadHref(threadId: string, path: string[]): string {
  const query = new URLSearchParams()
  for (const parent of path) query.append('from', parent)
  return `#/thread/${encodeURIComponent(threadId)}${query.size ? `?${query}` : ''}`
}

export function subagentThreadHref(threadId: string, sourceId: string, from: unknown): string {
  const path = readThreadReturnPath(sourceId, from)
  if (isThreadId(sourceId) && sourceId !== threadId) path.push(sourceId)
  const ancestorIndex = path.indexOf(threadId)
  return threadHref(threadId, ancestorIndex >= 0 ? path.slice(0, ancestorIndex) : path.slice(-MAX_RETURN_DEPTH))
}

export function parentThreadHref(threadId: string, from: unknown): string {
  const path = readThreadReturnPath(threadId, from)
  const parent = path.pop()
  return parent ? threadHref(parent, path) : ''
}

export function useSubagentNavigation(sourceThreadId?: () => string) {
  const route = useRoute()
  const routeThreadId = computed(() => route.name === 'thread' && typeof route.params.threadId === 'string'
    ? route.params.threadId : '')
  const returnHref = computed(() => routeThreadId.value
    ? parentThreadHref(routeThreadId.value, route.query.from) : '')
  function childHref(threadId: string): string {
    const sourceId = sourceThreadId?.() ?? routeThreadId.value
    return subagentThreadHref(threadId, sourceId, sourceId === routeThreadId.value ? route.query.from : undefined)
  }
  return { returnHref, childHref }
}
