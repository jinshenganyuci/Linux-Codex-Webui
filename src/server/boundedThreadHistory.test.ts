import { describe, expect, it, vi } from 'vitest'
import {
  FULL_TURN_HISTORY_MAX_BYTES,
  FULL_TURN_HISTORY_MAX_ITEMS,
  FULL_TURN_HISTORY_MAX_PAGES,
  isUnsupportedThreadItemsListError,
  readBoundedFullTurnItem,
} from './boundedThreadHistory'
import { AppServerProcess, readFullThreadCommandOutput } from './codexAppServerBridge'

const unsupported = () => new Error('thread/items/list is not supported yet')
const summary = { thread: { id: 'child', historyMode: 'paginated' } }
const message = (text: string) => ({ id: text, type: 'agentMessage', text })
const command = (output: string, extra: Record<string, unknown> = {}) => ({
  id: 'command-1', type: 'commandExecution', aggregatedOutput: output, ...extra,
})
const turnPage = (items: unknown[], nextCursor: string | null = null, turnId = 'turn-1') => ({
  data: [{ id: turnId, items }], nextCursor,
})

function readAgentResult(rpc: (method: string, params: unknown) => Promise<unknown>) {
  return AppServerProcess.prototype.readAgentResult.call({ rpc } as AppServerProcess, 'child')
}

describe('unsupported item history classification', () => {
  it.each([
    { code: -32601, message: 'unavailable' },
    { error: { code: -32601, message: 'unavailable' } },
    new Error('Method not found'),
    unsupported(),
    new Error('not supported: thread/items/list'),
    new Error('RPC error -32601: unavailable'),
  ])('accepts explicit missing-method errors: %s', (error) => {
    expect(isUnsupportedThreadItemsListError(error)).toBe(true)
  })

  it.each([
    new Error('RPC timeout: thread/items/list'),
    new Error('permission denied: thread/items/list'),
    new Error('thread/items/list: image format unsupported'),
    new Error('thread/items/list: sortDirection is not supported'),
    new Error('request failed'),
    { code: -32602, message: 'Invalid params' },
    { code: -32602, message: 'thread/items/list is not supported for these parameters' },
  ])('preserves operational and parameter failures: %s', (error) => {
    expect(isUnsupportedThreadItemsListError(error)).toBe(false)
  })
})

describe('agent result fallback', () => {
  it('finds the newest nonempty assistant message with sequential bounded full-turn pages', async () => {
    const rpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      if (method === 'thread/turns/list') {
        return (params as { cursor: string | null }).cursor === null
          ? turnPage([message('  '), command('recent output')], 'older', 'turn-new')
          : turnPage([message('old result'), message('new result')], 'still-older')
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(readAgentResult(rpc)).resolves.toEqual({ threadId: 'child', text: 'new result', truncated: false })
    expect(rpc.mock.calls).toEqual([
      ['thread/read', { threadId: 'child', includeTurns: false }],
      ['thread/items/list', { threadId: 'child', cursor: null, limit: 50, sortDirection: 'desc' }],
      ['thread/turns/list', { threadId: 'child', cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'full' }],
      ['thread/turns/list', { threadId: 'child', cursor: 'older', limit: 1, sortDirection: 'desc', itemsView: 'full' }],
    ])
  })

  it('preserves the explicit assistant-text truncation flag', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      return turnPage([message('中'.repeat(30_000))])
    })
    const result = await readAgentResult(rpc)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(result.text).not.toContain('\uFFFD')
  })

  it('retries native items on a later read so changing runtimes never leaves a stale unsupported cache', async () => {
    let nativeAvailable = false
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') {
        if (!nativeAvailable) throw unsupported()
        return { data: [{ turnId: 'turn-1', item: message('native result') }], nextCursor: null }
      }
      return turnPage([message('fallback result')])
    })
    expect((await readAgentResult(rpc)).text).toBe('fallback result')
    nativeAvailable = true
    expect((await readAgentResult(rpc)).text).toBe('native result')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/items/list')).toHaveLength(2)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/turns/list')).toHaveLength(1)
  })

  it.each(['permission denied', 'RPC timeout', 'Invalid params'])('does not downgrade %s errors', async (reason) => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      throw new Error(reason)
    })
    await expect(readAgentResult(rpc)).rejects.toThrow(reason)
    expect(rpc.mock.calls).toHaveLength(2)
  })
})

