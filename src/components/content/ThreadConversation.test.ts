import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiFileChange, UiMessage } from '../../types/codex'

let component: Component
let viteServer: ViteDevServer
let createThreadCommandOutputCache: (
  loadFullOutput: (threadId: string, turnId: string, itemId: string) => Promise<string>,
) => {
  clear: () => void
  getStatus: (message: UiMessage) => 'idle' | 'loading' | 'loaded' | 'failed'
  load: (threadId: string, message: UiMessage) => Promise<void>
  readOutput: (message: UiMessage) => string
}

beforeAll(async () => {
  viteServer = await createServer({
    configFile: false,
    appType: 'custom',
    plugins: [vue()],
    server: { middlewareMode: true, hmr: false },
  })
  const componentModule = await viteServer.ssrLoadModule(
    '/src/components/content/ThreadConversation.vue',
  ) as {
    default: Component
    createThreadCommandOutputCache: typeof createThreadCommandOutputCache
  }
  component = componentModule.default
  createThreadCommandOutputCache = componentModule.createThreadCommandOutputCache
})

afterAll(async () => {
  await viteServer?.close()
})

async function renderConversation(messages: UiMessage[]): Promise<string> {
  return await renderToString(createSSRApp({
    render: () => h(component, {
      messages,
      pendingRequests: [],
      liveOverlay: null,
      isLoading: false,
      activeThreadId: 'thread-under-test',
      cwd: '/workspace/project',
    }),
  }))
}

function commandMessage(
  turnId: string,
  command: string,
  id = 'duplicate-command-item',
  status: 'inProgress' | 'completed' = 'inProgress',
): UiMessage {
  return {
    id,
    role: 'system',
    text: '',
    turnId,
    messageType: 'commandExecution',
    commandExecution: {
      command,
      cwd: null,
      aggregatedOutput: `${command} output`,
      status,
      exitCode: status === 'completed' ? 0 : null,
    },
  }
}

function truncatedCommandMessage(turnId: string, id: string, tail: string): UiMessage {
  const message = commandMessage(turnId, `run ${id}`, id, 'completed')
  if (!message.commandExecution) throw new Error('Expected command execution fixture')
  message.commandExecution.aggregatedOutput = tail
  message.commandExecution.aggregatedOutputTruncated = true
  message.commandExecution.aggregatedOutputOriginalBytes = tail.length + 10_000
  return message
}

function fileChange(path: string): UiFileChange {
  return {
    path,
    operation: 'update',
    movedToPath: null,
    diff: `+${path}`,
    addedLineCount: 1,
    removedLineCount: 0,
  }
}

function countClass(html: string, className: string): number {
  return html.match(new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'gu'))?.length ?? 0
}

describe('ThreadConversation turn-scoped message identity', () => {
  it('does not link auto-expanded command state or ARIA output ids across turns with the same item id', async () => {
    const html = await renderConversation([
      commandMessage('turn-a', 'echo a'),
      commandMessage('turn-b', 'echo b'),
    ])

    expect(countClass(html, 'cmd-row-group')).toBe(0)
    expect(html.match(/aria-expanded="(true|false)"/gu)).toEqual([
      'aria-expanded="false"',
      'aria-expanded="true"',
    ])
    expect(html).not.toContain('echo a output')
    expect(html).toContain('echo b output')

    const outputIds = Array.from(html.matchAll(/id="(command-output-[^"]+)"/gu), (match) => match[1])
    expect(outputIds).toHaveLength(2)
    expect(new Set(outputIds).size).toBe(2)
  })

  it('does not expose an empty response as copyable because another turn reused its item id', async () => {
    const html = await renderConversation([
      { id: 'duplicate-agent-item', role: 'assistant', text: 'copy only this', turnId: 'turn-a' },
      { id: 'duplicate-agent-item', role: 'assistant', text: '', turnId: 'turn-b' },
    ])

    expect(countClass(html, 'message-copy-button')).toBe(1)
  })

  it('builds independent command groups when separate turns reuse every command item id', async () => {
    const html = await renderConversation([
      commandMessage('turn-a', 'echo a1', 'duplicate-command-1', 'completed'),
      commandMessage('turn-a', 'echo a2', 'duplicate-command-2', 'completed'),
      commandMessage('turn-b', 'echo b1', 'duplicate-command-1', 'completed'),
      commandMessage('turn-b', 'echo b2', 'duplicate-command-2', 'completed'),
    ])

    expect(countClass(html, 'cmd-row-group')).toBe(2)
    const outputIds = Array.from(html.matchAll(/id="(command-output-[^"]+)"/gu), (match) => match[1])
    expect(outputIds).toHaveLength(4)
    expect(new Set(outputIds).size).toBe(4)
  })

  it('keeps anchored and standalone file-change summaries visible when their item ids repeat across turns', async () => {
    const html = await renderConversation([
      { id: 'assistant-item', role: 'assistant', text: 'done', turnId: 'turn-a' },
      {
        id: 'duplicate-file-change-item',
        role: 'system',
        text: '',
        turnId: 'turn-a',
        messageType: 'fileChange',
        fileChangeStatus: 'completed',
        fileChanges: [fileChange('src/a.ts')],
      },
      {
        id: 'duplicate-file-change-item',
        role: 'system',
        text: '',
        turnId: 'turn-b',
        messageType: 'fileChange',
        fileChangeStatus: 'completed',
        fileChanges: [fileChange('src/b.ts')],
      },
    ])

    expect(countClass(html, 'file-change-summary-row')).toBe(2)
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
  })
})

