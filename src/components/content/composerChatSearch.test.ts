import { describe, expect, it } from 'vitest'
import type { UiProjectGroup, UiThread } from '../../types/codex'
import { searchComposerChats } from './composerChatSearch'

function thread(id: string, title: string, preview: string, updatedAtIso: string): UiThread {
  return {
    id,
    title,
    preview,
    projectName: 'Project',
    cwd: '/project',
    hasWorktree: false,
    createdAtIso: updatedAtIso,
    updatedAtIso,
    unread: false,
    inProgress: false,
    historyMode: 'legacy',
  }
}

describe('composer chat search', () => {
  const groups: UiProjectGroup[] = [{
    projectName: 'Project',
    threads: [
      thread('preview', 'Another chat', 'About source files', '2026-01-03T00:00:00Z'),
      thread('prefix', 'Source overview', '', '2026-01-01T00:00:00Z'),
      thread('exact', 'Source', '', '2026-01-02T00:00:00Z'),
      thread('duplicate', 'Source notes', '', '2026-01-04T00:00:00Z'),
    ],
  }, {
    projectName: 'Other',
    threads: [thread('duplicate', 'Source notes', '', '2026-01-04T00:00:00Z')],
  }]

  it('ranks exact titles before prefixes and preview matches without duplicates', () => {
    expect(searchComposerChats(groups, 'source').map((row) => row.id))
      .toEqual(['exact', 'duplicate', 'prefix', 'preview'])
  })

  it('honors the limit and ignores empty queries', () => {
    expect(searchComposerChats(groups, 'source', 2).map((row) => row.id)).toEqual(['exact', 'duplicate'])
    expect(searchComposerChats(groups, ' ')).toEqual([])
  })
})
