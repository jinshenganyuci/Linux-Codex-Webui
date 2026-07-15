import { computed, ref } from 'vue'

export type InProgressSendMode = 'steer' | 'queue'
export type DarkMode = 'system' | 'light' | 'dark'
export type ChatWidthMode = 'standard' | 'wide' | 'extra-wide'

export type ChatWidthPreset = {
  label: string
  columnMax: string
  cardMax: string
}

type PreferenceStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

type ThemeClassList = {
  add: (token: string) => void
  remove: (token: string) => void
  toggle: (token: string, force?: boolean) => unknown
}

type UseAppPreferencesOptions = {
  storage?: PreferenceStorage | null
  translate?: (message: string) => string
  getPreferredLanguages?: () => readonly string[]
  getThemeClassList?: () => ThemeClassList | null
  prefersDark?: () => boolean
}

const SEND_WITH_ENTER_KEY = 'codex-web-local.send-with-enter.v1'
const IN_PROGRESS_SEND_MODE_KEY = 'codex-web-local.in-progress-send-mode.v1'
const DARK_MODE_KEY = 'codex-web-local.dark-mode.v1'
const CHAT_WIDTH_KEY = 'codex-web-local.chat-width.v1'
const DICTATION_CLICK_TO_TOGGLE_KEY = 'codex-web-local.dictation-click-to-toggle.v1'
const DICTATION_AUTO_SEND_KEY = 'codex-web-local.dictation-auto-send.v1'
const DICTATION_LANGUAGE_KEY = 'codex-web-local.dictation-language.v1'

const CHAT_WIDTH_PRESETS: Record<ChatWidthMode, ChatWidthPreset> = {
  standard: {
    label: 'Standard',
    columnMax: '45rem',
    cardMax: '76ch',
  },
  wide: {
    label: 'Wide',
    columnMax: '72rem',
    cardMax: '88ch',
  },
  'extra-wide': {
    label: 'Extra wide',
    columnMax: '96rem',
    cardMax: '96ch',
  },
}

const WHISPER_LANGUAGES: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  de: 'german',
  es: 'spanish',
  ru: 'russian',
  ko: 'korean',
  fr: 'french',
  ja: 'japanese',
  pt: 'portuguese',
  tr: 'turkish',
  pl: 'polish',
  ca: 'catalan',
  nl: 'dutch',
  ar: 'arabic',
  sv: 'swedish',
  it: 'italian',
  id: 'indonesian',
  hi: 'hindi',
  fi: 'finnish',
  vi: 'vietnamese',
  he: 'hebrew',
  uk: 'ukrainian',
  el: 'greek',
  ms: 'malay',
  cs: 'czech',
  ro: 'romanian',
  da: 'danish',
  hu: 'hungarian',
  ta: 'tamil',
  no: 'norwegian',
  th: 'thai',
  ur: 'urdu',
  hr: 'croatian',
  bg: 'bulgarian',
  lt: 'lithuanian',
  la: 'latin',
  mi: 'maori',
  ml: 'malayalam',
  cy: 'welsh',
  sk: 'slovak',
  te: 'telugu',
  fa: 'persian',
  lv: 'latvian',
  bn: 'bengali',
  sr: 'serbian',
  az: 'azerbaijani',
  sl: 'slovenian',
  kn: 'kannada',
  et: 'estonian',
  mk: 'macedonian',
  br: 'breton',
  eu: 'basque',
  is: 'icelandic',
  hy: 'armenian',
  ne: 'nepali',
  mn: 'mongolian',
  bs: 'bosnian',
  kk: 'kazakh',
  sq: 'albanian',
  sw: 'swahili',
  gl: 'galician',
  mr: 'marathi',
  pa: 'punjabi',
  si: 'sinhala',
  km: 'khmer',
  sn: 'shona',
  yo: 'yoruba',
  so: 'somali',
  af: 'afrikaans',
  oc: 'occitan',
  ka: 'georgian',
  be: 'belarusian',
  tg: 'tajik',
  sd: 'sindhi',
  gu: 'gujarati',
  am: 'amharic',
  yi: 'yiddish',
  lo: 'lao',
  uz: 'uzbek',
  fo: 'faroese',
  ht: 'haitian creole',
  ps: 'pashto',
  tk: 'turkmen',
  nn: 'nynorsk',
  mt: 'maltese',
  sa: 'sanskrit',
  lb: 'luxembourgish',
  my: 'myanmar',
  bo: 'tibetan',
  tl: 'tagalog',
  mg: 'malagasy',
  as: 'assamese',
  tt: 'tatar',
  haw: 'hawaiian',
  ln: 'lingala',
  ha: 'hausa',
  ba: 'bashkir',
  jw: 'javanese',
  su: 'sundanese',
  yue: 'cantonese',
}

