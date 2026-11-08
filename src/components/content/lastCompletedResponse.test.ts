import { describe, expect, it } from 'vitest'
import { lastCompletedResponseText } from './lastCompletedResponse'

describe('lastCompletedResponseText', () => {
  it('copies the latest completed assistant answer rather than a live overlay', () => {
    expect(lastCompletedResponseText([
      { role: 'assistant', text: 'Earlier answer', messageType: 'agentMessage' },
      { role: 'user', text: 'Follow up', messageType: 'userMessage' },
      { role: 'assistant', text: 'Working on it', messageType: 'agentMessage', phase: 'commentary' },
      { role: 'assistant', text: 'Partial answer', messageType: 'agentMessage.live' },
    ])).toBe('Earlier answer')
  })

  it('ignores blank and non-assistant rows', () => {
    expect(lastCompletedResponseText([
      { role: 'assistant', text: '   ', messageType: 'agentMessage' },
      { role: 'system', text: 'Tool output', messageType: 'toolOutput' },
    ])).toBeNull()
  })
})
