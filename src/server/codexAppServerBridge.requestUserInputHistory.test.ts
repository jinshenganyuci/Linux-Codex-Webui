import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppServerJsonlTransportLike } from './appServerJsonlTransport'
import { AppServerProcess, createCodexBridgeMiddleware } from './codexAppServerBridge'
import { readRequestUserInputHistory } from './requestUserInputHistory'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

describe('request user input history API', () => {
  it('persists an answered App Server request before broadcasting its resolved event', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-request-user-input-resolution-'))
    process.env.CODEX_HOME = codexHome
    const writeJson = vi.fn()
    const transport: AppServerJsonlTransportLike = {
      running: true,
      activeGeneration: 1,
      start: () => 1,
      writeJson,
      stop: () => 1,
    }
    const appServer = new AppServerProcess(null, undefined, () => transport)
    const notifications: Array<{ method: string; params: unknown }> = []
    appServer.onNotification((notification) => notifications.push(notification))
    ;(appServer as unknown as { initialized: boolean }).initialized = true
    ;(appServer as unknown as {
      handleServerRequest: (generation: number, id: number, method: string, params: unknown) => void
    }).handleServerRequest(1, 4, 'request_user_input', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      questions: [{ id: 'scope', header: 'Scope', question: 'What first?' }],
    })

    try {
      await appServer.respondToServerRequest({
        id: 4,
        generation: 1,
        result: { answers: { scope: { answers: ['MVP'] } } },
      })

      await expect(readRequestUserInputHistory('thread-a')).resolves.toMatchObject({
        'thread-a': [{
          id: 'request-user-input:1:4',
          status: 'answered',
          questions: [{ answers: ['MVP'] }],
        }],
      })
      expect(notifications.at(-1)).toMatchObject({
        method: 'server/request/resolved',
        params: { id: 4, generation: 1 },
      })
      expect(writeJson).toHaveBeenCalledWith(expect.objectContaining({
        id: 4,
        result: { answers: { scope: { answers: ['MVP'] } } },
      }), 1)
    } finally {
      appServer.dispose()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('writes, reads, and deletes one thread summary', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-request-user-input-api-'))
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
      const baseUrl = `http://127.0.0.1:${address.port}/codex-api/request-user-input-history`
      const summary = {
        id: 'request-user-input:1:4',
        threadId: 'thread-a',
        turnId: 'turn-a',
        itemId: 'item-a',
        requestId: 4,
        generation: 1,
        status: 'answered',
        questions: [{ id: 'scope', header: 'Scope', question: 'What first?', answers: ['MVP'], isSecret: false }],
        requestedAtIso: '2026-08-25T10:00:00.000Z',
        resolvedAtIso: '2026-08-25T10:00:10.000Z',
      }

      const postResponse = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary),
      })
      expect(postResponse.status).toBe(200)

      const getResponse = await fetch(`${baseUrl}?threadId=thread-a`)
      expect(getResponse.status).toBe(200)
      await expect(getResponse.json()).resolves.toEqual({ data: { 'thread-a': [summary] } })

      const deleteResponse = await fetch(`${baseUrl}?threadId=thread-a`, { method: 'DELETE' })
      expect(deleteResponse.status).toBe(200)
      const afterDeleteResponse = await fetch(`${baseUrl}?threadId=thread-a`)
      await expect(afterDeleteResponse.json()).resolves.toEqual({ data: {} })

      const missingThreadResponse = await fetch(baseUrl)
      expect(missingThreadResponse.status).toBe(400)
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
