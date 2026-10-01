import { describe, expect, it } from 'vitest'
import { canToggleRuntimeFeature, getVerifiedRuntimeFeatureKeys, type NativeExtensionInfo, type NativeFeature } from './nativeExtensions'

const feature: NativeFeature = { name: 'memories', enabled: false, defaultEnabled: false, stage: 'stable', displayName: null, description: null }
const info: NativeExtensionInfo = { threadId: null, cliVersion: '0.159.3', provider: 'openai', accountType: null, features: [feature], featureRequirements: {}, requirementsKnown: true, warnings: [] }

describe('verified runtime feature switches', () => {
  it('accepts only exact tested versions and keys', () => {
    expect(getVerifiedRuntimeFeatureKeys('0.159.3')).toHaveLength(5)
    expect(getVerifiedRuntimeFeatureKeys('0.153.4')).toHaveLength(5)
    for (const version of ['0.154.0', '0.159.2', '0.159.3-alpha.1', '0.160.0', null]) expect(getVerifiedRuntimeFeatureKeys(version)).toEqual([])
    expect(canToggleRuntimeFeature(info, feature)).toBe(true)
    expect(canToggleRuntimeFeature(info, { ...feature, name: 'apps' })).toBe(false)
    expect(canToggleRuntimeFeature(info, { ...feature, name: 'plugins' })).toBe(false)
  })

  it('keeps missing policy, managed locks, and unstable feature stages read-only', () => {
    expect(canToggleRuntimeFeature({ ...info, requirementsKnown: false }, feature)).toBe(false)
    expect(canToggleRuntimeFeature({ ...info, featureRequirements: { memories: false } }, feature)).toBe(false)
    expect(canToggleRuntimeFeature(info, { ...feature, stage: 'underDevelopment' })).toBe(false)
  })
})
