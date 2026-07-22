import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectZipExportStatus } from './projectZipExportModal'

let codexLoginModal: Component
let projectZipExportModal: Component
let viteServer: ViteDevServer

beforeAll(async () => {
  viteServer = await createServer({
    configFile: false,
    appType: 'custom',
    plugins: [vue()],
    server: { middlewareMode: true },
  })
  const [loginModule, exportModule, languageModule] = await Promise.all([
    viteServer.ssrLoadModule('/src/components/app/CodexLoginModal.vue'),
    viteServer.ssrLoadModule('/src/components/app/ProjectZipExportModal.vue'),
    viteServer.ssrLoadModule('/src/composables/useUiLanguage.ts'),
  ]) as Array<{ default?: Component; setUiLanguage?: (language: 'en' | 'zh-CN') => void }>
  codexLoginModal = loginModule.default as Component
  projectZipExportModal = exportModule.default as Component
  languageModule.setUiLanguage?.('en')
})

afterAll(async () => {
  await viteServer?.close()
})

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  return await renderToString(createSSRApp({
    render: () => h(component, props),
  }))
}

describe('application modal component contracts', () => {
  it('keeps the Codex login dialog DOM and accessibility semantics', async () => {
    const html = await render(codexLoginModal, {
      loginUrl: 'https://example.test/login',
      callbackUrl: '',
      error: 'Callback rejected',
      isCompleting: false,
      feedbackMailto: 'mailto:feedback@example.test',
    })

    expect(html).toContain('class="codex-login-modal-backdrop" role="presentation"')
    expect(html).toContain('class="codex-login-modal" role="dialog" aria-modal="true"')
    expect(html).toContain('aria-label="Complete Codex login"')
    expect(html).toContain('href="https://example.test/login" target="_blank" rel="noreferrer"')
    expect(html).toContain('type="url" inputmode="url"')
    expect(html).toContain('codex-login-modal-error visible-error-with-feedback')
    expect(html).toContain('class="codex-login-modal-submit" type="submit" disabled')
  })

  it('keeps the project export progress and alert DOM semantics', async () => {
    const status: ProjectZipExportStatus = {
      phase: 'ready',
      loaded: 1536,
      total: 1536,
      blob: new Blob(['zip']),
      fileName: 'workspace.zip',
      error: 'Sharing was blocked',
    }
    const html = await render(projectZipExportModal, { status })

    expect(html).toContain('class="project-zip-modal-backdrop" role="presentation"')
    expect(html).toContain('class="project-zip-modal" role="dialog" aria-modal="true"')
    expect(html).toContain('aria-label="Export Project"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toContain('workspace.zip')
    expect(html).toContain('1.5 KB / 1.5 KB')
    expect(html).toContain('style="transform:scaleX(1);"')
    expect(html).toContain('class="project-zip-modal-error" role="alert"')
  })
})
