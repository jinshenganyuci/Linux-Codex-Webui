import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

const sharedBridgeKey = '__codexRemoteSharedBridge__'
const globalScope = globalThis as typeof globalThis & Record<string, unknown>
let previousSharedBridge: unknown

afterEach(() => {
  if (previousSharedBridge === undefined) delete globalScope[sharedBridgeKey]
  else globalScope[sharedBridgeKey] = previousSharedBridge
})

async function readReadyPayload(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('event stream response body is unavailable')
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (!text.includes('event: ready\n')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    controller.abort()
  }
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  if (!dataLine) throw new Error(`ready payload missing from event stream: ${text}`)
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>
}

describe('active plan snapshot bridge recovery', () => {
  it('includes the latest bounded plan snapshot in SSE ready', async () => {
    let notificationListener: ((value: { method: string; params: unknown; generation?: number }) => void) | null = null
    const noOp = () => undefined
    previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v4-agent-progress',
      appServer: {
        rpc: async () => ({}),
        onNotification: (listener: typeof notificationListener) => {
          notificationListener = listener
          return noOp
        },
        dispose: noOp,
        disposeWhenIdle: async () => undefined,
      },
      terminalManager: { subscribe: () => noOp, dispose: noOp },
      methodCatalog: {},
      telegramBridge: {
        configureAllowedUserIds: noOp,
        configureToken: noOp,
        start: noOp,
        stop: noOp,
      },
      backendQueueProcessor: { dispose: noOp },
      threadRuntimeState: { dispose: async () => undefined },
    }

    const middleware = createCodexBridgeMiddleware()
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      expect(notificationListener).not.toBeNull()
      notificationListener!({
        method: 'turn/plan/updated',
        generation: 7,
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          explanation: 'Recover immediately',
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Ship', status: 'inProgress' },
          ],
        },
      })

      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      const ready = await readReadyPayload(`http://127.0.0.1:${address.port}/codex-api/events`)
      expect(ready).toMatchObject({
        ok: true,
        activePlans: [{
          threadId: 'thread-a',
          turnId: 'turn-a',
          messageId: 'turn-a:plan',
          explanation: 'Recover immediately',
          steps: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Ship', status: 'inProgress' },
          ],
          lifecycle: 'live',
          generation: 7,
        }],
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      middleware.dispose()
    }
  })
})
