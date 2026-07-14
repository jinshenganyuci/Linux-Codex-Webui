export function togglePinnedThreadId(pinnedThreadIds: string[], threadId: string): string[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return pinnedThreadIds
  if (pinnedThreadIds.includes(normalizedThreadId)) {
    return pinnedThreadIds.filter((candidate) => candidate !== normalizedThreadId)
  }
  return [normalizedThreadId, ...pinnedThreadIds]
}
