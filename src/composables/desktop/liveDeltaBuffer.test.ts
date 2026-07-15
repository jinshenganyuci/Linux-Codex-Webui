import { describe, expect, it, vi } from 'vitest'
import {
  capUtf8Tail,
  createLiveDeltaBuffer,
  LIVE_DELTA_FLUSH_MS,
  type LiveDeltaTimer,
} from './liveDeltaBuffer'

type ScheduledTimer = {
  callback: () => void
  delayMs: number
  active: boolean
}

function createManualTimer() {
  const scheduled: ScheduledTimer[] = []
  const timer: LiveDeltaTimer = {
    schedule: vi.fn((callback, delayMs) => {
      const entry: ScheduledTimer = { callback, delayMs, active: true }
      scheduled.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    }),
    cancel: vi.fn((handle) => {
      const entry = handle as unknown as ScheduledTimer
      entry.active = false
    }),
  }

  return {
    timer,
    activeTimers: () => scheduled.filter((entry) => entry.active),
    runNext: () => {
      const entry = scheduled.find((candidate) => candidate.active)
      if (!entry) throw new Error('No active timer')
      entry.active = false
      entry.callback()
    },
  }
}

function createHarness(overrides: {
  agentTextMaxBytes?: number
  commandOutputMaxBytes?: number
  reasoningTextMaxBytes?: number
} = {}) {
  const manualTimer = createManualTimer()
  const agentText = new Map<string, string>()
  const commandOutput = new Map<string, string>()
  const reasoningText = new Map<string, string>()
  const writes: string[] = []
  const key = (threadId: string, itemId: string) => `${threadId}:${itemId}`
  const buffer = createLiveDeltaBuffer({
    ...overrides,
    timer: manualTimer.timer,
    getAgentText: (threadId, itemId) => agentText.get(key(threadId, itemId)) ?? '',
    setAgentText: (threadId, itemId, text) => {
      agentText.set(key(threadId, itemId), text)
      writes.push(`agent:${threadId}:${itemId}:${text}`)
    },
    updateCommandOutput: (threadId, itemId, update) => {
      const commandKey = key(threadId, itemId)
      const currentOutput = commandOutput.get(commandKey)
      if (currentOutput === undefined) return
      const output = update(currentOutput)
      commandOutput.set(commandKey, output)
      writes.push(`command:${threadId}:${itemId}:${output}`)
    },
    getReasoningText: (threadId) => reasoningText.get(threadId) ?? '',
    setReasoningText: (threadId, text) => {
      reasoningText.set(threadId, text)
      writes.push(`reasoning:${threadId}:${text}`)
    },
  })

  return {
    ...manualTimer,
    agentText,
    buffer,
    commandOutput,
    reasoningText,
    writes,
  }
}

describe('createLiveDeltaBuffer', () => {
  it('batches all channels into one 180ms timer and flushes in stable channel order', () => {
    const harness = createHarness()
    harness.commandOutput.set('thread-a:command-a', 'command:')
    harness.reasoningText.set('thread-a', 'reasoning:')

    harness.buffer.queueReasoningText('thread-a', 'deep ')
    harness.buffer.queueAgentText('thread-a', 'agent-a', 'hello ')
    harness.buffer.queueCommandOutput('thread-a', 'command-a', 'one ')
    harness.buffer.queueAgentText('thread-a', 'agent-a', 'world')
    harness.buffer.queueCommandOutput('thread-a', 'command-a', 'two')

    expect(harness.writes).toEqual([])
    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delayMs).toBe(LIVE_DELTA_FLUSH_MS)

    harness.runNext()

    expect(harness.writes).toEqual([
      'agent:thread-a:agent-a:hello world',
      'command:thread-a:command-a:command:one two',
      'reasoning:thread-a:reasoning:deep ',
    ])
    expect(harness.activeTimers()).toHaveLength(0)
  })

  it('resets the full flush window for entries left behind by a targeted flush', () => {
    const harness = createHarness()
    harness.commandOutput.set('thread-b:command-b', '')

    harness.buffer.queueAgentText('thread-a', 'agent-a', 'ready')
    harness.buffer.queueCommandOutput('thread-b', 'command-b', 'later')
    const firstTimer = harness.activeTimers()[0]

    harness.buffer.flush('thread-a', 'agent-a')

    expect(firstTimer?.active).toBe(false)
    expect(harness.writes).toEqual(['agent:thread-a:agent-a:ready'])
    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delayMs).toBe(LIVE_DELTA_FLUSH_MS)

    harness.runNext()
    expect(harness.writes).toEqual([
      'agent:thread-a:agent-a:ready',
      'command:thread-b:command-b:later',
    ])
  })

  it('caps each channel by UTF-8 bytes while retaining the newest tail', () => {
    const harness = createHarness({
      agentTextMaxBytes: 10,
      commandOutputMaxBytes: 10,
      reasoningTextMaxBytes: 8,
    })
    harness.agentText.set('thread-a:agent-a', 'prefix:')
    harness.commandOutput.set('thread-a:command-a', 'prefix:')
    harness.reasoningText.set('thread-a', 'prefix:')

    harness.buffer.queueAgentText('thread-a', 'agent-a', '甲乙hello')
    harness.buffer.queueCommandOutput('thread-a', 'command-a', 'latest')
    harness.buffer.queueReasoningText('thread-a', 'TAIL')
    harness.runNext()

    const outputs = [
      harness.agentText.get('thread-a:agent-a') ?? '',
      harness.commandOutput.get('thread-a:command-a') ?? '',
      harness.reasoningText.get('thread-a') ?? '',
    ]
    expect(outputs.map((value) => new TextEncoder().encode(value).byteLength)).toEqual([9, 10, 8])
    expect(outputs[0]).toBe('…\nhello')
    expect(outputs[1]).toBe('…\nlatest')
    expect(outputs[2]).toBe('…\nTAIL')
    expect(capUtf8Tail('你好世界hello', 10).endsWith('hello')).toBe(true)
  })

  it('discards per-thread work and reset cancels all pending work without disabling reuse', () => {
    const harness = createHarness()
    harness.commandOutput.set('thread-b:command-b', '')

    harness.buffer.queueAgentText('thread-a', 'agent-a', 'discarded')
    harness.buffer.queueReasoningText('thread-a', 'discarded')
    harness.buffer.queueCommandOutput('thread-b', 'command-b', 'kept')
    harness.buffer.discardThread('thread-a')
    harness.runNext()

    expect(harness.writes).toEqual(['command:thread-b:command-b:kept'])

    harness.buffer.queueAgentText('thread-a', 'agent-a', 'reset')
    expect(harness.activeTimers()).toHaveLength(1)
    harness.buffer.reset()
    expect(harness.activeTimers()).toHaveLength(0)
    expect(harness.writes).toEqual(['command:thread-b:command-b:kept'])

    harness.buffer.queueAgentText('thread-a', 'agent-a', 'reused')
    harness.runNext()
    expect(harness.writes.at(-1)).toBe('agent:thread-a:agent-a:reused')
  })

  it('can discard only reasoning when later agent content supersedes it', () => {
    const harness = createHarness()
    harness.buffer.queueReasoningText('thread-a', 'stale reasoning')
    harness.buffer.queueAgentText('thread-a', 'agent-a', 'answer')

    harness.buffer.discardReasoningForThread('thread-a')
    harness.runNext()

    expect(harness.writes).toEqual(['agent:thread-a:agent-a:answer'])
  })
})
