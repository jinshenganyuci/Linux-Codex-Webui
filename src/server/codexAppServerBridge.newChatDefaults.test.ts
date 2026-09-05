import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

describe('new chat default API', () => {
  it('serves provider defaults and applies field patches', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-new-chat-default-api-'))
    process.env.CODEX_HOME = codexHome

    const noOp = () => undefined
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    const previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v5-native-thread-controls',
      appServer: {
        rpc: async () => ({}),
        onNotification: () => noOp,
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
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      const url = `http://127.0.0.1:${address.port}/codex-api/preferences/new-chat-defaults`

      const initial = await fetch(url)
      expect(initial.status).toBe(200)
      await expect(initial.json()).resolves.toEqual({
        data: { version: 1, revision: 0, providers: {} },
      })

      const saved = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'myproxy',
          model: 'gpt-5.6-luna',
          reasoningEffort: 'high',
        }),
      })
      expect(saved.status).toBe(200)
      await expect(saved.json()).resolves.toMatchObject({
        data: {
          revision: 1,
          providers: {
            myproxy: { model: 'gpt-5.6-luna', reasoningEffort: 'high' },
          },
        },
      })

      const invalid = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'myproxy', reasoningEffort: 'impossible' }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      middleware.dispose()
      if (previousSharedBridge === undefined) delete globalScope[sharedBridgeKey]
      else globalScope[sharedBridgeKey] = previousSharedBridge
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
