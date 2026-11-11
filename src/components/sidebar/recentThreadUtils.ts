export function selectCurrentAndRecentThreads<Thread extends { id: string }>(
  sortedThreads: Thread[],
  currentThreadId: string,
  limit = 5,
): Thread[] {
  const count = Math.max(0, Math.floor(limit))
  if (count === 0) return []

  const currentThread = sortedThreads.find((thread) => thread.id === currentThreadId)
  if (!currentThread) return sortedThreads.slice(0, count)

  const recentThreads = [currentThread]
  if (count === 1) return recentThreads
  for (const thread of sortedThreads) {
    if (thread.id === currentThreadId) continue
    recentThreads.push(thread)
    if (recentThreads.length === count) break
  }
  return recentThreads
}
