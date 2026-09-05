import { describe, expect, it } from 'vitest'
import { normalizeRuntimeItem } from './runtimeItems'
import { limitRuntimeItemPayload } from './server/threadPayloadLimits'

describe('native activity history', () => {
  it.each([
    [{ id: 'sleep', type: 'sleep', durationMs: 42 }, 'Waiting'],
    [{ id: 'output', type: 'functionCallOutput', name: 'lookup', output: [{ type: 'input_text', text: 'found' }] }, 'Tool output'],
    [{ id: 'agent', type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed', agentPath: '/child' }, 'Subagent activity'],
    [{ id: 'hook', type: 'hookPrompt', fragments: [{ hookRunId: 'run', text: 'hook text' }] }, 'Hook context'],
  ])('renders %j instead of discarding it', (item, title) => {
    expect(normalizeRuntimeItem(item)?.runtimeItem?.title).toBe(title)
  })

  it('uses bounded plain-text fallback for unknown items, not arbitrary raw JSON', () => {
    const item = normalizeRuntimeItem({ id: 'future', type: 'futureItem', secret: 'hidden' })
    expect(item?.isUnhandled).toBe(true)
    expect(JSON.stringify(item)).not.toContain('hidden')
    expect(normalizeRuntimeItem({ id: 'output', type: 'functionCallOutput', name: 'read', output: 'large'.repeat(100_000) })?.runtimeItem).toMatchObject({ truncated: true })
  })

  it('caps standalone tool output and hook payloads before sending to the browser', () => {
    const item = { id: 'output', type: 'functionCallOutput', output: '中'.repeat(100_000) }
    const limited = limitRuntimeItemPayload(item) as typeof item & { outputTruncated: boolean }
    expect(limited.outputTruncated).toBe(true)
    expect(Buffer.byteLength(limited.output)).toBeLessThanOrEqual(64 * 1024)
    expect(limited.output).not.toContain('\uFFFD')
    expect(item.output).toHaveLength(100_000)
  })
})
