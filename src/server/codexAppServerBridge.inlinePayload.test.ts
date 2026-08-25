import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendQueueProcessor,
  mergeSessionSkillInputsIntoHistoryResult,
  mergeSessionSkillInputsIntoTurns,
  parseAutomationToml,
  reconcileThreadQueueStateWrite,
  sanitizeThreadTurnsInlinePayloads,
  toAutomationApiRecord,
} from './codexAppServerBridge'
import { writeThreadModelPreference } from './threadModelPreferences'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const pngDataUrl = `data:image/png;base64,${pngBase64}`
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const webpBase64 = 'UklGRiIAAABXRUJQVlA4IC4AAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA='

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function localImagePathFromProxyUrl(value: string): string {
  const parsed = new URL(value, 'http://localhost')
  expect(parsed.pathname).toBe('/codex-local-image')
  const imagePath = parsed.searchParams.get('path')
  expect(imagePath).toBeTruthy()
  return imagePath ?? ''
}

describe('thread inline media sanitization', () => {
  it('externalizes inline image data from common thread payload fields', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'image', url: pngDataUrl }],
                images: [pngDataUrl],
              },
              {
                id: 'generated-1',
                type: 'imageGeneration',
                result: pngBase64,
                b64_json: pngBase64,
                image: pngBase64,
                url: 'https://example.com/generated.png',
              },
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<Record<string, unknown>>
        }>
      }
    }

    const [userMessage, generatedImage, toolOutput] = result.thread.turns[0].items
    const content = userMessage.content as Array<Record<string, unknown>>
    const images = userMessage.images as string[]

    expect(content[0].url).toMatch(/^\/codex-local-image\?path=/)
    expect(images[0]).toMatch(/^\/codex-local-image\?path=/)
    expect(generatedImage.type).toBe('imageView')
    expect(generatedImage.path).toEqual(expect.any(String))
    expect(generatedImage).not.toHaveProperty('result')
    expect(generatedImage).not.toHaveProperty('b64_json')
    expect(generatedImage).not.toHaveProperty('image')
    expect(generatedImage.url).toBe('https://example.com/generated.png')
    expect(toolOutput.result).toMatch(/^\/codex-local-image\?path=/)

    expect(existsSync(localImagePathFromProxyUrl(content[0].url as string))).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(images[0]))).toBe(true)
    expect(existsSync(generatedImage.path as string)).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(toolOutput.result as string))).toBe(true)
  })

  it('leaves non-image result strings untouched', async () => {
    const textResult = 'a'.repeat(128)
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: textResult,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(textResult)
  })

  it('uses a later valid imageGeneration field when result is non-image text', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [{
          id: 'turn-fallback-image',
          items: [{
            id: 'generated-fallback',
            type: 'imageGeneration',
            result: 'https://example.com/not-inline.png',
            b64_json: pngBase64,
            image: 'non-image-placeholder',
          }],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    const generated = result.thread.turns[0]!.items[0]!
    expect(generated.type).toBe('imageView')
    expect(generated.path).toEqual(expect.any(String))
    expect(generated).not.toHaveProperty('result')
    expect(generated).not.toHaveProperty('b64_json')
    expect(generated).not.toHaveProperty('image')
    expect(existsSync(generated.path as string)).toBe(true)
  })

  it('leaves non-image data URLs untouched in image-like fields', async () => {
    const dataUrl = 'data:text/plain;base64,aGVsbG8='
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: dataUrl,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(dataUrl)
  })

  it('externalizes supported bare base64 image signatures with matching extensions', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                images: [jpegBase64, webpBase64, gifBase64],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ images: string[] }>
        }>
      }
    }

    const images = result.thread.turns[0].items[0].images
    expect(images).toHaveLength(3)
    expect(images.every((image) => image.startsWith('/codex-local-image?path='))).toBe(true)

    const [jpegPath, webpPath, gifPath] = images.map(localImagePathFromProxyUrl)
    expect(jpegPath.endsWith('.jpg')).toBe(true)
    expect(webpPath.endsWith('.webp')).toBe(true)
    expect(gifPath.endsWith('.gif')).toBe(true)
    expect(existsSync(jpegPath)).toBe(true)
    expect(existsSync(webpPath)).toBe(true)
    expect(existsSync(gifPath)).toBe(true)
  })

  it('externalizes nested replacement history image URLs', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'message-1',
                type: 'message',
                replacement_history: [
                  {
                    content: [
                      {
                        type: 'image',
                        image_url: pngDataUrl,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{
            replacement_history: Array<{
              content: Array<{ image_url: string }>
            }>
          }>
        }>
      }
    }

    const imageUrl = result.thread.turns[0].items[0].replacement_history[0].content[0].image_url
    expect(imageUrl).toMatch(/^\/codex-local-image\?path=/)
    expect(existsSync(localImagePathFromProxyUrl(imageUrl))).toBe(true)
  })

  it('externalizes inline media in thread/turns/list data while preserving the page envelope', async () => {
    const source = {
      data: [
        {
          id: 'native-turn-1',
          items: [
            {
              id: 'native-user-1',
              type: 'userMessage',
              content: [{ type: 'image', url: pngDataUrl }],
            },
          ],
        },
        {
          id: 'native-turn-2',
          items: [{ id: 'native-message-2', type: 'agentMessage', text: 'same reference' }],
        },
      ],
      nextCursor: 'older-turn-cursor',
      backwardsCursor: 'newer-turn-cursor',
      metadata: { untouched: true },
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/turns/list', source) as {
      data: Array<{ items: Array<Record<string, unknown>> }>
      nextCursor: string
      backwardsCursor: string
      metadata: { untouched: boolean }
    }

    const content = result.data[0]!.items[0]!.content as Array<{ url: string }>
    expect(result.data).toHaveLength(2)
    expect(result.nextCursor).toBe('older-turn-cursor')
    expect(result.backwardsCursor).toBe('newer-turn-cursor')
    expect(result.metadata).toBe(source.metadata)
    expect(result.data[1]).toBe(source.data[1])
    expect(content[0]!.url).toMatch(/^\/codex-local-image\?path=/)
    expect(existsSync(localImagePathFromProxyUrl(content[0]!.url))).toBe(true)
    const originalContent = (source.data[0]!.items[0] as { content: Array<{ url: string }> }).content
    expect(originalContent[0]!.url).toBe(pngDataUrl)
  })

  it('externalizes inline files in thread/items/list entries without changing cursors or entry count', async () => {
    const source = {
      data: [
        {
          turnId: 'native-turn-1',
          item: {
            id: 'native-file-1',
            type: 'input_file',
            mime_type: 'image/png',
            file_data: pngBase64,
          },
          entryMetadata: 'preserved',
        },
        {
          turnId: 'native-turn-1',
          item: { id: 'native-message-1', type: 'agentMessage', text: 'unchanged' },
        },
      ],
      nextCursor: 'next-item-cursor',
      backwardsCursor: 'backwards-item-cursor',
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/items/list', source) as {
      data: Array<{ turnId: string; item: Record<string, unknown>; entryMetadata?: string }>
      nextCursor: string
      backwardsCursor: string
    }

    expect(result.data).toHaveLength(2)
    expect(result.nextCursor).toBe('next-item-cursor')
    expect(result.backwardsCursor).toBe('backwards-item-cursor')
    expect(result.data[0]!.turnId).toBe('native-turn-1')
    expect(result.data[0]!.entryMetadata).toBe('preserved')
    expect(result.data[0]!.item.type).toBe('text')
    expect(result.data[0]!.item.text).toMatch(/^File attachment: \/tmp\/codex-web-inline-media\//)
    expect(result.data[1]).toBe(source.data[1])
    expect(source.data[0]!.item.type).toBe('input_file')
  })

  it('externalizes inline media in thread/resume initialTurnsPage and keeps its cursors', async () => {
    const source = {
      thread: {
        id: 'resume-thread',
        turns: [{ id: 'legacy-turn', items: [{ id: 'legacy-message', type: 'agentMessage', text: 'legacy' }] }],
      },
      initialTurnsPage: {
        data: [
          {
            id: 'initial-turn',
            items: [{
              id: 'initial-generated',
              type: 'imageGeneration',
              result: pngBase64,
              b64_json: pngBase64,
              image: pngBase64,
              url: 'https://example.com/paginated-generated.png',
            }],
          },
        ],
        nextCursor: 'initial-older-cursor',
        backwardsCursor: 'initial-newer-cursor',
      },
      turnsBackwardsCursor: 'head-cursor',
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/resume', source) as {
      thread: { turns: unknown[] }
      initialTurnsPage: {
        data: Array<{ items: Array<Record<string, unknown>> }>
        nextCursor: string
        backwardsCursor: string
      }
      turnsBackwardsCursor: string
    }

    const generated = result.initialTurnsPage.data[0]!.items[0]!
    expect(result.thread).toBe(source.thread)
    expect(result.initialTurnsPage.nextCursor).toBe('initial-older-cursor')
    expect(result.initialTurnsPage.backwardsCursor).toBe('initial-newer-cursor')
    expect(result.turnsBackwardsCursor).toBe('head-cursor')
    expect(generated.type).toBe('imageView')
    expect(generated.path).toEqual(expect.any(String))
    expect(generated).not.toHaveProperty('result')
    expect(generated).not.toHaveProperty('b64_json')
    expect(generated).not.toHaveProperty('image')
    expect(generated.url).toBe('https://example.com/paginated-generated.png')
    expect(existsSync(generated.path as string)).toBe(true)
    expect(source.initialTurnsPage.data[0]!.items[0]!.type).toBe('imageGeneration')
  })

  it('does not sanitize inline images for methods without thread turns', async () => {
    const payload = {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/list', payload)

    expect(result).toBe(payload)
  })

})

