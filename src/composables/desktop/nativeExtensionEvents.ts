import type { RpcNotification } from '../../api/codexRpcClient'

const listeners = new Set<(notification: RpcNotification) => void>()
export function observeNativeExtensions(listener: (notification: RpcNotification) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function publishNativeExtensionEvent(notification: RpcNotification): void {
  for (const listener of listeners) listener(notification)
}
