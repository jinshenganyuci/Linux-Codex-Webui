import { describe, expect, it } from 'vitest'
import { normalizeModelCapability, providerModelCapability } from './modelCapabilities'

describe('version-driven model capabilities', () => {
  it('preserves Astra ultra and the exact priority service tier without a model override', () => {
    const model = normalizeModelCapability({
      slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', default_reasoning_level: 'low',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
      service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
    }, 'bundled')
    expect(model).toMatchObject({ metadataSource: 'bundled', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low', supportsFastMode: true, fastServiceTier: 'priority' })
  })

  it('distinguishes missing metadata from explicitly unsupported capabilities', () => {
    expect(providerModelCapability('custom')).toMatchObject({ metadataSource: 'provider', reasoningSupport: 'unknown', fastModeSupport: 'unknown' })
    expect(normalizeModelCapability({ id: 'custom', supportedReasoningEfforts: [], serviceTiers: [] })).toMatchObject({ reasoningSupport: 'unsupported', fastModeSupport: 'unsupported' })
  })

  it('never resolves provider aliases through a substring match', () => {
    const model = normalizeModelCapability({ slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'ultra' }] }, 'bundled')!
    expect(providerModelCapability('my-gpt-6-astra', [model]).reasoningSupport).toBe('unknown')
    expect(providerModelCapability('gpt-6-astra', [model])).toBe(model)
  })
})