describe('thread session skill recovery', () => {
  it('adds selected skill inputs from session JSONL to matching user messages', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'use a skill', text_elements: [] }],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'use a skill' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n---\n# Browser\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([
      { type: 'text', text: 'use a skill', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })

  it('does not duplicate skill inputs that are already present', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [
          { type: 'text', text: 'use a skill', text_elements: [] },
          { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
        ],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    expect(mergeSessionSkillInputsIntoTurns(turns, sessionLog)).toBe(turns)
  })

  it('adds selected skill inputs to the last user message in a multi-message turn', () => {
    const turns = [{
      id: 'turn-1',
      items: [
        {
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'first message', text_elements: [] }],
        },
        {
          id: 'item-2',
          type: 'agentMessage',
          content: [{ type: 'text', text: 'assistant reply', text_elements: [] }],
        },
        {
          id: 'item-3',
          type: 'userMessage',
          content: [{ type: 'text', text: 'second message', text_elements: [] }],
        },
      ],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([{ type: 'text', text: 'first message', text_elements: [] }])
    expect(merged[0].items[2].content).toEqual([
      { type: 'text', text: 'second message', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })

  it('recovers skills in thread/turns/list and both thread/resume turn containers', () => {
    const userTurn = (id: string) => ({
      id,
      items: [{
        id: `message-${id}`,
        type: 'userMessage',
        content: [{ type: 'text', text: id, text_elements: [] }],
      }],
    })
    const sessionLog = ['turn-list', 'turn-legacy', 'turn-initial'].flatMap((turnId) => [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `<skill>\n<name>skill-${turnId}</name>\n<path>/skills/${turnId}/SKILL.md</path>\n</skill>`,
          }],
        },
      }),
    ]).join('\n')

    const turnsList = mergeSessionSkillInputsIntoHistoryResult('thread/turns/list', {
      data: [userTurn('turn-list')],
      nextCursor: null,
    }, sessionLog) as { data: Array<{ items: Array<{ content: unknown[] }> }> }
    expect(turnsList.data[0]?.items[0]?.content).toContainEqual({
      type: 'skill',
      name: 'skill-turn-list',
      path: '/skills/turn-list/SKILL.md',
    })

    const resume = mergeSessionSkillInputsIntoHistoryResult('thread/resume', {
      thread: { id: 'thread-1', turns: [userTurn('turn-legacy')] },
      initialTurnsPage: { data: [userTurn('turn-initial')], nextCursor: null },
    }, sessionLog) as {
      thread: { turns: Array<{ items: Array<{ content: unknown[] }> }> }
      initialTurnsPage: { data: Array<{ items: Array<{ content: unknown[] }> }> }
    }
    expect(resume.thread.turns[0]?.items[0]?.content).toContainEqual({
      type: 'skill',
      name: 'skill-turn-legacy',
      path: '/skills/turn-legacy/SKILL.md',
    })
    expect(resume.initialTurnsPage.data[0]?.items[0]?.content).toContainEqual({
      type: 'skill',
      name: 'skill-turn-initial',
      path: '/skills/turn-initial/SKILL.md',
    })

    const itemPage = { data: [{ turnId: 'turn-list', item: userTurn('turn-list').items[0] }] }
    expect(mergeSessionSkillInputsIntoHistoryResult('thread/items/list', itemPage, sessionLog)).toBe(itemPage)
  })
})

