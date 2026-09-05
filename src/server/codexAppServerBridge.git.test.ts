import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

const execFileAsync = promisify(execFile)

async function createGitRepositoryWithAmbiguousDevRef(root: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(repo)
  await execFileAsync('git', ['init'], { cwd: repo })
  await writeFile(join(repo, 'dev'), 'same name as the branch\n', 'utf8')
  await execFileAsync('git', ['add', 'dev'], { cwd: repo })
  await execFileAsync('git', [
    '-c', 'user.name=Codex Test',
    '-c', 'user.email=codex-test@example.invalid',
    'commit', '-m', 'ambiguous dev fixture',
  ], { cwd: repo })
  await execFileAsync('git', ['branch', '-M', 'dev'], { cwd: repo })
  return repo
}

async function withBridgeServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
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
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    middleware.dispose()
    if (previousSharedBridge === undefined) delete globalScope[sharedBridgeKey]
    else globalScope[sharedBridgeKey] = previousSharedBridge
  }
}

describe('Git branch commit endpoint', () => {
  it('loads a branch even when the working tree contains a path with the same name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-git-branch-commits-'))
    try {
      const repo = await createGitRepositoryWithAmbiguousDevRef(root)
      const nonGitDirectory = join(root, 'not-a-repository')
      await mkdir(nonGitDirectory)

      await withBridgeServer(async (baseUrl) => {
        const request = async (cwd: string, branch: string) => {
          const query = new URLSearchParams({ cwd, branch })
          return fetch(`${baseUrl}/codex-api/git/branch-commits?${query.toString()}`)
        }

        const validResponse = await request(repo, 'dev')
        const validPayload = await validResponse.json() as {
          data: Array<{ subject: string; sha: string }>
        }
        expect(validResponse.status).toBe(200)
        expect(validPayload.data[0]).toMatchObject({ subject: 'ambiguous dev fixture' })
        expect(validPayload.data[0]?.sha).toMatch(/^[0-9a-f]{40}$/)

        const missingRefResponse = await request(repo, 'missing-branch')
        expect(missingRefResponse.status).toBe(404)

        const nonGitResponse = await request(nonGitDirectory, 'dev')
        expect(nonGitResponse.status).toBe(422)

        const missingCwdResponse = await request(join(root, 'missing'), 'dev')
        expect(missingCwdResponse.status).toBe(404)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
