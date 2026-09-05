import { describe, expect, it } from 'vitest'
import { RuntimeNoticeStore } from './runtimeNotices'

describe('native runtime notices', () => {
  it('keeps safety, verification and authentication separate and clears only transient notices', () => {
    const store = new RuntimeNoticeStore()
    const params = { threadId: 'thread', turnId: 'turn' }
    store.observe('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
    store.observe('model/safetyBuffering/updated', { ...params, showBufferingUi: true, model: 'gpt-6-astra', reasons: ['review'] })
    store.observe('model/verification', { ...params, verifications: ['trustedAccessForCyber'] })
    store.observe('modelProvider/authRecoveryStarted', { ...params, provider: 'myproxy', message: 'secret must not be echoed' })
    expect(store.read('thread').map(notice => notice.kind)).toEqual(['safety', 'verification', 'authentication'])
    expect(JSON.stringify(store.snapshot())).not.toContain('secret')
    store.observe('modelProvider/authRecoveryCompleted', params)
    expect(store.read('thread')).toHaveLength(2)
    store.observe('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed' } })
    expect(store.read('thread').map(notice => notice.kind)).toEqual(['verification'])
    store.observe('model/safetyBuffering/updated', { ...params, showBufferingUi: true })
    expect(store.read('thread')).toHaveLength(1)
    store.observe('turn/started', { threadId: 'thread', turn: { id: 'next' } })
    expect(store.read('thread')).toEqual([])
    expect(store.observe('model/verification', { ...params, verifications: ['stale'] })).toBe(false)
  })

  it('bounds thread count and detail size without copying raw moderation metadata', () => {
    const store = new RuntimeNoticeStore()
    for (let index = 0; index < 150; index += 1) {
      store.observe('model/verification', { threadId: `thread-${index}`, turnId: 'turn', verifications: Array(100).fill('detail'.repeat(1000)) })
    }
    expect(Object.keys(store.snapshot())).toHaveLength(64)
    expect(store.read('thread-149')[0]?.details).toHaveLength(4)
    expect(store.read('thread-149')[0]?.details[0]).toHaveLength(1000)
    store.observe('turn/moderationMetadata', { threadId: 'moderation', turnId: 'turn', metadata: { secret: 'not public' } })
    expect(JSON.stringify(store.snapshot())).not.toContain('not public')
  })

  it('restores a browser snapshot without adding another request or reviving other turns', () => {
    const store = new RuntimeNoticeStore()
    const notice = { kind: 'verification' as const, threadId: 'thread', turnId: 'turn', title: 'Account verification required', details: ['trustedAccessForCyber'], requiresAction: true }
    expect(store.replace('thread', 'turn', [notice])).toBe(true)
    expect(store.replace('thread', 'turn', [notice])).toBe(false)
    expect(store.replace('other', 'turn', [notice])).toBe(false)
  })
})