describe('backend queue scheduling', () => {
  const queueMessage = (id: string, text: string) => ({
    id,
    text,
    imageUrls: ['https://example.com/queued.png'],
    skills: [{ name: 'queue-skill', path: '/skills/queue-skill/SKILL.md' }],
    fileAttachments: [{ label: 'notes.txt', path: '/tmp/notes.txt', fsPath: '/tmp/notes.txt' }],
    collaborationMode: 'default' as const,
    speedMode: 'fast' as const,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh' as const,
  })

  async function writeQueueState(codexHome: string, messages: unknown[]): Promise<void> {
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'thread-queue-state': { 'thread-1': messages },
    }), 'utf8')
  }

  async function readQueueState(codexHome: string): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')
    const state = JSON.parse(raw) as { 'thread-queue-state'?: { 'thread-1'?: Array<Record<string, unknown>> } }
    return state['thread-queue-state']?.['thread-1'] ?? []
  }

  it('keeps server-owned claims first and rejects stale claimed rows from client writes', () => {
    const claimed = {
      ...queueMessage('queue-1', 'server text'),
      deliveryState: 'claimed' as const,
      claimedAtMs: 1_700_000_000_000,
      turnId: 'turn-1',
    }
    const nextState = reconcileThreadQueueStateWrite(
      { 'thread-1': [claimed, queueMessage('queue-2', 'second')] },
      {
        'thread-1': [
          queueMessage('queue-1', 'stale edited text'),
          queueMessage('queue-2', 'second'),
          { ...queueMessage('queue-stale', 'already finalized'), deliveryState: 'claimed' },
          queueMessage('queue-3', 'new'),
        ],
      },
    )

    expect(nextState['thread-1']).toEqual([
      claimed,
      expect.objectContaining({ id: 'queue-2' }),
      expect.objectContaining({ id: 'queue-3' }),
    ])
    expect(nextState['thread-1']?.some((message) => message.id === 'queue-stale')).toBe(false)
    expect(nextState['thread-1']?.[0]?.text).toBe('server text')
  })

  it('keeps a claimed queue row until its exact turn is confirmed and completed', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-claimed-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [queueMessage('queue-1', 'same text')])
    let notificationHandler: (notification: { method: string; params: unknown }) => void = () => undefined
    let resolveStart!: (value: unknown) => void
    const pendingStart = new Promise<unknown>((resolve) => {
      resolveStart = resolve
    })
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }
      }
      if (method === 'thread/read' && params.includeTurns === true) {
        return { thread: { id: 'thread-1', turns: [] } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return pendingStart
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({
      onNotification: (handler: typeof notificationHandler) => {
        notificationHandler = handler
        return () => undefined
      },
      rpc,
    } as never)

    try {
      const processing = processor.processThreadQueue('thread-1')
      await vi.waitFor(async () => {
        expect(await readQueueState(codexHome)).toEqual([
          expect.objectContaining({
            id: 'queue-1',
            deliveryState: 'claimed',
            skills: [{ name: 'queue-skill', path: '/skills/queue-skill/SKILL.md' }],
            fileAttachments: [{ label: 'notes.txt', path: '/tmp/notes.txt', fsPath: '/tmp/notes.txt' }],
          }),
        ])
      })

      resolveStart({ turn: { id: 'turn-queue-1' } })
      await processing
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({ id: 'queue-1', deliveryState: 'claimed', turnId: 'turn-queue-1' }),
      ])

      notificationHandler({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-queue-1', status: 'completed' } },
      })
      await vi.waitFor(async () => {
        expect(await readQueueState(codexHome)).toEqual([])
      })
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('restores the same queue item in place when turn/start fails', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-restore-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [
      queueMessage('queue-1', 'first'),
      queueMessage('queue-2', 'second'),
    ])
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }
      }
      if (method === 'thread/read' && params.includeTurns === true) return { thread: { id: 'thread-1', turns: [] } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') throw new Error('start failed')
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined, rpc } as never)

    try {
      await processor.processThreadQueue('thread-1')
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({
          id: 'queue-1',
          text: 'first',
          imageUrls: ['https://example.com/queued.png'],
          skills: [{ name: 'queue-skill', path: '/skills/queue-skill/SKILL.md' }],
          fileAttachments: [{ label: 'notes.txt', path: '/tmp/notes.txt', fsPath: '/tmp/notes.txt' }],
          speedMode: 'fast',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
        }),
        expect.objectContaining({ id: 'queue-2', text: 'second' }),
      ])
      expect((await readQueueState(codexHome))[0]).not.toHaveProperty('deliveryState')
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('recovers a completed claim after reconnect without deleting the next identical message', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-reconnect-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [
      { ...queueMessage('queue-1', 'identical'), deliveryState: 'claimed', claimedAtMs: Date.now() - 5_000, turnId: 'turn-1' },
      queueMessage('queue-2', 'identical'),
    ])
    const startedTexts: string[] = []
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }
      }
      if (method === 'thread/read' && params.includeTurns === true) {
        return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        const input = params.input as Array<{ type: string; text?: string }>
        startedTexts.push(input.find((item) => item.type === 'text')?.text ?? '')
        return { turn: { id: 'turn-2' } }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined, rpc } as never)

    try {
      await processor.processThreadQueue('thread-1')
      expect(startedTexts).toHaveLength(1)
      expect(startedTexts[0]).toContain('identical')
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({ id: 'queue-2', deliveryState: 'claimed', turnId: 'turn-2' }),
      ])
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('retries an expired claim whose returned turn was never persisted instead of dropping it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-expired-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [
      { ...queueMessage('queue-1', 'retry me'), deliveryState: 'claimed', claimedAtMs: Date.now() - 31_000, turnId: 'missing-turn' },
      queueMessage('queue-2', 'second'),
    ])
    const startedTexts: string[] = []
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }
      }
      if (method === 'thread/read' && params.includeTurns === true) return { thread: { id: 'thread-1', turns: [] } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        const input = params.input as Array<{ type: string; text?: string }>
        startedTexts.push(input.find((item) => item.type === 'text')?.text ?? '')
        return { turn: { id: 'retried-turn' } }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined, rpc } as never)

    try {
      await processor.processThreadQueue('thread-1')
      expect(startedTexts).toHaveLength(1)
      expect(startedTexts[0]).toContain('retry me')
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({ id: 'queue-1', deliveryState: 'claimed', turnId: 'retried-turn' }),
        expect.objectContaining({ id: 'queue-2', text: 'second' }),
      ])
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('recovers completed claims through native paginated history without a legacy full read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-paginated-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [
      { ...queueMessage('queue-1', 'completed'), deliveryState: 'claimed', claimedAtMs: Date.now() - 5_000, turnId: 'turn-1' },
      queueMessage('queue-2', 'next'),
    ])
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'paginated', status: { type: 'idle' } } }
      }
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'turn-1', status: { type: 'completed' } }], nextCursor: null }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-2' } }
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined, rpc } as never)

    try {
      await processor.processThreadQueue('thread-1')
      expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.objectContaining({ includeTurns: true }))
      expect(rpc).toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({ threadId: 'thread-1' }))
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({ id: 'queue-2', deliveryState: 'claimed', turnId: 'turn-2' }),
      ])
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('keeps an observed started turn claimed when the RPC response disconnects', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queue-observed-start-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    await writeQueueState(codexHome, [queueMessage('queue-1', 'observe me')])
    let notificationHandler: (notification: { method: string; params: unknown }) => void = () => undefined
    let rejectStart!: (error: Error) => void
    const pendingStart = new Promise<unknown>((_resolve, reject) => {
      rejectStart = reject
    })
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }
      }
      if (method === 'thread/read' && params.includeTurns === true) return { thread: { id: 'thread-1', turns: [] } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return pendingStart
      throw new Error(`unexpected method ${method}`)
    })
    const processor = new BackendQueueProcessor({
      onNotification: (handler: typeof notificationHandler) => {
        notificationHandler = handler
        return () => undefined
      },
      rpc,
    } as never)

    try {
      const processing = processor.processThreadQueue('thread-1')
      await vi.waitFor(async () => {
        expect((await readQueueState(codexHome))[0]).toMatchObject({ id: 'queue-1', deliveryState: 'claimed' })
      })
      notificationHandler({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'observed-turn' } },
      })
      rejectStart(new Error('response disconnected'))
      await processing
      expect(await readQueueState(codexHome)).toEqual([
        expect.objectContaining({ id: 'queue-1', deliveryState: 'claimed', turnId: 'observed-turn' }),
      ])

      notificationHandler({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'observed-turn', status: 'completed' } },
      })
      await vi.waitFor(async () => expect(await readQueueState(codexHome)).toEqual([]))
    } finally {
      processor.dispose()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('reschedules a pending drain when a run-now request needs an earlier drain', async () => {
    vi.useFakeTimers()
    const processor = new BackendQueueProcessor({
      onNotification: () => () => undefined,
    } as never)
    const processThreadQueue = vi
      .spyOn(processor as unknown as { processThreadQueue: (threadId: string) => Promise<void> }, 'processThreadQueue')
      .mockResolvedValue(undefined)

    processor.scheduleThreadQueueDrain('thread-1', 5000)
    processor.scheduleThreadQueueDrain('thread-1', 0)

    await vi.advanceTimersByTimeAsync(0)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)
    expect(processThreadQueue).toHaveBeenCalledWith('thread-1')

    await vi.advanceTimersByTimeAsync(5000)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)

    processor.dispose()
  })

  it('uses the queued or persisted per-thread model preference instead of global config', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-queued-thread-preference-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    try {
      await writeThreadModelPreference('thread-1', {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
      })
      const rpc = vi.fn(async () => {
        throw new Error('global config must not be read when a thread preference exists')
      })
      const processor = new BackendQueueProcessor({
        onNotification: () => () => undefined,
        rpc,
      } as never)
      const buildQueuedTurnParams = (processor as unknown as {
        buildQueuedTurnParams: (turn: {
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default' | 'plan'
            model?: string
            reasoningEffort?: 'high' | 'max'
            collaborationModeDeveloperInstructions?: string
          }
        }) => Promise<Record<string, unknown>>
      }).buildQueuedTurnParams.bind(processor)

      const persistedParams = await buildQueuedTurnParams({
        threadId: 'thread-1',
        message: {
          id: 'queued-1',
          text: 'persisted preference',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
        },
      })
      expect(persistedParams).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'max',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.6-sol',
            reasoning_effort: 'max',
          },
        },
      })

      const capturedParams = await buildQueuedTurnParams({
        threadId: 'thread-1',
        message: {
          id: 'queued-2',
          text: 'captured preference',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'plan',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          collaborationModeDeveloperInstructions: 'Ask material questions before planning.',
        },
      })
      expect(capturedParams).toMatchObject({
        model: 'gpt-5.5',
        effort: 'high',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.5',
            reasoning_effort: 'high',
            developer_instructions: 'Ask material questions before planning.',
          },
        },
      })
      expect(rpc).not.toHaveBeenCalled()
      processor.dispose()
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('automation TOML handling', () => {
  it('parses TOML string arrays without requiring JSON-only syntax', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      "cwds = ['/tmp/project-one', '/tmp/project,two']",
      'created_at = 111',
      'updated_at = 222',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation?.cwds).toEqual(['/tmp/project-one', '/tmp/project,two'])
    expect(automation?.createdAtMs).toBe(111)
    expect(automation?.extraTomlLines).toContain('[scheduler]')
  })

  it('omits preserved TOML internals from automation API records', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      'cwds = ["/tmp/project-one"]',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation).toBeTruthy()
    expect(toAutomationApiRecord(automation as NonNullable<typeof automation>)).not.toHaveProperty('extraTomlLines')
  })
})
