import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCommandExecutionBlockState } from './commandExecutionBlockModel'

const baseInput = {
  instanceId: 'timeline:command:one',
  command: 'pnpm run build',
  output: 'build complete',
  expanded: false,
  commandFallback: '(command)',
  emptyOutputLabel: '(no output)',
}

function readState(overrides: Partial<typeof baseInput> = {}) {
  return buildCommandExecutionBlockState({ ...baseInput, ...overrides })
}

let component: Component
let viteServer: ViteDevServer

beforeAll(async () => {
  viteServer = await createServer({
    configFile: false,
    appType: 'custom',
    plugins: [vue()],
    server: { middlewareMode: true },
  })
  const componentModule = await viteServer.ssrLoadModule(
    '/src/components/content/thread-conversation/CommandExecutionBlock.vue',
  ) as { default: Component }
  component = componentModule.default
})

afterAll(async () => {
  await viteServer?.close()
})

async function renderCommand(overrides: Partial<typeof baseInput> = {}): Promise<string> {
  const input = { ...baseInput, ...overrides }
  return await renderToString(createSSRApp({
    render: () => h(component, {
      instanceId: input.instanceId,
      command: input.command,
      output: input.output,
      expanded: input.expanded,
      commandFallback: input.commandFallback,
      emptyOutputLabel: input.emptyOutputLabel,
      statusLabel: 'Completed',
      statusClass: 'cmd-status-ok',
      compact: false,
      condensed: false,
    }),
  }))
}

describe('buildCommandExecutionBlockState', () => {
  it('keeps deterministic labels and region ids while collapsed', () => {
    const state = readState({ output: 'build complete', expanded: false })

    expect(state.commandLabel).toBe('pnpm run build')
    expect(state.mountedOutput).toBe('build complete')
    expect(state.outputDomId).toBe('command-output-timeline%3Acommand%3Aone')
  })

  it('preserves the existing collapsed output DOM during component extraction', async () => {
    const html = await renderCommand({ output: 'build complete', expanded: false })

    expect(html).toContain('<pre')
    expect(html).toContain('build complete')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('returns the complete unmodified output while expanded', () => {
    const output = 'first line\nsecond <line>\nlast line'
    const state = readState({ output, expanded: true })

    expect(state.mountedOutput).toBe(output)
  })

  it('mounts the complete escaped output and its ARIA region while expanded', async () => {
    const output = 'first line\nsecond <line>\nlast line'
    const html = await renderCommand({ output, expanded: true })

    expect(html).toContain('<pre')
    expect(html).toContain('first line\nsecond &lt;line&gt;\nlast line')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-hidden="false"')
    expect(html).toContain('role="region"')
  })

  it('keeps timeline and worked-detail ARIA targets unique', () => {
    const timeline = readState({ instanceId: 'timeline:command:one' })
    const worked = readState({ instanceId: 'worked:summary:command:one' })

    expect(timeline.outputDomId).not.toBe(worked.outputDomId)
  })

  it('keeps the existing empty command and output fallbacks', () => {
    const state = readState({ command: '', output: '', expanded: true })

    expect(state.commandLabel).toBe('(command)')
    expect(state.mountedOutput).toBe('(no output)')
  })
})
