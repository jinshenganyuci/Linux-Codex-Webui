import type { UiServerRequest } from './types/codex'

export function isServerRequestId(value: unknown): value is UiServerRequest['id'] {
  return (typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && value.length > 0)
}

export function serverRequestIdentity(id: UiServerRequest['id'], generation: number): string {
  return `${generation}:${typeof id === 'string' ? 'string:' : ''}${id}`
}

export function isBlockingServerRequest(request: Pick<UiServerRequest, 'method' | 'params'>): boolean {
  const params = request.params !== null && typeof request.params === 'object'
    ? request.params as Record<string, unknown>
    : null
  const isUserInput = request.method === 'item/tool/requestUserInput'
    || request.method === 'request_user_input'
    || request.method === 'request_user_input_async'
  return !isUserInput || params?.isBlocking !== false
}
