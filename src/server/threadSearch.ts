import { stat } from 'node:fs/promises'

/** Search summaries first; reading conversation bodies is an explicit, bounded background task. */
export type ThreadSearchSummary = {
  id: string
  name: string
  preview: string
  cwd: string
  updatedAt: number
  createdAt: number
  source?: unknown
  historyMode?: unknown
  status?: unknown
}

export type ThreadSearchResponse = {
  threadIds: string[]
  threads: ThreadSearchSummary[]
  indexedThreadCount: number
  contentSearchState: 'idle' | 'loading' | 'ready' | 'partial' | 'error'
  searchedContentCount: number
  skippedContentCount: number
  contentThreadCount: number
}

type Dependencies = {
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
  readTitles: () => Promise<Record<string, string>>
  now?: () => number
  metadataTtlMs?: number
  contentTtlMs?: number
  contentThreadLimit?: number
  contentCharacterLimit?: number
  contentBudgetCharacters?: number
  contentReadTimeoutMs?: number
  contentRolloutByteLimit?: number
  contentReadByteBudget?: number
  readRolloutFileSize?: (path: string) => Promise<number | null>
}
type ContentEntry = { updatedAt: number; fetchedAt: number; text: string; partial: boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function extractSearchableThreadText(value: unknown, limit: number): { text: string; partial: boolean } {
  const turns = record(record(value).thread).turns
  const parts: string[] = []
  let size = 0
  let partial = false
  const append = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return
    const text = value.trim()
    const remaining = Math.max(0, limit - size)
    if (text.length > remaining) partial = true
    if (remaining > 0) {
      parts.push(text.slice(0, remaining))
      size += Math.min(text.length, remaining) + 1
    }
  }
  for (const turn of Array.isArray(turns) ? turns : []) {
    const items = record(turn).items
    for (const item of Array.isArray(items) ? items : []) {
      const row = record(item)
      if (row.type === 'agentMessage') append(row.text)
      else if (row.type === 'userMessage') {
        for (const block of Array.isArray(row.content) ? row.content : []) {
          if (record(block).type === 'text') append(record(block).text)
        }
      } else if (row.type === 'commandExecution') {
        append(row.command)
        append(row.aggregatedOutput)
      }
    }
  }
  return { text: parts.join('\n').toLowerCase(), partial }
}

async function readRolloutFileSize(path: string): Promise<number | null> {
  if (!path) return null
  try {
    const info = await stat(path)
    return info.isFile() && Number.isSafeInteger(info.size) && info.size >= 0 ? info.size : null
  } catch {
    return null
  }
}

