import { describe, expect, it } from 'vitest'
import {
  limitCommandOutputsInTurns,
  limitThreadCommandOutputs,
  THREAD_COMMAND_OUTPUT_MAX_BYTES,
  THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
  THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER,
  THREAD_RESPONSE_TURN_LIMIT,
  trimAndLimitThreadCommandOutputs,
} from './threadPayloadLimits'

function commandItem(id: string, aggregatedOutput: string): Record<string, unknown> {
  return {
    id,
    type: 'commandExecution',
    command: `run-${id}`,
    aggregatedOutput,
  }
}

function turn(id: string, items: unknown[]): Record<string, unknown> {
  return { id, items }
}

function resultWithTurns(turns: unknown[]): Record<string, unknown> {
  return {
    requestId: 'request-1',
    thread: {
      id: 'thread-1',
      turns,
    },
  }
}

function readTurns(result: unknown): Array<Record<string, unknown>> {
  return ((result as { thread: { turns: Array<Record<string, unknown>> } }).thread.turns)
}

function readItems(turn: Record<string, unknown>): Array<Record<string, unknown>> {
  return turn.items as Array<Record<string, unknown>>
}

describe('thread command output payload limits', () => {
  it('keeps the newest ASCII suffix inside the 256 KiB limit and records truncation metadata', () => {
    const originalOutput = `discard-this-prefix\n${'x'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 128)}\nlatest-line`
    const originalItem = commandItem('command-1', originalOutput)
    const originalTurn = turn('turn-1', [originalItem])
    const originalResult = resultWithTurns([originalTurn])

    const limitedResult = limitThreadCommandOutputs(originalResult)
    const limitedItem = readItems(readTurns(limitedResult)[0]!)[0]!
    const limitedOutput = limitedItem.aggregatedOutput as string
    const markerBytes = Buffer.byteLength(THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER, 'utf8')
    const expectedTailBytes = THREAD_COMMAND_OUTPUT_MAX_BYTES - markerBytes
    const encodedOriginal = Buffer.from(originalOutput, 'utf8')
    const expectedTail = encodedOriginal.subarray(encodedOriginal.byteLength - expectedTailBytes).toString('utf8')

    expect(limitedResult).not.toBe(originalResult)
    expect(limitedOutput).toBe(THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER + expectedTail)
    expect(Buffer.byteLength(limitedOutput, 'utf8')).toBe(THREAD_COMMAND_OUTPUT_MAX_BYTES)
    expect(limitedOutput).toContain('较早输出已省略')
    expect(limitedOutput.endsWith('\nlatest-line')).toBe(true)
    expect(limitedItem.aggregatedOutputTruncated).toBe(true)
    expect(limitedItem.aggregatedOutputOriginalBytes).toBe(encodedOriginal.byteLength)
    expect(originalItem.aggregatedOutput).toBe(originalOutput)
    expect('aggregatedOutputTruncated' in originalItem).toBe(false)
  })

  it('moves a multi-byte slice boundary to a valid UTF-8 character', () => {
    const originalOutput = `${'旧'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES)}最新🙂结尾`
    const originalBytes = Buffer.byteLength(originalOutput, 'utf8')
    const limited = limitCommandOutputsInTurns([
      turn('turn-multibyte', [commandItem('command-multibyte', originalOutput)]),
    ])
    const limitedItem = readItems(limited[0] as Record<string, unknown>)[0]!
    const limitedOutput = limitedItem.aggregatedOutput as string

    expect(Buffer.byteLength(limitedOutput, 'utf8')).toBeLessThanOrEqual(THREAD_COMMAND_OUTPUT_MAX_BYTES)
    expect(limitedOutput.startsWith(THREAD_COMMAND_OUTPUT_TRUNCATION_MARKER)).toBe(true)
    expect(limitedOutput.endsWith('最新🙂结尾')).toBe(true)
    expect(limitedOutput).not.toContain('\uFFFD')
    expect(limitedItem.aggregatedOutputOriginalBytes).toBe(originalBytes)
  })

  it('preserves references and shapes when command output is already within the limit', () => {
    const exactLimitCommand = commandItem('command-exact', 'a'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES))
    const normalItem = { id: 'message-1', type: 'agentMessage', text: 'unchanged' }
    const nonCommandWithLargeField = {
      id: 'tool-1',
      type: 'functionCallOutput',
      aggregatedOutput: 'z'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1),
    }
    const items = [exactLimitCommand, normalItem, nonCommandWithLargeField]
    const turns = [turn('turn-1', items)]
    const result = resultWithTurns(turns)

    const limitedResult = limitThreadCommandOutputs(result)

    expect(limitedResult).toBe(result)
    expect(readTurns(limitedResult)).toBe(turns)
    expect(readItems(readTurns(limitedResult)[0]!)).toBe(items)
    expect(readItems(readTurns(limitedResult)[0]!)[0]).toBe(exactLimitCommand)
    expect(Object.keys(exactLimitCommand)).toEqual(['id', 'type', 'command', 'aggregatedOutput'])
    expect(nonCommandWithLargeField.aggregatedOutput).toHaveLength(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)
  })

  it('clones only the changed item ancestry and never mutates the source objects', () => {
    const oversized = commandItem('command-large', 'q'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1))
    const sibling = { id: 'message-1', type: 'agentMessage', text: 'same reference' }
    const changedTurn = turn('turn-changed', [oversized, sibling])
    const untouchedTurn = turn('turn-untouched', [{ id: 'message-2', type: 'agentMessage', text: 'same turn' }])
    const sourceTurns = [changedTurn, untouchedTurn]
    const source = resultWithTurns(sourceTurns)
    Object.freeze(oversized)
    Object.freeze(changedTurn.items as unknown[])
    Object.freeze(changedTurn)
    Object.freeze(untouchedTurn)
    Object.freeze(sourceTurns)
    Object.freeze(source.thread as object)
    Object.freeze(source)

    const limited = limitThreadCommandOutputs(source)
    const limitedTurns = readTurns(limited)
    const limitedItems = readItems(limitedTurns[0]!)

    expect(limited).not.toBe(source)
    expect((limited as { thread: unknown }).thread).not.toBe(source.thread)
    expect(limitedTurns).not.toBe(sourceTurns)
    expect(limitedTurns[0]).not.toBe(changedTurn)
    expect(limitedTurns[1]).toBe(untouchedTurn)
    expect(limitedItems[0]).not.toBe(oversized)
    expect(limitedItems[1]).toBe(sibling)
    expect(oversized.aggregatedOutput).toBe('q'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1))

    const limitedAgain = limitThreadCommandOutputs(limited)
    expect(limitedAgain).toBe(limited)
  })

  it.each(['thread/read', 'thread/resume', 'thread/fork', 'thread/rollback'])(
    'trims %s to the newest turns before inspecting command output',
    (method) => {
      const discardedCommand = {
        id: 'discarded-command',
        type: 'commandExecution',
        get aggregatedOutput(): string {
          throw new Error('discarded turns must not be scanned')
        },
      }
      const allTurns = [
        turn('turn-0', [discardedCommand]),
        turn('turn-1', [{ id: 'message-old', type: 'agentMessage', text: 'old' }]),
        ...Array.from({ length: THREAD_RESPONSE_TURN_LIMIT }, (_, index) => turn(
          `turn-${index + 2}`,
          [index === THREAD_RESPONSE_TURN_LIMIT - 1
            ? commandItem('latest-command', `old\n${'n'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\nnew`)
            : { id: `message-${index}`, type: 'agentMessage', text: 'kept' }],
        )),
      ]
      const source = resultWithTurns(allTurns)

      const limited = trimAndLimitThreadCommandOutputs(method, source) as {
        threadTurnStartIndex: number
        thread: { turns: Array<Record<string, unknown>> }
      }

      expect(limited.threadTurnStartIndex).toBe(2)
      expect(limited.thread.turns).toHaveLength(THREAD_RESPONSE_TURN_LIMIT)
      expect(limited.thread.turns[0]?.id).toBe('turn-2')
      expect(limited.thread.turns.at(-1)?.id).toBe(`turn-${THREAD_RESPONSE_TURN_LIMIT + 1}`)
      const latestCommand = readItems(limited.thread.turns.at(-1)!)[0]!
      expect(latestCommand.aggregatedOutputTruncated).toBe(true)
      expect(Buffer.byteLength(latestCommand.aggregatedOutput as string, 'utf8')).toBeLessThanOrEqual(
        THREAD_COMMAND_OUTPUT_MAX_BYTES,
      )
      expect(readTurns(source)).toHaveLength(THREAD_RESPONSE_TURN_LIMIT + 2)
    },
  )

  it('leaves unsupported RPC methods and untrimmed in-limit thread results untouched', () => {
    const oversizedResult = resultWithTurns([
      turn('turn-1', [commandItem('command-1', 'x'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1))]),
    ])
    const normalResult = resultWithTurns(Array.from(
      { length: THREAD_RESPONSE_TURN_LIMIT },
      (_, index) => turn(`turn-${index}`, [{ id: `message-${index}`, type: 'agentMessage' }]),
    ))

    expect(trimAndLimitThreadCommandOutputs('thread/list', oversizedResult)).toBe(oversizedResult)
    expect(trimAndLimitThreadCommandOutputs('thread/read', normalResult)).toBe(normalResult)
    expect('threadTurnStartIndex' in normalResult).toBe(false)
  })

  it('caps only the selected page payload without applying the RPC ten-turn window', () => {
    const pageTurns = Array.from({ length: 12 }, (_, index) => turn(
      `page-turn-${index}`,
      [index === 0
        ? commandItem('page-command', 'p'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1))
        : { id: `page-message-${index}`, type: 'agentMessage' }],
    ))
    const pageResult = resultWithTurns(pageTurns)

    const limitedPage = limitThreadCommandOutputs(pageResult)
    const returnedTurns = readTurns(limitedPage)

    expect(returnedTurns).toHaveLength(12)
    expect(readItems(returnedTurns[0]!)[0]?.aggregatedOutputTruncated).toBe(true)
    expect(returnedTurns.slice(1).every((returnedTurn, index) => returnedTurn === pageTurns[index + 1])).toBe(true)
    expect('threadTurnStartIndex' in (limitedPage as Record<string, unknown>)).toBe(false)
  })

  it('caps thread/turns/list pages without trimming data or changing cursors', () => {
    const pageTurns = Array.from({ length: THREAD_RESPONSE_TURN_LIMIT + 2 }, (_, index) => turn(
      `native-turn-${index}`,
      [index === 0
        ? commandItem('native-command', `native-old\n${'n'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\nnative-latest`)
        : { id: `native-message-${index}`, type: 'agentMessage', text: 'kept' }],
    ))
    const source = {
      data: pageTurns,
      nextCursor: 'older-cursor',
      backwardsCursor: 'newer-cursor',
      pageMetadata: { untouched: true },
    }

    const limited = trimAndLimitThreadCommandOutputs('thread/turns/list', source) as {
      data: Array<Record<string, unknown>>
      nextCursor: string
      backwardsCursor: string
      pageMetadata: { untouched: boolean }
    }

    expect(limited).not.toBe(source)
    expect(limited.data).toHaveLength(THREAD_RESPONSE_TURN_LIMIT + 2)
    expect(limited.nextCursor).toBe('older-cursor')
    expect(limited.backwardsCursor).toBe('newer-cursor')
    expect(limited.pageMetadata).toBe(source.pageMetadata)
    expect(readItems(limited.data[0]!)[0]?.aggregatedOutputTruncated).toBe(true)
    expect((readItems(limited.data[0]!)[0]?.aggregatedOutput as string).endsWith('\nnative-latest')).toBe(true)
    expect(limited.data.slice(1).every((returnedTurn, index) => returnedTurn === pageTurns[index + 1])).toBe(true)
    expect(source.data).toHaveLength(THREAD_RESPONSE_TURN_LIMIT + 2)
    expect(readItems(source.data[0]!)[0]?.aggregatedOutputTruncated).toBeUndefined()
    expect('threadTurnStartIndex' in limited).toBe(false)
  })

  it('caps command items in thread/items/list while preserving entry and page envelopes', () => {
    const oversizedCommand = commandItem(
      'native-item-command',
      `discarded\n${'i'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\nitem-latest`,
    )
    const untouchedEntry = {
      turnId: 'turn-2',
      item: { id: 'message-2', type: 'agentMessage', text: 'same reference' },
    }
    const source = {
      data: [
        { turnId: 'turn-1', item: oversizedCommand, entryMetadata: 'preserved' },
        untouchedEntry,
      ],
      nextCursor: 'next-item-cursor',
      backwardsCursor: 'backwards-item-cursor',
    }

    const limited = trimAndLimitThreadCommandOutputs('thread/items/list', source) as {
      data: Array<{ turnId: string; item: Record<string, unknown>; entryMetadata?: string }>
      nextCursor: string
      backwardsCursor: string
    }

    expect(limited.data).toHaveLength(2)
    expect(limited.nextCursor).toBe('next-item-cursor')
    expect(limited.backwardsCursor).toBe('backwards-item-cursor')
    expect(limited.data[0]).not.toBe(source.data[0])
    expect(limited.data[0]?.entryMetadata).toBe('preserved')
    expect(limited.data[0]?.item.aggregatedOutputTruncated).toBe(true)
    expect((limited.data[0]?.item.aggregatedOutput as string).endsWith('\nitem-latest')).toBe(true)
    expect(limited.data[1]).toBe(untouchedEntry)
    expect(oversizedCommand.aggregatedOutputTruncated).toBeUndefined()
  })

  it('honors descending item-page order when assigning the shared response budget', () => {
    const source = {
      data: ['newest', 'middle', 'oldest'].map((id) => ({
        turnId: `turn-${id}`,
        item: commandItem(id, `${id}-prefix\n${id[0]!.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 32)}\n${id}-tail`),
      })),
      nextCursor: 'older-page',
    }

    const limited = trimAndLimitThreadCommandOutputs(
      'thread/items/list',
      source,
      { sortDirection: 'desc' },
    ) as { data: Array<{ item: Record<string, unknown> }> }
    const retainedOutputs = limited.data.map((entry) => entry.item.aggregatedOutput as string)

    expect(retainedOutputs[0]).toContain('newest-tail')
    expect(retainedOutputs[1]).toContain('middle-tail')
    expect(retainedOutputs[2]).toBe('')
    expect(retainedOutputs.reduce((total, output) => total + Buffer.byteLength(output, 'utf8'), 0)).toBe(
      THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
    )
  })

  it('shares one 512 KiB budget across a response and keeps the newest commands first', () => {
    const source = resultWithTurns(['oldest', 'middle', 'newest'].map((id) => turn(
      `turn-${id}`,
      [commandItem(id, `${id}-prefix\n${id[0]!.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 32)}\n${id}-tail`)],
    )))

    const limited = trimAndLimitThreadCommandOutputs('thread/read', source)
    const outputs = readTurns(limited).map((limitedTurn) => (
      readItems(limitedTurn)[0]!.aggregatedOutput as string
    ))

    expect(outputs[0]).toBe('')
    expect(outputs[1]).toContain('middle-tail')
    expect(outputs[2]).toContain('newest-tail')
    expect(outputs.reduce((total, output) => total + Buffer.byteLength(output, 'utf8'), 0)).toBe(
      THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
    )
  })

  it('caps thread/resume initialTurnsPage without applying the legacy ten-turn window to that page', () => {
    const legacyTurns = Array.from(
      { length: THREAD_RESPONSE_TURN_LIMIT + 1 },
      (_, index) => turn(`legacy-resume-${index}`, [{ id: `legacy-message-${index}`, type: 'agentMessage' }]),
    )
    const initialTurnsPageCommandIndex = 2
    const initialPageTurns = Array.from({ length: THREAD_RESPONSE_TURN_LIMIT + 3 }, (_, index) => turn(
      `initial-page-turn-${index}`,
      [index === initialTurnsPageCommandIndex
        ? commandItem('initial-page-command', 'r'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1))
        : { id: `initial-page-message-${index}`, type: 'agentMessage' }],
    ))
    const source = {
      thread: { id: 'resume-thread', turns: legacyTurns },
      initialTurnsPage: {
        data: initialPageTurns,
        nextCursor: 'initial-older-cursor',
        backwardsCursor: 'initial-newer-cursor',
      },
      turnsBackwardsCursor: 'head-cursor',
    }

    const limited = trimAndLimitThreadCommandOutputs('thread/resume', source) as {
      threadTurnStartIndex: number
      thread: { turns: unknown[] }
      initialTurnsPage: {
        data: Array<Record<string, unknown>>
        nextCursor: string
        backwardsCursor: string
      }
      turnsBackwardsCursor: string
    }

    expect(limited.thread.turns).toHaveLength(THREAD_RESPONSE_TURN_LIMIT)
    expect(limited.threadTurnStartIndex).toBe(1)
    expect(limited.initialTurnsPage.data).toHaveLength(THREAD_RESPONSE_TURN_LIMIT + 3)
    expect(limited.initialTurnsPage.nextCursor).toBe('initial-older-cursor')
    expect(limited.initialTurnsPage.backwardsCursor).toBe('initial-newer-cursor')
    expect(limited.turnsBackwardsCursor).toBe('head-cursor')
    expect(readItems(limited.initialTurnsPage.data[initialTurnsPageCommandIndex]!)[0]?.aggregatedOutputTruncated).toBe(true)
  })

  it('reserves the shared resume budget for the native initial page before compatibility turns', () => {
    const source = {
      thread: {
        id: 'resume-shared-budget',
        turns: [turn('compatibility-turn', [commandItem(
          'compatibility-command',
          `compatibility\n${'c'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 32)}\ncompatibility-tail`,
        )])],
      },
      initialTurnsPage: {
        data: ['newest-page', 'older-page'].map((id) => turn(
          `turn-${id}`,
          [commandItem(id, `${id}\n${id[0]!.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 32)}\n${id}-tail`)],
        )),
        nextCursor: null,
      },
    }

    const limited = trimAndLimitThreadCommandOutputs('thread/resume', source, {
      initialTurnsPage: { sortDirection: 'desc' },
    }) as {
      thread: { turns: Array<Record<string, unknown>> }
      initialTurnsPage: { data: Array<Record<string, unknown>> }
    }
    const initialOutputs = limited.initialTurnsPage.data.map((limitedTurn) => (
      readItems(limitedTurn)[0]!.aggregatedOutput as string
    ))
    const compatibilityOutput = readItems(limited.thread.turns[0]!)[0]!.aggregatedOutput as string

    expect(initialOutputs[0]).toContain('newest-page-tail')
    expect(initialOutputs[1]).toContain('older-page-tail')
    expect(initialOutputs.reduce((total, output) => total + Buffer.byteLength(output, 'utf8'), 0)).toBe(
      THREAD_COMMAND_OUTPUT_TOTAL_MAX_BYTES,
    )
    expect(compatibilityOutput).toBe('')
  })

  it('caps session-recovered and snapshot-merged commands after the final live-state merge without trimming history', () => {
    const fullHistory = Array.from({ length: 14 }, (_, index) => turn(
      `live-turn-${index}`,
      index === 13
        ? [
            commandItem('session-recovered-command', `session-old\n${'会'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES)}\nsession-latest`),
            commandItem('snapshot-merged-command', `snapshot-old\n${'s'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\nsnapshot-latest`),
          ]
        : [{ id: `live-message-${index}`, type: 'agentMessage' }],
    ))

    const limitedTurns = limitCommandOutputsInTurns(fullHistory)
    const liveCommands = readItems(limitedTurns.at(-1) as Record<string, unknown>)

    expect(limitedTurns).toHaveLength(14)
    expect(liveCommands).toHaveLength(2)
    expect(liveCommands[0]?.aggregatedOutputTruncated).toBe(true)
    expect((liveCommands[0]?.aggregatedOutput as string).endsWith('\nsession-latest')).toBe(true)
    expect(liveCommands[1]?.aggregatedOutputTruncated).toBe(true)
    expect((liveCommands[1]?.aggregatedOutput as string).endsWith('\nsnapshot-latest')).toBe(true)
    expect(fullHistory.at(-1)).not.toBe(limitedTurns.at(-1))
    expect((readItems(fullHistory.at(-1) as Record<string, unknown>)[0]?.aggregatedOutput as string).startsWith('session-old')).toBe(true)
  })

  it('bounds the stored live snapshot before sanitizing and caps newly recovered commands in the final pass', () => {
    const appServerCommand = commandItem(
      'app-server-command',
      `app-server-old\n${'a'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\napp-server-latest`,
    )
    const rawResult = resultWithTurns([turn('turn-live', [appServerCommand])])

    const boundedSnapshot = limitThreadCommandOutputs(rawResult)
    const boundedSnapshotTurns = readTurns(boundedSnapshot)
    const boundedAppServerCommand = readItems(boundedSnapshotTurns[0]!)[0]!
    const recoveredCommand = commandItem(
      'session-recovered-command',
      `session-old\n${'r'.repeat(THREAD_COMMAND_OUTPUT_MAX_BYTES + 1)}\nsession-latest`,
    )
    const mergedTurns = [{
      ...boundedSnapshotTurns[0],
      items: [...readItems(boundedSnapshotTurns[0]!), recoveredCommand],
    }]

    const responseTurns = limitCommandOutputsInTurns(mergedTurns)
    const responseItems = readItems(responseTurns[0] as Record<string, unknown>)

    expect(boundedAppServerCommand.aggregatedOutputTruncated).toBe(true)
    expect(Buffer.byteLength(boundedAppServerCommand.aggregatedOutput as string, 'utf8')).toBeLessThanOrEqual(
      THREAD_COMMAND_OUTPUT_MAX_BYTES,
    )
    expect(responseItems[0]).toBe(boundedAppServerCommand)
    expect(responseItems[1]?.aggregatedOutputTruncated).toBe(true)
    expect((responseItems[1]?.aggregatedOutput as string).endsWith('\nsession-latest')).toBe(true)
    expect(appServerCommand.aggregatedOutputTruncated).toBeUndefined()
  })
})
