import { describe, expect, it } from 'vitest'
import { parentThreadHref, readThreadReturnPath, subagentThreadHref } from './subagentNavigation'

describe('subagent return navigation', () => {
  it('embeds the source in either child link entry', () => {
    expect(subagentThreadHref('child', 'root', undefined)).toBe('#/thread/child?from=root')
  })
  it('restores a return target from a reloaded or new-tab URL', () => {
    const url = new URL(subagentThreadHref('child', 'root', undefined).slice(1), 'http://localhost')
    expect(parentThreadHref('child', url.searchParams.getAll('from'))).toBe('#/thread/root')
  })
  it('returns through nested conversations one level at a time', () => {
    expect(subagentThreadHref('grandchild', 'child', 'root')).toBe('#/thread/grandchild?from=root&from=child')
    expect(parentThreadHref('grandchild', ['root', 'child'])).toBe('#/thread/child?from=root')
    expect(parentThreadHref('child', 'root')).toBe('#/thread/root')
  })
  it('does not show a return target on ordinary direct thread links', () => {
    expect(parentThreadHref('root', undefined)).toBe('')
  })
  it('uses the current source when the same child is opened from another conversation', () => {
    expect(subagentThreadHref('child', 'other-root', undefined)).toBe('#/thread/child?from=other-root')
  })
  it('unwinds references back to an ancestor instead of creating a cycle', () => {
    expect(subagentThreadHref('root', 'child', 'root')).toBe('#/thread/root')
    expect(subagentThreadHref('child', 'grandchild', ['root', 'child'])).toBe('#/thread/child?from=root')
    expect(readThreadReturnPath('child', ['root', 'child', 'grandchild'])).toEqual(['root'])
  })
  it('ignores malformed, self and repeated origins', () => {
    expect(parentThreadHref('child', [null, 'https://example.com', 'child'])).toBe('')
    expect(parentThreadHref('child', ['root', 'root'])).toBe('#/thread/root')
  })
  it('bounds link growth while retaining the nearest parent', () => {
    const href = subagentThreadHref('next', 'current', Array.from({ length: 16 }, (_, i) => `parent-${i}`))
    const parents = new URL(href.slice(1), 'http://localhost').searchParams.getAll('from')
    expect(parents).toHaveLength(16)
    expect(parents.at(-1)).toBe('current')
  })
})