describe('complete command output fallback', () => {
  it('finds the exact turn and returns output larger than the initial-render cap byte for byte', async () => {
    const completeOutput = `prefix\n${'x'.repeat(300 * 1024)}\nsuffix`
    const rpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      return (params as { cursor: string | null }).cursor === null
        ? turnPage([command('wrong turn')], 'older', 'turn-other')
        : turnPage([command(completeOutput)], 'unneeded-page')
    })
    await expect(readFullThreadCommandOutput({ rpc }, 'child', 'turn-1', 'command-1')).resolves.toBe(completeOutput)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/turns/list')).toHaveLength(2)
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/read')).toEqual([
      ['thread/read', { threadId: 'child', includeTurns: false }],
    ])
  })

  it('returns an empty but complete command output as found', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      return turnPage([command('')])
    })
    await expect(readFullThreadCommandOutput({ rpc }, 'child', 'turn-1', 'command-1')).resolves.toBe('')
  })

  it.each([
    { aggregatedOutputTruncated: true },
    { aggregatedOutputOriginalBytes: 1000 },
  ])('never returns known truncated output as complete: %s', async (metadata) => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      return turnPage([command('only tail', metadata)])
    })
    await expect(readFullThreadCommandOutput({ rpc }, 'child', 'turn-1', 'command-1')).rejects.toThrow('truncated command output')
  })

  it('also rejects upstream truncation on the supported native item path', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/read'
      ? summary
      : { data: [{ turnId: 'turn-1', item: command('tail', { aggregatedOutputTruncated: true }) }] })
    await expect(readFullThreadCommandOutput({ rpc }, 'child', 'turn-1', 'command-1')).rejects.toThrow('truncated command output')
  })

  it('propagates a turns fallback failure without attempting legacy full history', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return summary
      if (method === 'thread/items/list') throw unsupported()
      throw new Error('turn history permission denied')
    })
    await expect(readFullThreadCommandOutput({ rpc }, 'child', 'turn-1', 'command-1')).rejects.toThrow('turn history permission denied')
    expect(rpc.mock.calls).toHaveLength(3)
  })
})

describe('full-turn lookup limits', () => {
  it('stops immediately at EOF with a definitive missing result', async () => {
    const rpc = vi.fn(async () => turnPage([command('unmatched')]))
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).resolves.toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('reports a repeated cursor as incomplete instead of missing', async () => {
    const rpc = vi.fn(async () => turnPage([], 'same-cursor'))
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).rejects.toThrow('repeated a pagination cursor')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('never reads more than sixteen full turns', async () => {
    let page = 0
    const rpc = vi.fn(async () => turnPage([], `cursor-${++page}`))
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).rejects.toThrow('16-page read budget')
    expect(rpc).toHaveBeenCalledTimes(FULL_TURN_HISTORY_MAX_PAGES)
  })

  it('bounds items across pages before visiting an oversized page', async () => {
    const items = Array.from({ length: FULL_TURN_HISTORY_MAX_ITEMS / 2 + 1 }, () => command(''))
    const rpc = vi.fn(async () => turnPage(items, 'more'))
    const visit = vi.fn(() => null)
    await expect(readBoundedFullTurnItem({ rpc }, 'child', visit)).rejects.toThrow('1600-item read budget')
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(visit).toHaveBeenCalledTimes(items.length)
  })

  it('rejects oversized output before returning it as complete', async () => {
    const rpc = vi.fn(async () => turnPage([command('x'.repeat(FULL_TURN_HISTORY_MAX_BYTES + 1))]))
    const visit = vi.fn(() => 'must not be returned')
    await expect(readBoundedFullTurnItem({ rpc }, 'child', visit)).rejects.toThrow('8 MiB read budget')
    expect(visit).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('accounts for cumulative full-turn bytes across pages', async () => {
    const rpc = vi.fn(async () => turnPage([command('x'.repeat(FULL_TURN_HISTORY_MAX_BYTES / 2))], 'more'))
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).rejects.toThrow('8 MiB read budget')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    { data: 'invalid' },
    { data: [{ id: 'turn-1' }], nextCursor: null },
    { data: [], nextCursor: 123 },
  ])('rejects malformed pages instead of claiming complete history: %s', async (page) => {
    const rpc = vi.fn(async () => page)
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).rejects.toThrow('invalid')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a runtime that ignores the requested one-turn page size', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: '1', items: [] }, { id: '2', items: [] }] }))
    await expect(readBoundedFullTurnItem({ rpc }, 'child', () => null)).rejects.toThrow('one-turn page size')
  })
})
