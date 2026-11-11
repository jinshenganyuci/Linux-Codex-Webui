import { describe, expect, it } from 'vitest'
import { selectCurrentAndRecentThreads } from './recentThreadUtils'

const threads = ['latest', 'second', 'third', 'fourth', 'fifth', 'older']
  .map((id) => ({ id }))

describe('selectCurrentAndRecentThreads', () => {
  it('keeps the latest chats in order when no current chat is available', () => {
    expect(selectCurrentAndRecentThreads(threads, '', 3).map((thread) => thread.id))
      .toEqual(['latest', 'second', 'third'])
  })

  it('puts an older current chat first without duplicating it', () => {
    expect(selectCurrentAndRecentThreads(threads, 'older', 3).map((thread) => thread.id))
      .toEqual(['older', 'latest', 'second'])
  })

  it('keeps a recent current chat once and honors the limit', () => {
    expect(selectCurrentAndRecentThreads(threads, 'second', 4).map((thread) => thread.id))
      .toEqual(['second', 'latest', 'third', 'fourth'])
    expect(selectCurrentAndRecentThreads(threads, 'second', 1).map((thread) => thread.id))
      .toEqual(['second'])
    expect(selectCurrentAndRecentThreads(threads, 'second', 0)).toEqual([])
  })
})
