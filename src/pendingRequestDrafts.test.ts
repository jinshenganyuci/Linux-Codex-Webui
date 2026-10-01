import { describe, expect, it, vi } from 'vitest'
import type { UiServerRequest } from './types/codex'
import {
  createPendingRequestDraftStore,
  isUserInputRequest,
  orderPendingRequests,
  pendingRequestDraftIdentity,
  PENDING_REQUEST_DRAFT_TTL_MS,
  PENDING_REQUEST_DRAFTS_KEY,
  selectPendingRequest,
} from './pendingRequestDrafts'

function request(overrides: Partial<UiServerRequest> = {}): UiServerRequest {
  return {
    id: 7, generation: 3, method: 'item/tool/requestUserInput',
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a',
    receivedAtIso: '2026-10-01T08:00:00.000Z', params: {}, ...overrides,
  }
}

function memoryStorage(initial: string | null = null) {
  const values = new Map<string, string>()
  if (initial !== null) values.set(PENDING_REQUEST_DRAFTS_KEY, initial)
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
}

const draft = { answers: { '7:kind': 'Website' }, otherAnswers: { '7:style': 'Custom' } }

describe('pending request selection and identity', () => {
  it('prioritizes blocking requests without mutating input or overriding an explicit async selection', () => {
    const asyncFirst = request({ id: 1, method: 'request_user_input_async', params: { isBlocking: false } })
    const blocking = request({ id: 2 })
    const asyncLast = request({ id: 3, params: { isBlocking: false } })
    const approval = request({ id: 4, method: 'item/commandExecution/requestApproval' })
    const original = [asyncFirst, blocking, asyncLast, approval]
    expect(orderPendingRequests(original)).toEqual([blocking, approval, asyncFirst, asyncLast])
    expect(original).toEqual([asyncFirst, blocking, asyncLast, approval])
    expect(selectPendingRequest(original, '')).toBe(blocking)
    expect(selectPendingRequest(original, pendingRequestDraftIdentity(asyncLast))).toBe(asyncLast)
    expect(selectPendingRequest(original, 'resolved-request')).toBe(blocking)
    expect(selectPendingRequest([asyncFirst, asyncLast], '')).toBe(asyncFirst)
    expect(selectPendingRequest([], '')).toBeNull()
  })

  it('retains identity across pending-list refreshes and parameter changes', () => {
    const original = request()
    const refreshed = JSON.parse(JSON.stringify(original)) as UiServerRequest
    refreshed.params = { questions: [{ id: 'kind', question: 'Choose a type' }] }
    expect(refreshed).not.toBe(original)
    expect(pendingRequestDraftIdentity(refreshed)).toBe(pendingRequestDraftIdentity(original))
    expect(selectPendingRequest([refreshed], pendingRequestDraftIdentity(original))).toBe(refreshed)
  })

  it.each([
    ['thread', { threadId: 'thread-b' }],
    ['numeric versus string ID', { id: '7' }],
    ['ID value', { id: 8 }],
    ['generation', { generation: 4 }],
    ['method', { method: 'request_user_input_async' }],
    ['turn', { turnId: 'turn-b' }],
    ['item', { itemId: 'item-b' }],
    ['bridge receipt time', { receivedAtIso: '2026-10-01T08:01:00.000Z' }],
  ] satisfies [string, Partial<UiServerRequest>][])('isolates drafts by %s', (_, change) => {
    const store = createPendingRequestDraftStore(memoryStorage())
    const key = pendingRequestDraftIdentity(request())
    expect(store.write(key, draft)).toBe(true)
    const differentKey = pendingRequestDraftIdentity(request(change))
    expect(differentKey).not.toBe(key)
    expect(store.read(differentKey)).toBeNull()
  })

  it('recognizes all supported question methods and excludes approval requests', () => {
    for (const method of ['item/tool/requestUserInput', 'request_user_input', 'request_user_input_async']) {
      expect(isUserInputRequest(request({ method }))).toBe(true)
    }
    expect(isUserInputRequest(request({ method: 'item/commandExecution/requestApproval' }))).toBe(false)
  })
})