describe('ThreadConversation truncated command-output cache', () => {
  it('loads a truncated command once and retains the full output after repeated expansion requests', async () => {
    let requestCount = 0
    const cache = createThreadCommandOutputCache(async () => {
      requestCount += 1
      return 'complete output'
    })
    const message = truncatedCommandMessage('turn-a', 'command-a', 'latest tail')

    expect(cache.readOutput(message)).toBe('latest tail')
    await Promise.all([
      cache.load('thread-a', message),
      cache.load('thread-a', message),
    ])
    await cache.load('thread-a', message)

    expect(requestCount).toBe(1)
    expect(cache.getStatus(message)).toBe('loaded')
    expect(cache.readOutput(message)).toBe('complete output')
  })

  it('keeps the truncated tail after a failed load and does not retry automatically', async () => {
    let requestCount = 0
    const cache = createThreadCommandOutputCache(async () => {
      requestCount += 1
      throw new Error('not available')
    })
    const message = truncatedCommandMessage('turn-a', 'command-a', 'latest tail')

    await cache.load('thread-a', message)
    await cache.load('thread-a', message)

    expect(requestCount).toBe(1)
    expect(cache.getStatus(message)).toBe('failed')
    expect(cache.readOutput(message)).toBe('latest tail')
  })

  it('isolates full outputs for duplicate item ids in separate turns', async () => {
    const cache = createThreadCommandOutputCache(async (_threadId, turnId) => `full output for ${turnId}`)
    const first = truncatedCommandMessage('turn-a', 'duplicate-command', 'tail a')
    const second = truncatedCommandMessage('turn-b', 'duplicate-command', 'tail b')

    await Promise.all([
      cache.load('thread-a', first),
      cache.load('thread-a', second),
    ])

    expect(cache.readOutput(first)).toBe('full output for turn-a')
    expect(cache.readOutput(second)).toBe('full output for turn-b')
  })

  it('clears loaded output when the active thread changes', async () => {
    const cache = createThreadCommandOutputCache(async () => 'complete output')
    const message = truncatedCommandMessage('turn-a', 'command-a', 'latest tail')

    await cache.load('thread-a', message)
    cache.clear()

    expect(cache.getStatus(message)).toBe('idle')
    expect(cache.readOutput(message)).toBe('latest tail')
  })

  it('retains only the eight most recently loaded full outputs', async () => {
    const cache = createThreadCommandOutputCache(async (_threadId, turnId) => `full ${turnId}`)
    const messages = Array.from({ length: 9 }, (_value, index) => (
      truncatedCommandMessage(`turn-${String(index + 1)}`, `command-${String(index + 1)}`, `tail ${String(index + 1)}`)
    ))

    for (const message of messages) {
      await cache.load('thread-a', message)
    }

    expect(cache.getStatus(messages[0])).toBe('idle')
    expect(cache.readOutput(messages[0])).toBe('tail 1')
    for (let index = 1; index < messages.length; index += 1) {
      expect(cache.getStatus(messages[index])).toBe('loaded')
      expect(cache.readOutput(messages[index])).toBe(`full turn-${String(index + 1)}`)
    }
  })
})
