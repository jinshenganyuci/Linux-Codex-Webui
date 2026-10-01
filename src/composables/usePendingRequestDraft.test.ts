import { createRenderer, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePendingRequestDraft } from './usePendingRequestDraft'
import { createPendingRequestDraftStore, PENDING_REQUEST_DRAFTS_KEY, pendingRequestDraftIdentity } from '../pendingRequestDrafts'
import type { UiServerRequest } from '../types/codex'

type TestNode = { children: TestNode[] }
const renderer = createRenderer<TestNode, TestNode>({
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }), insert: (node, parent) => { parent.children.push(node) },
  remove: () => {}, setText: () => {}, setElementText: () => {}, patchProp: () => {},
  parentNode: () => null, nextSibling: () => null,
})
const mounted: Array<() => void> = []
let storage: Storage
let pagehide: (() => void) | null

function questionRequest(overrides: Partial<UiServerRequest> = {}): UiServerRequest {
  return {
    id: 42, generation: 3, threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a',
    receivedAtIso: '2026-10-01T01:00:00Z', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'choice' }, { id: 'secret', isSecret: true }] }, ...overrides,
  }
}

function mountDraft(initial: UiServerRequest | null) {
  const request = ref(initial)
  let draft!: ReturnType<typeof usePendingRequestDraft>
  const app = renderer.createApp(defineComponent({
    setup() { draft = usePendingRequestDraft(request); return () => h('div') },
  }))
  app.mount({ children: [] })
  mounted.push(() => app.unmount())
  return { request, draft, unmount: () => app.unmount() }
}

beforeEach(() => {
  vi.useFakeTimers()
  const data = new Map<string, string>()
  storage = {
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) }, clear: () => data.clear(), key: () => null, length: 0,
  }
  pagehide = null
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: (name: string, listener: () => void) => { if (name === 'pagehide') pagehide = listener },
    removeEventListener: () => {},
  })
})
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pending answer draft lifecycle', () => {
  it('keeps stored drafts while pending requests are loading and restores a refreshed object', () => {
    const original = questionRequest()
    const store = createPendingRequestDraftStore(storage)
    store.write(pendingRequestDraftIdentity(original), { answers: {}, otherAnswers: { '42:choice': 'saved answer' } })
    const { request, draft } = mountDraft(null)
    vi.advanceTimersByTime(5000)
    expect(store.read(pendingRequestDraftIdentity(original))?.otherAnswers['42:choice']).toBe('saved answer')
    request.value = JSON.parse(JSON.stringify(original))
    expect(draft.otherAnswers.value['42:choice']).toBe('saved answer')
  })

  it('flushes edits on question/thread switches and restores the right request', () => {
    const first = questionRequest()
    const second = questionRequest({ threadId: 'thread-b', turnId: 'turn-b' })
    const { request, draft } = mountDraft(first)
    draft.otherAnswers.value = { '42:choice': 'first answer' }
    request.value = second
    expect(draft.otherAnswers.value).toEqual({})
    draft.otherAnswers.value = { '42:choice': 'second answer' }
    request.value = first
    expect(draft.otherAnswers.value['42:choice']).toBe('first answer')
    request.value = second
    expect(draft.otherAnswers.value['42:choice']).toBe('second answer')
  })

  it('coalesces keystrokes and flushes immediately before a refresh', () => {
    const setItem = vi.spyOn(storage, 'setItem')
    const { draft } = mountDraft(questionRequest())
    for (let count = 0; count < 10; count++) {
      draft.otherAnswers.value = { '42:choice': `answer ${count}` }
      vi.advanceTimersByTime(10)
    }
    expect(setItem).not.toHaveBeenCalled()
    pagehide?.()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toContain('answer 9')
    vi.advanceTimersByTime(1000)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it.each([{ isSecret: true }, { secret: true }, { isSecret: false, secret: true }])('never persists secret or unknown question answers with %j', (secretFlags) => {
    const { draft } = mountDraft(questionRequest({
      params: { questions: [{ id: 'choice' }, { id: 'secret', ...secretFlags }] },
    }))
    draft.answers.value = { '42:secret': 'private-choice', '42:choice': 'safe-choice', '42:unknown': 'unknown-choice' }
    draft.otherAnswers.value = { '42:secret': 'private-value', '42:choice': 'safe-value' }
    vi.advanceTimersByTime(250)
    const stored = storage.getItem(PENDING_REQUEST_DRAFTS_KEY)
    expect(stored).toContain('safe-value')
    expect(stored).not.toContain('private')
    expect(stored).not.toContain('unknown')
  })

  it('does not restore legacy secret answers from an existing stored draft', () => {
    const request = questionRequest({ params: { questions: [{ id: 'secret', secret: true }, { id: 'choice' }] } })
    createPendingRequestDraftStore(storage).write(pendingRequestDraftIdentity(request), {
      answers: { '42:secret': 'old-secret-choice' },
      otherAnswers: { '42:secret': 'old-secret-answer', '42:choice': 'public-answer' },
    })
    const { draft } = mountDraft(request)
    expect(draft.answers.value['42:secret']).toBeUndefined()
    expect(draft.otherAnswers.value['42:secret']).toBeUndefined()
    expect(draft.otherAnswers.value['42:choice']).toBe('public-answer')
    draft.otherAnswers.value = { ...draft.otherAnswers.value, '42:choice': 'updated-public-answer' }
    vi.advanceTimersByTime(250)
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).not.toContain('old-secret')
  })

  it('retains a draft until success is acknowledged and prevents delayed writes resurrecting it', () => {
    const first = questionRequest()
    const { draft } = mountDraft(first)
    draft.otherAnswers.value = { '42:choice': 'retry me' }
    draft.flush()
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toContain('retry me')
    draft.otherAnswers.value = { '42:choice': 'pending timer' }
    draft.clearSubmitted(pendingRequestDraftIdentity(first))
    vi.advanceTimersByTime(1000)
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toBeNull()
  })

  it('a late success clears only the submitted request after selection has changed', () => {
    const first = questionRequest()
    const { request, draft } = mountDraft(first)
    draft.otherAnswers.value = { '42:choice': 'first answer' }
    request.value = questionRequest({ turnId: 'other-turn' })
    draft.otherAnswers.value = { '42:choice': 'second answer' }
    draft.clearSubmitted(pendingRequestDraftIdentity(first))
    vi.advanceTimersByTime(250)
    expect(draft.otherAnswers.value['42:choice']).toBe('second answer')
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toContain('second answer')
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).not.toContain('first answer')
  })

  it('preserves unsaved text and reports storage failure', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    const { draft } = mountDraft(questionRequest())
    draft.otherAnswers.value = { '42:choice': 'keep in memory' }
    vi.advanceTimersByTime(250)
    expect(draft.status.value).toBe('unavailable')
    expect(draft.otherAnswers.value['42:choice']).toBe('keep in memory')
  })
})
