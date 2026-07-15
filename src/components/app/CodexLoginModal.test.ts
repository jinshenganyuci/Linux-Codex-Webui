import { describe, expect, it } from 'vitest'
import { getCodexLoginModalPresentation } from './codexLoginModal'

describe('CodexLoginModal', () => {
  it('keeps submit disabled for blank callback values', () => {
    expect(getCodexLoginModalPresentation('  ', false, (message) => message)).toEqual({
      controlsDisabled: false,
      submitDisabled: true,
      submitLabel: 'Complete',
    })
  })

  it('keeps all controls disabled while completion is in flight', () => {
    expect(getCodexLoginModalPresentation('http://localhost/callback', true, (message) => message)).toEqual({
      controlsDisabled: true,
      submitDisabled: true,
      submitLabel: 'Completing…',
    })
  })

  it('enables submission for a non-empty callback and translates the label', () => {
    expect(getCodexLoginModalPresentation(
      ' http://localhost/callback ',
      false,
      (message) => `translated:${message}`,
    )).toEqual({
      controlsDisabled: false,
      submitDisabled: false,
      submitLabel: 'translated:Complete',
    })
  })
})
