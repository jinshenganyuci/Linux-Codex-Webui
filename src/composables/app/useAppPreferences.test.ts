import { describe, expect, it, vi } from 'vitest'
import { normalizeToWhisperLanguage, useAppPreferences } from './useAppPreferences'

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

describe('useAppPreferences', () => {
  it('loads browser defaults while preserving the no-storage in-progress fallback', () => {
    const preferences = useAppPreferences({ storage: createStorage() })

    expect(preferences.sendWithEnter.value).toBe(true)
    expect(preferences.inProgressSendMode.value).toBe('queue')
    expect(preferences.darkMode.value).toBe('system')
    expect(preferences.chatWidth.value).toBe('standard')
    expect(preferences.dictationClickToToggle.value).toBe(false)
    expect(preferences.dictationAutoSend.value).toBe(true)
    expect(preferences.dictationLanguage.value).toBe('auto')

    expect(useAppPreferences({ storage: null }).inProgressSendMode.value).toBe('steer')
  })

  it('loads and normalizes persisted preferences', () => {
    const preferences = useAppPreferences({
      storage: createStorage({
        'codex-web-local.send-with-enter.v1': '0',
        'codex-web-local.in-progress-send-mode.v1': 'steer',
        'codex-web-local.dark-mode.v1': 'dark',
        'codex-web-local.chat-width.v1': 'wide',
        'codex-web-local.dictation-click-to-toggle.v1': '1',
        'codex-web-local.dictation-auto-send.v1': '0',
        'codex-web-local.dictation-language.v1': 'zh-CN',
      }),
      translate: (message) => `translated:${message}`,
    })

    expect(preferences.sendWithEnter.value).toBe(false)
    expect(preferences.inProgressSendMode.value).toBe('steer')
    expect(preferences.darkMode.value).toBe('dark')
    expect(preferences.chatWidth.value).toBe('wide')
    expect(preferences.chatWidthPreset.value).toEqual({
      label: 'Wide',
      columnMax: '72rem',
      cardMax: '88ch',
    })
    expect(preferences.chatWidthLabel.value).toBe('translated:Wide')
    expect(preferences.dictationClickToToggle.value).toBe(true)
    expect(preferences.dictationAutoSend.value).toBe(false)
    expect(preferences.dictationLanguage.value).toBe('zh')
  })

  it('falls back consistently when persisted values are malformed', () => {
    const preferences = useAppPreferences({
      storage: createStorage({
        'codex-web-local.send-with-enter.v1': 'unexpected',
        'codex-web-local.in-progress-send-mode.v1': 'unexpected',
        'codex-web-local.dark-mode.v1': 'unexpected',
        'codex-web-local.chat-width.v1': 'unexpected',
        'codex-web-local.dictation-click-to-toggle.v1': 'unexpected',
        'codex-web-local.dictation-auto-send.v1': 'unexpected',
        'codex-web-local.dictation-language.v1': 'unexpected',
      }),
    })

    expect(preferences.sendWithEnter.value).toBe(false)
    expect(preferences.inProgressSendMode.value).toBe('queue')
    expect(preferences.darkMode.value).toBe('system')
    expect(preferences.chatWidth.value).toBe('standard')
    expect(preferences.dictationClickToToggle.value).toBe(false)
    expect(preferences.dictationAutoSend.value).toBe(false)
    expect(preferences.dictationLanguage.value).toBe('auto')
  })

  it('cycles and persists the settings using the existing storage keys', () => {
    const storage = createStorage()
    const classList = {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    }
    const preferences = useAppPreferences({
      storage,
      getThemeClassList: () => classList,
      prefersDark: () => true,
    })

    preferences.toggleSendWithEnter()
    preferences.cycleInProgressSendMode()
    preferences.cycleDarkMode()
    preferences.cycleChatWidth()
    preferences.toggleDictationClickToToggle()
    preferences.toggleDictationAutoSend()

    expect(storage.setItem.mock.calls).toEqual([
      ['codex-web-local.send-with-enter.v1', '0'],
      ['codex-web-local.in-progress-send-mode.v1', 'steer'],
      ['codex-web-local.dark-mode.v1', 'light'],
      ['codex-web-local.chat-width.v1', 'wide'],
      ['codex-web-local.dictation-click-to-toggle.v1', '1'],
      ['codex-web-local.dictation-auto-send.v1', '0'],
    ])
    expect(classList.remove).toHaveBeenCalledWith('dark')

    preferences.cycleDarkMode()
    preferences.cycleDarkMode()
    expect(classList.add).toHaveBeenCalledWith('dark')
    expect(classList.toggle).toHaveBeenCalledWith('dark', true)
  })

  it('orders preferred dictation languages first and persists normalized selections', () => {
    const storage = createStorage()
    const preferences = useAppPreferences({
      storage,
      translate: (message) => `translated:${message}`,
      getPreferredLanguages: () => ['fr-CA', 'zh-Hant', 'fr-FR', 'unsupported'],
    })

    expect(preferences.dictationLanguageOptions.value.slice(0, 4)).toEqual([
      { value: 'auto', label: 'translated:Auto-detect' },
      { value: 'fr', label: 'Preferred: French (fr)' },
      { value: 'zh', label: 'Preferred: Chinese (zh)' },
      { value: 'en', label: 'English (en)' },
    ])

    preferences.onDictationLanguageChange(' JA-jp ')
    expect(preferences.dictationLanguage.value).toBe('ja')
    expect(storage.setItem).toHaveBeenLastCalledWith('codex-web-local.dictation-language.v1', 'ja')

    preferences.onDictationLanguageChange('unsupported')
    expect(preferences.dictationLanguage.value).toBe('auto')
    expect(storage.setItem).toHaveBeenLastCalledWith('codex-web-local.dictation-language.v1', 'auto')
  })

  it('normalizes only Whisper-supported language codes', () => {
    expect(normalizeToWhisperLanguage('yue-HK')).toBe('yue')
    expect(normalizeToWhisperLanguage('EN-us')).toBe('en')
    expect(normalizeToWhisperLanguage('auto')).toBe('')
    expect(normalizeToWhisperLanguage('unsupported')).toBe('')
  })
})
