import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendQueueProcessor,
  mergeSessionSkillInputsIntoHistoryResult,
  mergeSessionSkillInputsIntoTurns,
  parseAutomationToml,
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
