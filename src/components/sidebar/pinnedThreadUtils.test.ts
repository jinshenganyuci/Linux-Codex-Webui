import { describe, expect, it, vi } from 'vitest'
import { mapWithConcurrency, togglePinnedThreadId } from './pinnedThreadUtils'

describe('togglePinnedThreadId', () => {
  it('adds a newly pinned chat to the front', () => {
    expect(togglePinnedThreadId(['thread-b'], 'thread-a')).toEqual(['thread-a', 'thread-b'])
  })

  it('removes an explicitly unpinned chat without pruning other saved ids', () => {
    expect(togglePinnedThreadId(['thread-a', 'not-loaded-yet'], 'thread-a')).toEqual(['not-loaded-yet'])
  })

  it('hydrates saved chats with bounded concurrency while preserving order', async () => {
    const pendingResolvers: Array<() => void> = []
    let active = 0
    let peakActive = 0
    const loadPromise = mapWithConcurrency(
      Array.from({ length: 10 }, (_, index) => `thread-${index}`),
      4,
      async (threadId) => {
        active += 1
        peakActive = Math.max(peakActive, active)
        await new Promise<void>((resolve) => pendingResolvers.push(resolve))
        active -= 1
        return `${threadId}-loaded`
      },
    )

    await vi.waitFor(() => expect(pendingResolvers).toHaveLength(4))
    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()?.()
      await Promise.resolve()
    }

    await expect(loadPromise).resolves.toEqual(
      Array.from({ length: 10 }, (_, index) => `thread-${index}-loaded`),
    )
    expect(peakActive).toBe(4)
  })
})
