import { describe, expect, it } from 'vitest'
import { normalizeComposerFileSearchMatches } from './codexAppServerBridge'

describe('composer file search results', () => {
  it('keeps file matches in server order, removes duplicates, and respects the limit', () => {
    expect(normalizeComposerFileSearchMatches({
      files: [
        { path: 'src', match_type: 'directory' },
        { path: '.git/refs/heads/main', match_type: 'file' },
        { path: 'node_modules/pkg/index.js', match_type: 'file' },
        { path: 'package.json', match_type: 'file' },
        { path: 'package.json', match_type: 'file' },
        { path: 'src/main.ts', match_type: 'file' },
        { path: 'src/App.vue', match_type: 'file' },
      ],
    }, 2)).toEqual([{ path: 'package.json' }, { path: 'src/main.ts' }])
  })

  it('rejects malformed responses so the legacy search can handle them', () => {
    expect(() => normalizeComposerFileSearchMatches({ result: [] }, 20))
      .toThrow('fuzzyFileSearch returned no files array')
  })
})
