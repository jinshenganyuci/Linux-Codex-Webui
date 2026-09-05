import { describe, expect, it, vi } from 'vitest'
import { codexVersionFromUserAgent, RuntimeCatalog } from './runtimeCatalog'

describe('running CLI catalog provenance', () => {
  it.each(['codex-cli 0.153.4', 'linux-codex-webui/0.153.4 (Linux) test (linux-codex-webui; 0.1.87)'])('reads the actual CLI version from %s', value => {
    expect(codexVersionFromUserAgent(value)).toBe('0.153.4')
  })

  it('coalesces concurrent discovery and only exports safe model fields', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => args[0] === '--version' ? 'codex-cli 0.153.4' : JSON.stringify({ models: [{ slug: 'gpt-6-astra', base_instructions: 'private instructions', model_messages: { secret: 'hidden' } }] }))
    const catalog = new RuntimeCatalog(run)
    const results = await Promise.all(Array.from({ length: 100 }, () => catalog.read('/pinned/codex', '0.153.4')))
    expect(run).toHaveBeenCalledTimes(2)
    expect(catalog.status).toBe('ready')
    expect(JSON.stringify(results)).not.toContain('private instructions')
    expect(JSON.stringify(results)).not.toContain('hidden')
    await catalog.read('/pinned/codex', '0.153.4')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not substitute a newer on-disk catalog for an older running CLI', async () => {
    const run = vi.fn(async () => 'codex-cli 0.153.4')
    const catalog = new RuntimeCatalog(run)
    await expect(catalog.read('/global/codex', '0.152.0')).resolves.toEqual([])
    expect(catalog.status).toBe('version-mismatch')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retains a bounded unavailable result for unsupported legacy commands', async () => {
    const run = vi.fn(async () => { throw new Error('unknown command') })
    const catalog = new RuntimeCatalog(run)
    await expect(catalog.read('/legacy/codex', '0.152.0')).resolves.toEqual([])
    await expect(catalog.read('/legacy/codex', '0.152.0')).resolves.toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
    expect(catalog.status).toBe('unavailable')
  })
})
