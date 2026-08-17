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

describe('sidebar preference API', () => {
  it('serves defaults and merges section and project patches', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-sidebar-preference-api-'))
    process.env.CODEX_HOME = codexHome

    const noOp = () => undefined
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    const previousSharedBridge = globalScope[sharedBridgeKey]
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v4-agent-progress',
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
      const baseUrl = `http://127.0.0.1:${address.port}/codex-api/preferences/sidebar-layout`

      const initialResponse = await fetch(baseUrl)
      expect(initialResponse.status).toBe(200)
      await expect(initialResponse.json()).resolves.toMatchObject({
        data: {
          revision: 0,
          persisted: false,
          sections: { pinned: true, chats: true, projects: true },
          collapsedProjects: {},
        },
      })

      const patchResponse = await fetch(baseUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sections: { projects: false },
          collapsedProjects: { '/repo/a': true },
        }),
      })
      expect(patchResponse.status).toBe(200)
      await expect(patchResponse.json()).resolves.toMatchObject({
        applied: true,
        data: {
          revision: 1,
          persisted: true,
          sections: { pinned: true, chats: true, projects: false },
          collapsedProjects: { '/repo/a': true },
        },
      })

      const invalidResponse = await fetch(baseUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections: { chats: 'sometimes' } }),
      })
      expect(invalidResponse.status).toBe(400)
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
