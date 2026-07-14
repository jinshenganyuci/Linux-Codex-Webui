import { describe, expect, it } from 'vitest'
import { sortModelIdsByStrength } from './modelSort'

describe('sortModelIdsByStrength', () => {
  it('orders known Codex models from strongest to weakest', () => {
    expect(sortModelIdsByStrength([
      'gpt-5.2',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.4',
      'gpt-5.6-terra',
      'codex-auto-review',
    ])).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
      'codex-auto-review',
    ])
  })

  it('preserves the provider order for models without a reliable ranking', () => {
    expect(sortModelIdsByStrength([
      'provider-model-b',
      'gpt-5.4',
      'provider-model-a',
    ])).toEqual([
      'gpt-5.4',
      'provider-model-b',
      'provider-model-a',
    ])
  })
})
