import { describe, expect, it } from 'vitest'

const moduleUrl = new URL('../../scripts/prepare-codex-acceptance.mjs', import.meta.url).href
const { prepareAcceptanceConfig, readTopLevelString } = await import(moduleUrl)

describe('isolated acceptance setup', () => {
  it('preserves defaults, provider configuration, existing models and full native model profiles', () => {
    const config = 'model = "gpt-5.6-luna"\nmodel_context_window = 512000\nmodel_auto_compact_token_limit = 400000\nmodel_catalog_json = "/production/models.json"\n[model_providers.myproxy]\nwire_api = "responses"\n'
    const existing = { slug: 'custom', tool_mode: 'custom-mode' }
    const astra = { slug: 'gpt-6-astra', tool_mode: 'code_mode_only', multi_agent_version: 'v2', supported_reasoning_levels: [{ effort: 'ultra' }] }
    const prepared = prepareAcceptanceConfig(config, { models: [existing] }, { models: [astra] }, '/isolated', ['gpt-6-astra'])
    expect(prepared.catalog.models).toEqual([existing, astra])
    expect(prepared.config).toContain('model = "gpt-5.6-luna"')
    expect(prepared.config).toContain('model_context_window = 512000')
    expect(prepared.config).toContain('model_auto_compact_token_limit = 400000')
    expect(prepared.config).toContain('[model_providers.myproxy]\nwire_api = "responses"')
    expect(readTopLevelString(prepared.config, 'model_catalog_json')).toBe('/isolated/models.acceptance.json')
    expect(readTopLevelString(prepared.config, 'sqlite_home')).toBe('/isolated/sqlite')
  })

  it('does not silently replace an existing custom model entry or infer another model', () => {
    const model = { slug: 'gpt-6-astra', custom: true }
    expect(prepareAcceptanceConfig('', { models: [model] }, { models: [{ slug: 'gpt-6-astra' }] }, '/isolated', ['gpt-6-astra']).catalog.models).toEqual([model])
    expect(() => prepareAcceptanceConfig('', { models: [] }, { models: [] }, '/isolated', ['missing'])).toThrow('missing')
  })
})
