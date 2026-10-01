import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RuntimeDiagnostics } from '../../runtimeDiagnostics'

let card: Component
let panel: Component
let viteServer: ViteDevServer

beforeAll(async () => {
  viteServer = await createServer({ configFile: false, appType: 'custom', plugins: [vue()], server: { middlewareMode: true, hmr: false } })
  card = (await viteServer.ssrLoadModule('/src/components/settings/RuntimeInfoCard.vue')).default
  panel = (await viteServer.ssrLoadModule('/src/components/settings/RuntimeInfoPanel.vue')).default
  const language = await viteServer.ssrLoadModule('/src/composables/useUiLanguage.ts')
  language.setUiLanguage('en')
})
afterAll(async () => { await viteServer?.close(); vi.unstubAllGlobals() })

const runtime: RuntimeDiagnostics = {
  webui: { version: 'test', commit: '', dirty: true },
  codex: { version: '0.154.0', startedAt: '', home: '/isolated', command: '/pinned/codex', catalogStatus: 'ready', generation: 1, running: true },
  systemCli: { status: 'available', version: '0.159.3', command: '/global/codex', checkedAt: '2026-10-01T00:00:00.000Z' },
  explicitRuntime: true,
  memory: { status: 'available', reason: 'confirmed', v2Ready: false, v2ConsolidatedThreads: 0, checkedAt: '2026-10-01T00:00:00.000Z' },
  temporaryFeatures: { status: 'unknown', verifiedKeys: [] },
}
const renderCard = (overrides: Partial<RuntimeDiagnostics> = {}) => renderToString(createSSRApp({ render: () => h(card, { runtime: { ...runtime, ...overrides } }) }))

describe('runtime information panel', () => {
  it('renders a collapsed panel without starting diagnostics', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const html = await renderToString(createSSRApp({ render: () => h(panel) }))
    expect(fetch).not.toHaveBeenCalled()
    expect(html).toContain('data-testid="runtime-info-panel"')
    expect(html).not.toContain('data-testid="runtime-diagnostics"')
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/)
  })

  it('separates installed and running versions and explains the explicit runtime', async () => {
    const html = await renderCard()
    expect(html).toMatch(/data-testid="system-cli-version"[^]*?0\.159\.3/)
    expect(html).toMatch(/data-testid="running-cli-version"[^]*?0\.154\.0/)
    expect(html).toContain('Explicit runtime command')
    expect(html).toContain('does not restart or replace')
    expect(html).toContain('Memory is not ready yet')
    expect(html).toContain('Consolidated threads: 0')
    expect(html).toContain('Temporary switches remain read-only')
  })

  it.each(['unsupported', 'unknown'] as const)('does not present an unconfirmed memory result as zero: %s', async status => {
    const html = await renderCard({ memory: { ...runtime.memory, status, reason: status === 'unsupported' ? 'unsupported' : 'unavailable', v2Ready: null, v2ConsolidatedThreads: null } })
    expect(html).toContain(`data-status="${status}"`)
    expect(html).not.toContain('Consolidated threads')
    expect(html).not.toContain('Memory is ready')
    expect(html).not.toContain('Memory is not ready yet')
  })
})
