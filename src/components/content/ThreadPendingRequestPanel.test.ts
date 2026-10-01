import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiServerRequest } from '../../types/codex'

let component: Component
let viteServer: ViteDevServer

beforeAll(async () => {
  viteServer = await createServer({
    configFile: false,
    appType: 'custom',
    plugins: [vue()],
    server: { middlewareMode: true, hmr: false },
  })
  const componentModule = await viteServer.ssrLoadModule(
    '/src/components/content/ThreadPendingRequestPanel.vue',
  ) as { default: Component }
  component = componentModule.default
})

afterAll(async () => {
  await viteServer?.close()
})

async function renderQuestion(flags: Record<string, unknown>): Promise<string> {
  const request: UiServerRequest = {
    id: 7,
    generation: 1,
    method: 'item/tool/requestUserInput',
    threadId: 'thread-under-test',
    turnId: 'turn-under-test',
    itemId: 'item-under-test',
    receivedAtIso: '2026-10-01T08:00:00.000Z',
    params: { questions: [{ id: 'token', question: 'token?', options: [], ...flags }] },
  }
  return renderToString(createSSRApp({
    render: () => h(component, { request, requests: [request] }),
  }))
}

describe('ThreadPendingRequestPanel secret answer fields', () => {
  it.each([
    ['isSecret', { isSecret: true }],
    ['legacy secret', { secret: true }],
  ])('renders %s questions as password fields', async (_, flags) => {
    const html = await renderQuestion(flags as Record<string, unknown>)
    const input = html.match(/<input\b[^>]*\bdata-question-id="token"[^>]*>/u)?.[0]
    expect(input).toBeDefined()
    expect(input).toContain('type="password"')
    expect(input).toContain('autocomplete="off"')
    expect(input).toContain('data-question-id="token"')
  })

  it('keeps ordinary questions as text fields', async () => {
    const html = await renderQuestion({})
    const input = html.match(/<input\b[^>]*\bdata-question-id="token"[^>]*>/u)?.[0]
    expect(input).toBeDefined()
    expect(input).toContain('type="text"')
    expect(input).not.toContain('type="password"')
  })
})
