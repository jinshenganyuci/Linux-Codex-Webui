type Cleanup = (threadId: string) => Promise<unknown>

export function createThreadDeletion(options: {
  remove(threadId: string): Promise<unknown>
  cleanups: Cleanup[]
  notify(threadId: string): void
  onError(threadId: string, error: unknown): void
}) {
  const pending = new Map<string, Promise<unknown>>()
  const deleted = new Set<string>()
  const jobs: Array<{ threadId: string; remaining: Cleanup[]; attempt: number }> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const running = new Set<Promise<void>>()
  let active = 0
  let disposed = false

  function pump(): void {
    while (!disposed && active < 2 && jobs.length) {
      const job = jobs.shift()!
      active += 1
      const task = Promise.allSettled(job.remaining.map(cleanup => Promise.resolve().then(() => cleanup(job.threadId))))
        .then(results => {
          const failed = job.remaining.filter((_, index) => results[index].status === 'rejected')
          if (!failed.length) return
          results.forEach(result => { if (result.status === 'rejected') options.onError(job.threadId, result.reason) })
          if (job.attempt >= 3 || disposed) return
          const timer = setTimeout(() => {
            timers.delete(timer)
            jobs.push({ threadId: job.threadId, remaining: failed, attempt: job.attempt + 1 })
            pump()
          }, 1000 * job.attempt)
          timer.unref?.()
          timers.add(timer)
        }).finally(() => { running.delete(task); active -= 1; pump() })
      running.add(task)
    }
  }

  function remove(threadId: string): Promise<unknown> {
    if (deleted.has(threadId)) return Promise.resolve({})
    const existing = pending.get(threadId)
    if (existing) return existing
    if (disposed) return Promise.reject(new Error('Deletion service stopped'))
    if (jobs.length + pending.size + active + timers.size >= 256) return Promise.reject(new Error('删除清理繁忙，请稍后重试'))
    const promise = options.remove(threadId).then(result => {
      deleted.add(threadId)
      if (deleted.size > 1000) deleted.delete(deleted.values().next().value!)
      options.notify(threadId)
      jobs.push({ threadId, remaining: options.cleanups, attempt: 1 })
      pump()
      return result
    }).finally(() => pending.delete(threadId))
    pending.set(threadId, promise)
    return promise
  }

  return {
    remove,
    isDeleted: (threadId: string) => deleted.has(threadId),
    dispose() { disposed = true; timers.forEach(clearTimeout); timers.clear(); jobs.length = 0 },
    async drain() { await Promise.allSettled([...running]) },
  }
}
