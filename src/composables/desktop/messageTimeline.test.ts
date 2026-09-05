import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import { assignTimelineOrder, orderedTimeline, reconcileTimeline } from './messageTimeline'

const user = (id: string, turnId = 'turn', text = '继续'): UiMessage => ({ id, turnId, text, role: 'user', messageType: 'userMessage' })

describe('message timeline reconciliation', () => {
  it('promotes snapshot aliases once and preserves canonical identity against stale responses', () => {
    const prior = { ...user('item-1'), timelineOrder: 4 }
    const result = reconcileTimeline([prior], [user('uuid')])
    expect(result).toEqual([{ ...user('uuid'), timelineOrder: 4, renderKey: 'turn\u0000item-1' }])
    expect(reconcileTimeline(result, [user('item-1')])).toEqual(result)
  })

  it('matches repeated snapshot text one-to-one without deleting actual repeated submissions', () => {
    expect(reconcileTimeline([user('item-1'), user('item-3')], [user('first'), user('second')])).toHaveLength(2)
    expect(reconcileTimeline([user('first')], [user('second')])).toHaveLength(2)
    expect(reconcileTimeline([user('item-1')], [user('uuid', 'other')])).toHaveLength(2)
  })

  it('does not consume an optimistic repeat with an already known historical message', () => {
    const optimistic = { ...user('pending'), messageType: 'userMessage.optimistic' }
    expect(reconcileTimeline([user('first'), optimistic], [user('first')])).toHaveLength(2)
    const result = reconcileTimeline([user('first'), optimistic], [user('first'), user('second')])
    expect(result.map(message => message.id)).toEqual(['first', 'second'])
  })

  it('keeps different attachments and legitimate duplicate canonical ids distinct', () => {
    const screenshot = { ...user('item-1'), images: ['/image-one'] }
    expect(reconcileTimeline([screenshot], [{ ...user('uuid'), images: ['/image-two'] }])).toHaveLength(2)
  })

  it('preserves live order when an optimistic steer follows old live output', () => {
    const oldReply: UiMessage = { id: 'reply', turnId: 'turn', text: 'old', role: 'assistant', timelineOrder: 2 }
    const pending = { ...user('pending'), messageType: 'userMessage.optimistic', timelineOrder: 3 }
    expect(orderedTimeline([{ ...user('initial'), timelineOrder: 1 }, pending], [oldReply]).map(message => message.id)).toEqual(['initial', 'reply', 'pending'])
  })

  it('places newly loaded history before known anchors without changing their order', () => {
    let order = 10
    const merged = reconcileTimeline([{ ...user('last'), timelineOrder: 3 }], [user('older', 'older-turn'), user('last')])
    expect(assignTimelineOrder(merged, () => ++order).map(message => message.timelineOrder)).toEqual([2, 3])
  })
})
