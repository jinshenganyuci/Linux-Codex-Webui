import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'
import type { UiMessage } from '../types/codex'
import { EMPTY_NATIVE_CAPABILITIES } from '../nativeThreadControls'

const gatewayMocks = vi.hoisted(() => ({
  subscribeCodexNotifications: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getThreadSummary: vi.fn(),
  getThreadHistoryDetail: vi.fn(),
  getOlderThreadHistoryPage: vi.fn(),
  getRequestUserInputHistory: vi.fn(),
  getPlanSummaryHistory: vi.fn(),
  getAgentProgress: vi.fn(),
}))
vi.mock('../api/codexGateway', async importOriginal => ({
  ...await importOriginal<typeof import('../api/codexGateway')>(), ...gatewayMocks,
}))
vi.mock('../api/nativeThreadGateway', () => ({
  getNativeCapabilities: vi.fn(async () => ({ ...EMPTY_NATIVE_CAPABILITIES })),
  getNativeThreadState: vi.fn(async () => ({ mode: 'legacy', settings: null })),
  invalidateNativeCapabilities: vi.fn(),
}))

function installTestWindow() {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
}
function history(messages: UiMessage[], inProgress = false) {
  return {
    historyMode: 'paginated', model: '', modelProvider: '', messages,
    turnIds: [...new Set(messages.map(message => message.turnId).filter(Boolean))],
    inProgress, activeTurnId: inProgress ? 'turn-a' : '', hasMoreOlder: false, olderCursor: null,
    startTurnIndex: null, turnIndexByTurnId: {}, resumed: true, materialized: true,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getRequestUserInputHistory.mockResolvedValue([])
  gatewayMocks.getPlanSummaryHistory.mockResolvedValue([])
  gatewayMocks.getAgentProgress.mockResolvedValue(null)
  gatewayMocks.getThreadSummary.mockResolvedValue({ id: 'mobile-thread', title: 'Mobile', projectName: '', cwd: '', historyMode: 'paginated' })
  gatewayMocks.getThreadHistoryDetail.mockResolvedValue(history([]))
  gatewayMocks.getOlderThreadHistoryPage.mockResolvedValue(history([]))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('mobile resume duplicate assistant reproduction', () => {
  function setup() {
    vi.useFakeTimers()
    installTestWindow()
    let notify!: (notification: { method: string; params?: unknown; atIso?: string }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('mobile-thread')
    state.startNotificationStream()
    return { state, notify }
  }

  function delta(notify: ReturnType<typeof setup>['notify'], text = 'Only one reply') {
    notify({ method: 'item/agentMessage/delta', params: {
      threadId: 'mobile-thread', turnId: 'turn-a', itemId: 'assistant-item', delta: text,
    } })
  }

  function completeItem(notify: ReturnType<typeof setup>['notify']) {
    notify({ method: 'item/completed', params: {
      threadId: 'mobile-thread', turnId: 'turn-a',
      item: { id: 'assistant-item', type: 'agentMessage', text: 'Only one reply', phase: 'final_answer' },
    } })
  }

  it('preserves the notification turn ID when replay begins with agent delta rather than turn/started', async () => {
    const { state, notify } = setup()
    delta(notify)
    await vi.advanceTimersByTimeAsync(180)
    const partial = state.messages.value.filter(message => message.role === 'assistant')
    expect(partial).toHaveLength(1)
    // Replay must retain its own identity even when turn/started was missed.
    expect(partial[0]?.turnId).toBe('turn-a')
    state.stopPolling()
  })

  it('does not show both an unscoped replay delta and the completed item as two identical replies', async () => {
    const { state, notify } = setup()
    delta(notify)
    await vi.advanceTimersByTimeAsync(180)
    completeItem(notify)
    const replies = state.messages.value.filter(message => message.role === 'assistant')
    // Baseline returns [{id: assistant-item, turnId: undefined},
    //                   {id: assistant-item, turnId: turn-a}], same text twice.
    expect(replies.map(({ id, turnId, text }) => ({ id, turnId, text }))).toEqual([
      { id: 'assistant-item', turnId: 'turn-a', text: 'Only one reply' },
    ])
    state.stopPolling()
  })

  it('keeps a queued delta bound to the finishing turn when turn/completed flushes it', () => {
    const { state, notify } = setup()
    notify({ method: 'turn/started', params: { threadId: 'mobile-thread', turn: { id: 'turn-a' } } })
    delta(notify)
    // No item/completed arrived before the terminal event (e.g. replay gap).
    notify({ method: 'turn/completed', params: { threadId: 'mobile-thread', turn: { id: 'turn-a', status: 'completed' } } })
    expect(state.messages.value.filter(message => message.role === 'assistant').map(({ id, turnId }) => ({ id, turnId }))).toEqual([
      { id: 'assistant-item', turnId: 'turn-a' },
    ])
    state.stopPolling()
  })

  it('does not assign a late delta for a finished turn to a newer active turn', async () => {
    const { state, notify } = setup()
    notify({ method: 'turn/started', params: { threadId: 'mobile-thread', turn: { id: 'turn-b' } } })
    delta(notify)
    await vi.advanceTimersByTimeAsync(180)
    completeItem(notify)
    expect(state.messages.value.filter(message => message.role === 'assistant').map(({ id, turnId, text }) => ({ id, turnId, text }))).toEqual([
      { id: 'assistant-item', turnId: 'turn-a', text: 'Only one reply' },
    ])
    state.stopPolling()
  })

  it('uses the active turn for old notifications without turnId', async () => {
    const { state, notify } = setup()
    notify({ method: 'turn/started', params: { threadId: 'mobile-thread', turn: { id: 'turn-a' } } })
    notify({ method: 'item/agentMessage/delta', params: { threadId: 'mobile-thread', itemId: 'assistant-item', delta: 'Only one reply' } })
    await vi.advanceTimersByTimeAsync(180)
    expect(state.messages.value.filter(message => message.role === 'assistant')).toEqual([
      expect.objectContaining({ id: 'assistant-item', turnId: 'turn-a', text: 'Only one reply' }),
    ])
    state.stopPolling()
  })

  it('keeps the same item ID in different turns separate inside a single flush window', async () => {
    const { state, notify } = setup()
    delta(notify, 'first turn')
    notify({ method: 'item/agentMessage/delta', params: { threadId: 'mobile-thread', turnId: 'turn-b', itemId: 'assistant-item', delta: 'second turn' } })
    await vi.advanceTimersByTimeAsync(180)
    expect(state.messages.value.filter(message => message.role === 'assistant').map(({ turnId, text }) => ({ turnId, text }))).toEqual([
      { turnId: 'turn-a', text: 'first turn' }, { turnId: 'turn-b', text: 'second turn' },
    ])
    state.stopPolling()
  })

  it('keeps legitimate same-text replies with different item identities', () => {
    const { state, notify } = setup()
    completeItem(notify)
    notify({ method: 'item/completed', params: { threadId: 'mobile-thread', turnId: 'turn-a', item: { id: 'another-item', type: 'agentMessage', text: 'Only one reply' } } })
    expect(state.messages.value.filter(message => message.role === 'assistant').map(message => message.id)).toEqual(['assistant-item', 'another-item'])
    state.stopPolling()
  })

  it.each([0, 180])('binds a unique old unscoped item once completed supplies its turn, after %ims', async (delay) => {
    const { state, notify } = setup()
    notify({ method: 'item/agentMessage/delta', params: { threadId: 'mobile-thread', itemId: 'assistant-item', delta: 'Only one reply' } })
    await vi.advanceTimersByTimeAsync(delay)
    completeItem(notify)
    await vi.advanceTimersByTimeAsync(180)
    expect(state.messages.value.filter(message => message.role === 'assistant').map(({ turnId, text }) => ({ turnId, text }))).toEqual([
      { turnId: 'turn-a', text: 'Only one reply' },
    ])
    state.stopPolling()
  })

  it('keeps one reply while recovery hydrates history and a fresh state restores the same single item', async () => {
    const { state, notify } = setup()
    delta(notify)
    await vi.advanceTimersByTimeAsync(180)
    completeItem(notify)
    const persisted: UiMessage = { id: 'assistant-item', role: 'assistant', text: 'Only one reply', messageType: 'agentMessage', turnId: 'turn-a' }
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(history([persisted], true))
    await state.loadMessages('mobile-thread', { force: true })
    expect(state.messages.value.filter(message => message.role === 'assistant')).toEqual([expect.objectContaining(persisted)])
    state.stopPolling()
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(history([persisted]))
    const fresh = useDesktopState()
    fresh.primeSelectedThread('mobile-thread')
    await fresh.loadMessages('mobile-thread')
    expect(fresh.messages.value.filter(message => message.role === 'assistant')).toEqual([expect.objectContaining(persisted)])
    fresh.stopPolling()
  })

  it('hands a flushed terminal tail over to authoritative history without resurrecting it on repeated completion', async () => {
    const { state, notify } = setup()
    notify({ method: 'turn/started', params: { threadId: 'mobile-thread', turn: { id: 'turn-a' } } })
    delta(notify)
    const completed = { method: 'turn/completed', params: { threadId: 'mobile-thread', turn: { id: 'turn-a', status: 'completed' } } }
    notify(completed)
    const persisted: UiMessage = { id: 'assistant-item', role: 'assistant', text: 'Only one reply', messageType: 'agentMessage', turnId: 'turn-a' }
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(history([persisted]))
    await state.loadMessages('mobile-thread', { force: true })
    notify(completed)
    await vi.advanceTimersByTimeAsync(180)
    expect(state.messages.value.filter(message => message.role === 'assistant')).toEqual([expect.objectContaining(persisted)])
    state.stopPolling()
  })

  it('does not guess an unknown item turn when persisted history already reused that item ID in another turn', async () => {
    const { state, notify } = setup()
    gatewayMocks.getThreadHistoryDetail.mockResolvedValue(history([
      { id: 'assistant-item', role: 'assistant', text: 'Earlier reply', messageType: 'agentMessage', turnId: 'older-turn' },
    ]))
    await state.loadMessages('mobile-thread')
    notify({ method: 'item/agentMessage/delta', params: { threadId: 'mobile-thread', itemId: 'assistant-item', delta: 'Unidentified reply' } })
    await vi.advanceTimersByTimeAsync(180)
    completeItem(notify)
    const replies = state.messages.value.filter(message => message.role === 'assistant')
    expect(replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 'older-turn', text: 'Earlier reply' }),
      expect.objectContaining({ turnId: undefined, text: 'Unidentified reply' }),
      expect.objectContaining({ turnId: 'turn-a', text: 'Only one reply' }),
    ]))
    state.stopPolling()
  })
})
