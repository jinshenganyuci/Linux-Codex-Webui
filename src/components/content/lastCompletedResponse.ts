import type { UiMessage } from '../../types/codex'

type ResponseCandidate = Pick<UiMessage, 'role' | 'text' | 'messageType' | 'phase'>

export function lastCompletedResponseText(messages: readonly ResponseCandidate[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !message.text.trim() || message.messageType?.endsWith('.live') || message.phase === 'commentary') continue
    return message.text
  }
  return null
}