export function createThreadSearchService(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now
  const metadataTtlMs = dependencies.metadataTtlMs ?? 15_000
  const contentTtlMs = dependencies.contentTtlMs ?? 60_000
  const contentThreadLimit = dependencies.contentThreadLimit ?? 100
  const contentCharacterLimit = dependencies.contentCharacterLimit ?? 512_000
  const contentBudgetCharacters = dependencies.contentBudgetCharacters ?? 8_000_000
  const contentReadTimeoutMs = dependencies.contentReadTimeoutMs ?? 15_000
  const contentRolloutByteLimit = dependencies.contentRolloutByteLimit ?? 2 * 1024 * 1024
  const contentReadByteBudget = dependencies.contentReadByteBudget ?? 8 * 1024 * 1024
  const inspectRolloutSize = dependencies.readRolloutFileSize ?? readRolloutFileSize
  let summaries: ThreadSearchSummary[] = []
  let loadedAt = -Infinity
  let generation = 0
  let metadataPromise: Promise<void> | null = null
  let contentPromise: Promise<void> | null = null
  let activeContentRead: Promise<unknown> | null = null
  let contentState: ThreadSearchResponse['contentSearchState'] = 'idle'
  let searchedContentCount = 0
  let skippedContentCount = 0
  let contentSignature = ''
  let disposed = false
  let contentRequestedAt = -Infinity
  let contentAttemptedAt = -Infinity
  const contents = new Map<string, ContentEntry>()
  let rolloutPaths = new Map<string, string>()

  const loadMetadata = async () => {
    if (now() - loadedAt < metadataTtlMs) return
    if (metadataPromise) return metadataPromise
    const startedGeneration = generation
    metadataPromise = (async () => {
      const rows = new Map<string, ThreadSearchSummary>()
      const paths = new Map<string, string>()
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      do {
        const response = record(await dependencies.rpc('thread/list', {
          archived: false, limit: 200, sortKey: 'updated_at', modelProviders: [], cursor, useStateDbOnly: true,
        }))
        for (const value of Array.isArray(response.data) ? response.data : []) {
          const row = record(value)
          if (typeof row.id !== 'string' || !row.id) continue
          if (typeof row.path === 'string' && row.path) paths.set(row.id, row.path)
          rows.set(row.id, {
            id: row.id,
            name: typeof row.name === 'string' ? row.name : typeof row.title === 'string' ? row.title : '',
            preview: typeof row.preview === 'string' ? row.preview : '',
            cwd: typeof row.cwd === 'string' ? row.cwd : '',
            updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
            ...(row.source === undefined ? {} : { source: row.source }),
            ...(row.historyMode === undefined ? {} : { historyMode: row.historyMode }),
            ...(row.status === undefined ? {} : { status: row.status }),
          })
        }
        const next = typeof response.nextCursor === 'string' ? response.nextCursor : null
        if (next && seenCursors.has(next)) throw new Error('Conversation search pagination did not advance')
        if (next) seenCursors.add(next)
        if (seenCursors.size > 1_000) throw new Error('Conversation search pagination limit reached')
        cursor = next
      } while (cursor && !disposed)
      const titles = await dependencies.readTitles()
      if (disposed) return
      // An invalidation during the request must not make this snapshot fresh.
      summaries = Array.from(rows.values()).map(row => ({ ...row, name: titles[row.id] || row.name }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      rolloutPaths = paths
      loadedAt = startedGeneration === generation ? now() : -Infinity
      for (const [id, entry] of contents) {
        if (rows.get(id)?.updatedAt !== entry.updatedAt) contents.delete(id)
      }
    })().finally(() => { metadataPromise = null })
    return metadataPromise
  }

  const searchContent = (retry: boolean) => {
    const targets = summaries.slice(0, contentThreadLimit)
    const targetIds = new Set(targets.map(row => row.id))
    for (const id of contents.keys()) if (!targetIds.has(id)) contents.delete(id)
    const signature = JSON.stringify(targets.map(row => [row.id, row.updatedAt]))
    const hasExpired = targets.some(row => {
      const entry = contents.get(row.id)
      return !entry || entry.updatedAt !== row.updatedAt || now() - entry.fetchedAt >= contentTtlMs
    })
    if (contentPromise || activeContentRead || (signature === contentSignature && !retry && !hasExpired)) return
    // Errors remain visible until the user retries rather than restarting on every poll.
    if (!retry && signature === contentSignature && now() - contentAttemptedAt < contentTtlMs
      && (contentState === 'error' || contentState === 'partial')) return
    contentSignature = signature
    contentAttemptedAt = now()
    contentState = 'loading'
    searchedContentCount = 0
    skippedContentCount = 0
    const startedGeneration = generation
    contentPromise = (async () => {
      let used = 0
      let readBytes = 0
      let partial = false
      for (const row of targets) {
        if (disposed || generation !== startedGeneration) break
        if (now() - contentRequestedAt > 5_000) { contentState = 'idle'; return }
        let entry = contents.get(row.id)
        if (!entry || entry.updatedAt !== row.updatedAt || now() - entry.fetchedAt >= contentTtlMs) {
          // Check the native rollout before asking Codex to expand its whole
          // history into a JSON RPC message. Text truncation after RPC is too late
          // to protect foreground chat from a huge transcript or inline images.
          const path = rolloutPaths.get(row.id)
          const size = path ? await inspectRolloutSize(path).catch(() => null) : null
          if (disposed || generation !== startedGeneration) break
          if (size === null || !Number.isSafeInteger(size) || size < 0
            || size > contentRolloutByteLimit || readBytes + size > contentReadByteBudget) {
            skippedContentCount++
            partial = true
            continue
          }
          readBytes += size
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const pendingRead = dependencies.rpc('thread/read', { threadId: row.id, includeTurns: true })
            activeContentRead = pendingRead
            // A UI timeout cannot cancel Codex RPC. Keep the slot occupied until
            // the actual read settles, including while a user retries.
            void pendingRead.finally(() => {
              if (activeContentRead === pendingRead) activeContentRead = null
            }).catch(() => {})
            const response = await Promise.race([
              pendingRead,
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Conversation search timed out')), contentReadTimeoutMs); timer.unref?.() }),
            ])
            if (disposed || generation !== startedGeneration) break
            const extracted = extractSearchableThreadText(response, Math.min(contentCharacterLimit, Math.max(0, contentBudgetCharacters - used)))
            entry = { ...extracted, updatedAt: row.updatedAt, fetchedAt: now() }
            contents.delete(row.id)
            let cachedCharacters = Array.from(contents.values()).reduce((total, value) => total + value.text.length, 0)
            for (const [id, cached] of contents) {
              if (cachedCharacters + entry.text.length <= contentBudgetCharacters) break
              contents.delete(id)
              cachedCharacters -= cached.text.length
            }
            contents.set(row.id, entry)
          } catch {
            contentState = generation === startedGeneration ? 'error' : 'idle'
            return
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        used += entry.text.length
        partial ||= entry.partial
        searchedContentCount++
        if (used >= contentBudgetCharacters) {
          skippedContentCount += Math.max(0, targets.length - searchedContentCount - skippedContentCount)
          partial = skippedContentCount > 0 || partial
          break
        }
        // Yield between reads so foreground chat/list requests can run first.
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
      if (generation !== startedGeneration) { contentState = 'idle'; return }
      contentState = partial ? 'partial' : 'ready'
    })().finally(() => { contentPromise = null })
  }

  return {
    async search(query: string, limit = 200, options: { includeContent?: boolean; retryContent?: boolean } = {}): Promise<ThreadSearchResponse> {
      await loadMetadata()
      if (loadedAt === -Infinity && !disposed) await loadMetadata()
      const normalized = query.trim().toLowerCase()
      if (options.includeContent) {
        contentRequestedAt = now()
        searchContent(options.retryContent === true)
      }
      const matched = normalized ? summaries.filter(row => (
        row.name.toLowerCase().includes(normalized)
        || row.preview.toLowerCase().includes(normalized)
        || (options.includeContent && contents.get(row.id)?.updatedAt === row.updatedAt
          && now() - contents.get(row.id)!.fetchedAt < contentTtlMs && contents.get(row.id)?.text.includes(normalized))
      )).slice(0, Math.max(1, Math.min(1_000, limit))) : []
      return {
        threadIds: matched.map(row => row.id), threads: matched,
        indexedThreadCount: summaries.length,
        contentSearchState: options.includeContent ? contentState : 'idle',
        searchedContentCount: options.includeContent ? searchedContentCount : 0,
        skippedContentCount: options.includeContent ? skippedContentCount : 0,
        contentThreadCount: Math.min(contentThreadLimit, summaries.length),
      }
    },
    invalidate(threadId?: string) {
      generation++
      loadedAt = -Infinity
      contentSignature = ''
      contentState = 'idle'
      if (threadId) contents.delete(threadId)
    },
    dispose() {
      disposed = true
      generation++
      summaries = []
      contents.clear()
      rolloutPaths.clear()
    },
  }
}
