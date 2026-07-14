import { describe, expect, it } from 'vitest'
import { togglePinnedThreadId } from './pinnedThreadUtils'

describe('togglePinnedThreadId', () => {
  it('adds a newly pinned chat to the front', () => {
    expect(togglePinnedThreadId(['thread-b'], 'thread-a')).toEqual(['thread-a', 'thread-b'])
  })

  it('removes an explicitly unpinned chat without pruning other saved ids', () => {
    expect(togglePinnedThreadId(['thread-a', 'not-loaded-yet'], 'thread-a')).toEqual(['not-loaded-yet'])
  })
})
