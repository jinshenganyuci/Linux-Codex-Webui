import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { readThreadModelPreferences } from './threadModelPreferences'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

describe('generic turn/start model preference persistence', () => {
  it('persists the explicit model and reasoning effort only after the turn is accepted', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-turn-model-preference-'))
    process.env.CODEX_HOME = codexHome

    const noOp = () => undefined
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    const previousSharedBridge = globalScope[sharedBridgeKey]
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') return { turn: { id: 'turn-sol-max' } }
      return {}
    })
    globalScope[sharedBridgeKey] = {
      version: 'experimental-api-v6-native-extensions',
      appServer: {
        rpc,
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

      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'turn/start',
          params: {
            threadId: 'thread-sol-max',
            input: [{ type: 'text', text: 'verify preference persistence' }],
            model: 'gpt-5.6-sol',
            effort: 'max',
          },
        }),
      })

      expect(response.status).toBe(200)
      expect(await readThreadModelPreferences()).toEqual({
        'thread-sol-max': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
      })
      const preferenceUrl = `http://127.0.0.1:${address.port}/codex-api/thread-model-preferences`
      const patch = await fetch(preferenceUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'thread-sol-max', model: 'stale-model', reasoningEffort: 'low', speedMode: 'fast' }) })
      expect(patch.status).toBe(200)
      expect((await patch.json()).data).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'max', speedMode: 'fast' })
      await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'turn/start', params: { threadId: 'thread-sol-max', model: 'gpt-5.6-sol', effort: 'max', serviceTier: null, input: [] } }) })
      // A queued turn may carry an older speed snapshot; it must not reset the preference.
      expect((await readThreadModelPreferences())['thread-sol-max'].speedMode).toBe('fast')
      await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'turn/start', params: { threadId: 'new-fast', model: 'gpt-6-astra', effort: 'low', serviceTier: 'priority', input: [] } }) })
      expect((await readThreadModelPreferences())['new-fast'].speedMode).toBe('fast')
      expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        threadId: 'thread-sol-max',
        model: 'gpt-5.6-sol',
        effort: 'max',
      }))
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