function defaultStorage(): PreferenceStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function defaultPreferredLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : (navigator.languages ?? [])
}

function defaultThemeClassList(): ThemeClassList | null {
  return typeof document === 'undefined' ? null : document.documentElement.classList
}

function defaultPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function loadBoolPref(storage: PreferenceStorage | null, key: string, fallback: boolean): boolean {
  if (!storage) return fallback
  const value = storage.getItem(key)
  if (value === null) return fallback
  return value === '1'
}

function loadDarkModePref(storage: PreferenceStorage | null): DarkMode {
  if (!storage) return 'system'
  const value = storage.getItem(DARK_MODE_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function loadInProgressSendModePref(storage: PreferenceStorage | null): InProgressSendMode {
  if (!storage) return 'steer'
  const value = storage.getItem(IN_PROGRESS_SEND_MODE_KEY)
  return value === 'steer' || value === 'queue' ? value : 'queue'
}

function loadChatWidthPref(storage: PreferenceStorage | null): ChatWidthMode {
  if (!storage) return 'wide'
  const value = storage.getItem(CHAT_WIDTH_KEY)
  return value === 'standard' || value === 'wide' || value === 'extra-wide' ? value : 'wide'
}

export function normalizeToWhisperLanguage(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value || value === 'auto') return ''
  if (value in WHISPER_LANGUAGES) return value
  const base = value.split('-')[0] ?? value
  return base in WHISPER_LANGUAGES ? base : ''
}

function loadDictationLanguagePref(storage: PreferenceStorage | null): string {
  if (!storage) return 'auto'
  const value = storage.getItem(DICTATION_LANGUAGE_KEY)?.trim() || 'auto'
  return normalizeToWhisperLanguage(value) || 'auto'
}

export function useAppPreferences(options: UseAppPreferencesOptions = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const translate = options.translate ?? ((message: string) => message)
  const getPreferredLanguages = options.getPreferredLanguages ?? defaultPreferredLanguages
  const getThemeClassList = options.getThemeClassList ?? defaultThemeClassList
  const prefersDark = options.prefersDark ?? defaultPrefersDark

  const sendWithEnter = ref(loadBoolPref(storage, SEND_WITH_ENTER_KEY, false))
  const inProgressSendMode = ref<InProgressSendMode>(loadInProgressSendModePref(storage))
  const darkMode = ref<DarkMode>(loadDarkModePref(storage))
  const chatWidth = ref<ChatWidthMode>(loadChatWidthPref(storage))
  const dictationClickToToggle = ref(loadBoolPref(storage, DICTATION_CLICK_TO_TOGGLE_KEY, false))
  const dictationAutoSend = ref(loadBoolPref(storage, DICTATION_AUTO_SEND_KEY, true))
  const dictationLanguage = ref(loadDictationLanguagePref(storage))

  const chatWidthPreset = computed(() => CHAT_WIDTH_PRESETS[chatWidth.value])
  const chatWidthLabel = computed(() => translate(chatWidthPreset.value.label))
  const dictationLanguageOptions = computed(() => {
    const languageOptions: Array<{ value: string; label: string }> = [
      { value: 'auto', label: translate('Auto-detect') },
    ]
    const seen = new Set<string>(['auto'])

    function formatLanguageLabel(value: string): string {
      const languageName = WHISPER_LANGUAGES[value] || value
      const title = languageName.charAt(0).toUpperCase() + languageName.slice(1)
      return `${title} (${value})`
    }

    for (const raw of getPreferredLanguages()) {
      const value = normalizeToWhisperLanguage(raw)
      if (!value || seen.has(value)) continue
      seen.add(value)
      languageOptions.push({
        value,
        label: `Preferred: ${formatLanguageLabel(value)}`,
      })
    }

    for (const value of Object.keys(WHISPER_LANGUAGES)) {
      if (seen.has(value)) continue
      seen.add(value)
      languageOptions.push({
        value,
        label: formatLanguageLabel(value),
      })
    }

    const current = dictationLanguage.value.trim()
    if (current && !seen.has(current)) {
      languageOptions.push({
        value: current,
        label: formatLanguageLabel(current),
      })
    }

    return languageOptions
  })

  function persist(key: string, value: string): void {
    storage?.setItem(key, value)
  }

  function toggleSendWithEnter(): void {
    sendWithEnter.value = !sendWithEnter.value
    persist(SEND_WITH_ENTER_KEY, sendWithEnter.value ? '1' : '0')
  }

  function cycleInProgressSendMode(): void {
    inProgressSendMode.value = inProgressSendMode.value === 'steer' ? 'queue' : 'steer'
    persist(IN_PROGRESS_SEND_MODE_KEY, inProgressSendMode.value)
  }

  function applyDarkMode(): void {
    const classList = getThemeClassList()
    if (!classList) return
    if (darkMode.value === 'dark') {
      classList.add('dark')
    } else if (darkMode.value === 'light') {
      classList.remove('dark')
    } else {
      classList.toggle('dark', prefersDark())
    }
  }

  function cycleDarkMode(): void {
    const order: DarkMode[] = ['system', 'light', 'dark']
    const index = order.indexOf(darkMode.value)
    darkMode.value = order[(index + 1) % order.length]
    persist(DARK_MODE_KEY, darkMode.value)
    applyDarkMode()
  }

  function cycleChatWidth(): void {
    const order: ChatWidthMode[] = ['standard', 'wide', 'extra-wide']
    const index = order.indexOf(chatWidth.value)
    chatWidth.value = order[(index + 1) % order.length]
    persist(CHAT_WIDTH_KEY, chatWidth.value)
  }

  function toggleDictationClickToToggle(): void {
    dictationClickToToggle.value = !dictationClickToToggle.value
    persist(DICTATION_CLICK_TO_TOGGLE_KEY, dictationClickToToggle.value ? '1' : '0')
  }

  function toggleDictationAutoSend(): void {
    dictationAutoSend.value = !dictationAutoSend.value
    persist(DICTATION_AUTO_SEND_KEY, dictationAutoSend.value ? '1' : '0')
  }

  function onDictationLanguageChange(nextValue: string): void {
    const value = normalizeToWhisperLanguage(nextValue.trim()) || 'auto'
    dictationLanguage.value = value
    persist(DICTATION_LANGUAGE_KEY, value)
  }

  return {
    sendWithEnter,
    inProgressSendMode,
    darkMode,
    chatWidth,
    chatWidthPreset,
    chatWidthLabel,
    dictationClickToToggle,
    dictationAutoSend,
    dictationLanguage,
    dictationLanguageOptions,
    toggleSendWithEnter,
    cycleInProgressSendMode,
    cycleDarkMode,
    cycleChatWidth,
    toggleDictationClickToToggle,
    toggleDictationAutoSend,
    onDictationLanguageChange,
    applyDarkMode,
  }
}
