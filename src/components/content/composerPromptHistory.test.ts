import { describe, expect, it, vi } from 'vitest'
import {
  appendPromptHistory,
  MAX_PROMPT_HISTORY_ENTRIES,
  MAX_PROMPT_HISTORY_LENGTH,
  MAX_PROMPT_HISTORY_TOTAL_LENGTH,
  PROMPT_HISTORY_STORAGE_KEY,
  readPromptHistory,
  searchPromptHistory,
  writePromptHistory,
} from './composerPromptHistory'

describe('composer prompt history', () => {
  it('keeps the newest unique prompts within a bounded history', () => {
    const history = Array.from({ length: MAX_PROMPT_HISTORY_ENTRIES }, (_, index) => `prompt ${index}`)
    expect(appendPromptHistory(history, ' prompt 20 ')).toEqual([
      ...history.filter((entry) => entry !== 'prompt 20'),
      'prompt 20',
    ])
    expect(appendPromptHistory(history, 'new prompt')).toHaveLength(MAX_PROMPT_HISTORY_ENTRIES)
    expect(appendPromptHistory(history, 'new prompt')[0]).toBe('prompt 1')
    expect(appendPromptHistory(history, ' '.repeat(3))).toEqual(history)
    expect(appendPromptHistory(history, 'x'.repeat(MAX_PROMPT_HISTORY_LENGTH + 1))).toEqual(history)
    const largePrompts = Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(MAX_PROMPT_HISTORY_LENGTH - 3)}`)
    const bounded = largePrompts.reduce(appendPromptHistory, [] as string[])
    expect(bounded.reduce((total, entry) => total + entry.length, 0)).toBeLessThanOrEqual(MAX_PROMPT_HISTORY_TOTAL_LENGTH)
    expect(bounded.at(-1)).toBe(largePrompts.at(-1))
  })

  it('searches newest first and limits visible results', () => {
    expect(searchPromptHistory(['find files', 'review code', 'find chats'], 'FIND', 1)).toEqual(['find chats'])
    expect(searchPromptHistory(['one', 'two', 'three'], '', 2)).toEqual(['three', 'two'])
    expect(searchPromptHistory(['one'], 'missing')).toEqual([])
  })

  it('recovers bounded valid prompts from storage and tolerates storage errors', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify(['first', null, 'second', 'first'])),
      setItem: vi.fn(),
    }
    expect(readPromptHistory(storage)).toEqual(['second', 'first'])
    writePromptHistory(storage, ['second', 'first'])
    expect(storage.setItem).toHaveBeenCalledWith(PROMPT_HISTORY_STORAGE_KEY, '["second","first"]')
    expect(readPromptHistory({ getItem: () => '{bad json' })).toEqual([])
    expect(readPromptHistory({ getItem: () => { throw new Error('blocked') } })).toEqual([])
    expect(() => writePromptHistory({ setItem: () => { throw new Error('quota') } }, ['prompt'])).not.toThrow()
  })
})
