export function togglePinnedThreadId(pinnedThreadIds: string[], threadId: string): string[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return pinnedThreadIds
  if (pinnedThreadIds.includes(normalizedThreadId)) {
    return pinnedThreadIds.filter((candidate) => candidate !== normalizedThreadId)
  }
  return [normalizedThreadId, ...pinnedThreadIds]
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index] as T, index)
    }
  }))

  return results
}
