import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThreadDeletion } from './threadDeletion'

afterEach(() => vi.useRealTimers())

describe('thread deletion lifecycle', () => {
  it('confirms deletion without waiting for cleanup and deduplicates concurrent requests', async () => {
    let finish!: () => void
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const remove = vi.fn(async () => ({ deleted: true }))
    const notify = vi.fn()
    const service = createThreadDeletion({ remove, notify, cleanups: [cleanup], onError: vi.fn() })
    const first = service.remove('thread')
    expect(service.remove('thread')).toBe(first)
    expect(await first).toEqual({ deleted: true })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('thread')
    finish()
    service.dispose()
  })

  it('retries only failed cleanup with a bounded attempt count', async () => {
    vi.useFakeTimers()
    const good = vi.fn(async () => {})
    const bad = vi.fn(async () => { throw new Error('locked') })
    const service = createThreadDeletion({ remove: async () => ({}), notify: vi.fn(), cleanups: [good, bad], onError: vi.fn() })
    await service.remove('thread')
    await vi.runAllTimersAsync()
    expect(good).toHaveBeenCalledTimes(1)
    expect(bad).toHaveBeenCalledTimes(3)
    service.dispose()
  })

  it('does not clean or notify when core deletion fails', async () => {
    const notify = vi.fn()
    const cleanup = vi.fn()
    const service = createThreadDeletion({ remove: async () => { throw new Error('busy') }, notify, cleanups: [cleanup], onError: vi.fn() })
    await expect(service.remove('thread')).rejects.toThrow('busy')
    expect(notify).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    service.dispose()
  })
})
