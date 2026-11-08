export const PROMPT_HISTORY_STORAGE_KEY = 'codex-web-local.prompt-history.v1'
export const MAX_PROMPT_HISTORY_ENTRIES = 100
export const MAX_PROMPT_HISTORY_LENGTH = 20_000
export const MAX_PROMPT_HISTORY_TOTAL_LENGTH = 200_000

export function appendPromptHistory(history: readonly string[], prompt: string): string[] {
  const normalized = prompt.trim()
  if (!normalized || normalized.length > MAX_PROMPT_HISTORY_LENGTH) return [...history]
  const next = [...history.filter((entry) => entry !== normalized), normalized].slice(-MAX_PROMPT_HISTORY_ENTRIES)
  let totalLength = next.reduce((total, entry) => total + entry.length, 0)
  while (totalLength > MAX_PROMPT_HISTORY_TOTAL_LENGTH) {
    totalLength -= next.shift()?.length ?? 0
  }
  return next
}

export function searchPromptHistory(history: readonly string[], query: string, limit = 20): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  const maxResults = Math.max(0, Math.trunc(limit))
  if (maxResults === 0) return []
  const results: string[] = []
  for (let index = history.length - 1; index >= 0 && results.length < maxResults; index -= 1) {
    const prompt = history[index]
    if (prompt && (!normalizedQuery || prompt.toLowerCase().includes(normalizedQuery))) results.push(prompt)
  }
  return results
}

export function readPromptHistory(storage: Pick<Storage, 'getItem'> | null): string[] {
  if (!storage) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PROMPT_HISTORY_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.slice(-MAX_PROMPT_HISTORY_ENTRIES * 2).reduce<string[]>((history, entry) => (
      typeof entry === 'string' ? appendPromptHistory(history, entry) : history
    ), [])
  } catch {
    return []
  }
}

export function writePromptHistory(storage: Pick<Storage, 'setItem'> | null, history: readonly string[]): void {
  if (!storage) return
  try {
    storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-MAX_PROMPT_HISTORY_ENTRIES)))
  } catch {
    return
  }
}
