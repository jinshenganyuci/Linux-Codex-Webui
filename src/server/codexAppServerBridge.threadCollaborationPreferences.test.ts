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

describe('thread collaboration preference API', () => {
  it('supports initialization, authoritative reads, updates, and deletion', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-thread-collaboration-api-'))
    process.env.CODEX_HOME = codexHome
    const noOp = () => undefined
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    const previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v6-native-extensions',
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
      const baseUrl = `http://127.0.0.1:${address.port}/codex-api/preferences/thread-collaboration`

      const initial = await fetch(baseUrl)
      await expect(initial.json()).resolves.toMatchObject({ data: { persisted: false, modes: {} } })

      const migration = await fetch(baseUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initializeOnly: true, modes: { 'thread-a': 'plan' } }),
      })
      expect(migration.status).toBe(200)
      await expect(migration.json()).resolves.toMatchObject({
        applied: true,
        data: { persisted: true, modes: { 'thread-a': 'plan' } },
      })

      const secondMigration = await fetch(baseUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initializeOnly: true, modes: { 'thread-b': 'plan' } }),
      })
      await expect(secondMigration.json()).resolves.toMatchObject({
        applied: false,
        data: { modes: { 'thread-a': 'plan' } },
      })

      const deletion = await fetch(`${baseUrl}?threadId=thread-a`, { method: 'DELETE' })
      expect(deletion.status).toBe(200)
      const afterDelete = await fetch(baseUrl)
      await expect(afterDelete.json()).resolves.toMatchObject({ data: { modes: {} } })

      const invalid = await fetch(baseUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modes: { 'thread-a': 'sometimes' } }),
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
