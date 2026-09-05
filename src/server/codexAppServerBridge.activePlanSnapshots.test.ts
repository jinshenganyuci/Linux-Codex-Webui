import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      version: 'experimental-api-v6-native-extensions',
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
      notificationListener!({ method: 'thread/realtime/sdp', params: { threadId: 'voice', sdp: 'PRIVATE_SDP' } })
      notificationListener!({ method: 'thread/realtime/outputAudio/delta', params: { threadId: 'voice', audio: { data: 'PRIVATE_AUDIO' } } })
      const replayed: unknown[] = []
      const stopReplay = middleware.subscribeNotifications(value => replayed.push(value), { streamId: middleware.getNotificationStreamState().streamId, sequence: 0 })
      stopReplay()
      expect(JSON.stringify(replayed)).not.toContain('PRIVATE_')
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

  it('persists a terminal snapshot and exposes it through the summary history API', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-plan-summary-bridge-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    let notificationListener: ((value: { method: string; params: unknown; generation?: number }) => void) | null = null
    const noOp = () => undefined
    previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v6-native-extensions',
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
      notificationListener!({
        method: 'turn/plan/updated',
        generation: 7,
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          explanation: 'Persist at completion',
          plan: [{ step: 'Ship', status: 'completed' }],
        },
      })
      notificationListener!({
        method: 'turn/completed',
        generation: 7,
        params: {
          threadId: 'thread-a',
          turn: { id: 'turn-a', status: 'completed' },
        },
      })

      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/plan-summary-history?threadId=thread-a`)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        data: {
          'thread-a': [{
            id: 'plan-summary:turn-a',
            turnId: 'turn-a',
            lifecycle: 'completed',
            explanation: 'Persist at completion',
            steps: [{ step: 'Ship', status: 'completed' }],
          }],
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      middleware.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