describe('pending input draft storage', () => {
  it('restores both answer types after recreating the store and removes only the submitted draft', () => {
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage)
    expect(store.write('first', draft)).toBe(true)
    expect(store.write('second', { answers: { q: 'Another question' }, otherAnswers: {} })).toBe(true)
    const reloaded = createPendingRequestDraftStore(storage)
    expect(reloaded.read('first')).toEqual(draft)
    expect(reloaded.remove('first')).toBe(true)
    expect(reloaded.read('first')).toBeNull()
    expect(reloaded.read('second')?.answers.q).toBe('Another question')
    expect(reloaded.remove('second')).toBe(true)
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toBeNull()
  })

  it('replaces an existing draft and removes it when all answers are cleared', () => {
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage)
    store.write('key', draft)
    store.write('key', { answers: { q: 'Changed' }, otherAnswers: {} })
    expect(JSON.parse(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)!)).toHaveLength(1)
    expect(store.read('key')).toEqual({ answers: { q: 'Changed' }, otherAnswers: {} })
    expect(store.write('key', { answers: { q: '' }, otherAnswers: { q: '' } })).toBe(true)
    expect(store.read('key')).toBeNull()
    expect(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)).toBeNull()
  })

  it('tolerates unavailable storage', () => {
    const store = createPendingRequestDraftStore(null)
    expect(store.read('key')).toBeNull()
    expect(store.write('key', draft)).toBe(false)
    expect(store.remove('key')).toBe(false)
  })

  it.each([
    ['invalid JSON', 'not-json'],
    ['object', '{}'],
    ['null', 'null'],
    ['string', '"text"'],
    ['oversized JSON', '[' + ' '.repeat(128 * 1024) + ']'],
  ])('ignores corrupt or oversized storage: %s', (_, raw) => {
    const store = createPendingRequestDraftStore(memoryStorage(raw))
    expect(store.read('key')).toBeNull()
    expect(store.write('key', draft)).toBe(true)
    expect(store.read('key')).toEqual(draft)
  })

  it('filters malformed rows while retaining valid drafts', () => {
    const now = 1_000_000_000
    const valid = { key: 'valid', updatedAt: now, ...draft }
    const malformed = [
      null, false, 1, {},
      { ...valid, key: 1 },
      { ...valid, key: 'x'.repeat(4097) },
      { ...valid, updatedAt: 'yesterday' },
      { ...valid, updatedAt: now + 1 },
      { ...valid, answers: [] },
      { ...valid, otherAnswers: null },
      { ...valid, answers: { q: 123 } },
      { ...valid, answers: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), 'a'])) },
    ]
    const store = createPendingRequestDraftStore(memoryStorage(JSON.stringify([...malformed, valid])), () => now)
    expect(store.read('valid')).toEqual(draft)
    expect(store.read('missing')).toBeNull()
    store.write('new', draft)
    expect(store.read('new')).toEqual(draft)
  })

  it('catches read, write, and remove storage exceptions', () => {
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage)
    storage.getItem.mockImplementationOnce(() => { throw new Error('Access denied') })
    expect(store.read('key')).toBeNull()
    storage.setItem.mockImplementationOnce(() => { throw new Error('Quota exceeded') })
    expect(store.write('key', draft)).toBe(false)
    store.write('key', draft)
    storage.removeItem.mockImplementationOnce(() => { throw new Error('Access denied') })
    expect(store.remove('key')).toBe(false)
    expect(store.read('key')).toEqual(draft)
  })

  it('expires drafts at seven days and refreshes the lifetime when edited', () => {
    let now = 1_000_000_000
    const store = createPendingRequestDraftStore(memoryStorage(), () => now)
    store.write('expires', draft)
    store.write('edited', draft)
    now += PENDING_REQUEST_DRAFT_TTL_MS - 1
    expect(store.read('expires')).toEqual(draft)
    store.write('edited', draft)
    now += 1
    expect(store.read('expires')).toBeNull()
    expect(store.read('edited')).toEqual(draft)
  })

  it('keeps the latest 24 drafts and preserves an older draft that is edited again', () => {
    let now = 1_000_000_000
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage, () => now++)
    for (let i = 0; i < 24; i += 1) expect(store.write(`draft-${i}`, draft)).toBe(true)
    store.write('draft-0', { answers: { q: 'Edited' }, otherAnswers: {} })
    store.write('draft-24', draft)
    expect(JSON.parse(storage.getItem(PENDING_REQUEST_DRAFTS_KEY)!)).toHaveLength(24)
    expect(store.read('draft-1')).toBeNull()
    expect(store.read('draft-0')?.answers.q).toBe('Edited')
    expect(store.read('draft-24')).toEqual(draft)
  })

  it('evicts oldest drafts to remain within the 128 Ki-character storage budget', () => {
    let now = 1_000_000_000
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage, () => now++)
    const largeDraft = { answers: { q: '汉'.repeat(15_000) }, otherAnswers: {} }
    for (let i = 0; i < 12; i += 1) expect(store.write(`draft-${i}`, largeDraft)).toBe(true)
    const serialized = storage.getItem(PENDING_REQUEST_DRAFTS_KEY)!
    expect(serialized.length).toBeLessThanOrEqual(128 * 1024)
    const rows = JSON.parse(serialized) as Array<{ key: string }>
    expect(rows).toHaveLength(8)
    expect(rows.map((row) => row.key)).toEqual(Array.from({ length: 8 }, (_, i) => `draft-${11 - i}`))
    expect(store.read('draft-3')).toBeNull()
    expect(store.read('draft-11')).toEqual(largeDraft)
  })

  it('rejects a draft above 16 Ki characters without replacing the prior saved value', () => {
    const storage = memoryStorage()
    const store = createPendingRequestDraftStore(storage)
    const emptyDraft = { answers: { q: '' }, otherAnswers: {} }
    const available = 16 * 1024 - JSON.stringify(emptyDraft).length
    const boundary = { answers: { q: 'a'.repeat(available) }, otherAnswers: {} }
    expect(JSON.stringify(boundary)).toHaveLength(16 * 1024)
    expect(store.write('key', boundary)).toBe(true)
    expect(store.write('key', { answers: { q: 'a'.repeat(available + 1) }, otherAnswers: {} })).toBe(false)
    expect(store.read('key')).toEqual(boundary)
    expect(store.write('x'.repeat(4097), draft)).toBe(false)
    expect(store.read('key')).toEqual(boundary)
  })

  it.each(['answers', 'otherAnswers'] as const)('rejects more than 100 %s entries without discarding the saved draft', (field) => {
    const store = createPendingRequestDraftStore(memoryStorage())
    expect(store.write('key', draft)).toBe(true)
    const oversizedRecord = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q-${i}`, 'a']))
    expect(store.write('key', { ...draft, [field]: oversizedRecord })).toBe(false)
    expect(store.read('key')).toEqual(draft)
  })
})
