import { normalizePathForUi } from '../pathUtils.js'
import { fetchWithTimeout, requestWithTimeout } from './requestClient'

export type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
  projectOrder: string[]
  remoteProjects?: Array<{
    id: string
    hostId: string
    remotePath: string
    label: string
  }>
}

export type ComposerFileSuggestion = {
  path: string
}

export type ThreadSearchResult = {
  threadIds: string[]
  indexedThreadCount: number
}

export type LocalDirectoryEntry = {
  name: string
  path: string
}

export type LocalDirectoryListing = {
  path: string
  parentPath: string
  entries: LocalDirectoryEntry[]
}

let workspaceRootsStatePromise: Promise<WorkspaceRootsState> | null = null
let cachedWorkspaceRootsState: WorkspaceRootsState | null = null

function normalizeWorkspaceRootsState(payload: unknown): WorkspaceRootsState {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}

  const normalizeArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const next: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0 && !next.includes(item)) {
        next.push(item)
      }
    }
    return next
  }

  const labelsRaw = record.labels
  const labels: Record<string, string> = {}
  if (labelsRaw && typeof labelsRaw === 'object' && !Array.isArray(labelsRaw)) {
    for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
      const normalizedKey = typeof key === 'string' ? normalizePathForUi(key) : ''
      if (normalizedKey.length > 0 && typeof value === 'string') {
        labels[normalizedKey] = value
      }
    }
  }

  return {
    order: normalizeArray(record.order).map((value) => normalizePathForUi(value)),
    labels,
    active: normalizeArray(record.active).map((value) => normalizePathForUi(value)),
    projectOrder: normalizeArray(record.projectOrder).map((value) => normalizePathForUi(value)),
    remoteProjects: Array.isArray(record.remoteProjects)
      ? record.remoteProjects.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const remote = item as Record<string, unknown>
        const id = typeof remote.id === 'string' ? remote.id.trim() : ''
        if (!id) return []
        return [{
          id,
          hostId: typeof remote.hostId === 'string' ? remote.hostId.trim() : '',
          remotePath: typeof remote.remotePath === 'string' ? normalizePathForUi(remote.remotePath) : '',
          label: typeof remote.label === 'string' ? remote.label.trim() : '',
        }]
      })
      : [],
  }
}

function cloneWorkspaceRootsState(state: WorkspaceRootsState): WorkspaceRootsState {
  return {
    order: [...state.order],
    labels: { ...state.labels },
    active: [...state.active],
    projectOrder: [...state.projectOrder],
    remoteProjects: state.remoteProjects?.map((item) => ({ ...item })) ?? [],
  }
}

function invalidateWorkspaceRootsStateCache(): void {
  cachedWorkspaceRootsState = null
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const message = record.message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message
  }
  const error = record.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`Expected JSON response from ${response.url || 'request'}`)
  }
}

export async function getWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  if (cachedWorkspaceRootsState) {
    return cloneWorkspaceRootsState(cachedWorkspaceRootsState)
  }
  if (!workspaceRootsStatePromise) {
    workspaceRootsStatePromise = fetchWorkspaceRootsState()
      .then((state) => {
        cachedWorkspaceRootsState = state
        return state
      })
      .finally(() => {
        workspaceRootsStatePromise = null
      })
  }
  return cloneWorkspaceRootsState(await workspaceRootsStatePromise)
}

async function fetchWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const response = await fetchWithTimeout('/codex-api/workspace-roots-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load workspace roots state')
  }
  const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  return normalizeWorkspaceRootsState(envelope.data)
}

export async function getHomeDirectory(): Promise<string> {
  const response = await fetchWithTimeout('/codex-api/home-directory')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load home directory')
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  return typeof data.path === 'string' ? data.path.trim() : ''
}

export async function listLocalDirectories(path: string, options?: { showHidden?: boolean }): Promise<LocalDirectoryListing> {
  const query = new URLSearchParams({ path })
  if (options?.showHidden === true) {
    query.set('showHidden', '1')
  }
  const response = await fetchWithTimeout(`/codex-local-directories?${query.toString()}`)
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load local directories'))
  }

  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  const entriesRaw = Array.isArray(data.entries) ? data.entries : []

  return {
    path: typeof data.path === 'string' ? normalizePathForUi(data.path) : '',
    parentPath: typeof data.parentPath === 'string' ? normalizePathForUi(data.parentPath) : '',
    entries: entriesRaw.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const entry = item as Record<string, unknown>
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      const entryPath = typeof entry.path === 'string' ? normalizePathForUi(entry.path) : ''
      return name && entryPath ? [{ name, path: entryPath }] : []
    }),
  }
}

export async function setWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const response = await fetchWithTimeout('/codex-api/workspace-roots-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  if (!response.ok) {
    throw new Error('Failed to save workspace roots state')
  }
  cachedWorkspaceRootsState = cloneWorkspaceRootsState(nextState)
}

export async function openProjectRoot(path: string, options?: { createIfMissing?: boolean; label?: string }): Promise<string> {
  const response = await fetchWithTimeout('/codex-api/project-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      createIfMissing: options?.createIfMissing === true,
      label: options?.label ?? '',
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to open project root'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  invalidateWorkspaceRootsStateCache()
  return normalizedPath
}

export function getProjectZipDownloadUrl(cwd: string): string {
  const query = new URLSearchParams({ cwd })
  return `/codex-api/project-zip?${query.toString()}`
}

function readDownloadFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/iu)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/iu)
  return plainMatch?.[1]?.trim() || fallback
}

export async function downloadProjectZip(
  cwd: string,
  onProgress?: (progress: { loaded: number; total: number | null }) => void,
): Promise<{ blob: Blob; fileName: string }> {
  const { value } = await requestWithTimeout(getProjectZipDownloadUrl(cwd), undefined, async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      const fallback = 'Failed to export project'
      const payloadMessage = getErrorMessageFromPayload(payload, fallback)
      const statusLabel = [response.status ? String(response.status) : '', response.statusText].filter(Boolean).join(' ')
      const message = payloadMessage !== fallback
        ? payloadMessage
        : statusLabel ? `Failed to export project: ${statusLabel}` : fallback
      throw new Error(message)
    }

    const totalHeader = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null
    const fileName = readDownloadFileName(response, 'project.zip')
    const reader = response.body?.getReader()
    if (!reader) {
      const blob = await response.blob()
      onProgress?.({ loaded: blob.size, total: blob.size || total })
      return { blob, fileName }
    }

    const chunks: Uint8Array[] = []
    let loaded = 0
    onProgress?.({ loaded, total })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(new Uint8Array(value))
        loaded += value.byteLength
        onProgress?.({ loaded, total })
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    }

    const blobParts = chunks.map((chunk) => {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      return copy.buffer
    })
    return { blob: new Blob(blobParts, { type: response.headers.get('content-type') ?? 'application/zip' }), fileName }
  }, { timeout: 'long', operation: 'project-zip' })
  return value
}

export async function importProjectZip(file: Blob, parent: string): Promise<{ path: string; importedSessions: number }> {
  const query = new URLSearchParams({ parent })
  const response = await fetchWithTimeout(`/codex-api/project-import?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  }, { timeout: 'long', operation: 'project-import' })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to import project'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  if (normalizedPath) {
    invalidateWorkspaceRootsStateCache()
  }
  return {
    path: normalizedPath,
    importedSessions: typeof data.importedSessions === 'number' ? data.importedSessions : 0,
  }
}

export async function createLocalDirectory(path: string): Promise<string> {
  const response = await fetchWithTimeout('/codex-api/local-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to create local directory'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  if (normalizedPath) {
    invalidateWorkspaceRootsStateCache()
  }
  return normalizedPath
}

export async function cloneGithubRepository(url: string, basePath: string): Promise<string> {
  const response = await fetchWithTimeout('/codex-api/github-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, basePath }),
  }, { timeout: 'long', operation: 'github-clone' })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to clone GitHub repository'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  return typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
}

export async function createProjectlessThreadDirectory(prompt?: string): Promise<{ cwd: string; outputDirectory: string; workspaceRoot: string }> {
  const response = await fetchWithTimeout('/codex-api/projectless-thread-cwd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt ?? null }),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to create new chat folder'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  const cwd = typeof data.cwd === 'string' ? normalizePathForUi(data.cwd) : ''
  if (!cwd) {
    throw new Error('Failed to create new chat folder')
  }
  return {
    cwd,
    outputDirectory: typeof data.outputDirectory === 'string' ? normalizePathForUi(data.outputDirectory) : cwd,
    workspaceRoot: typeof data.workspaceRoot === 'string' ? normalizePathForUi(data.workspaceRoot) : '',
  }
}

export async function getProjectRootSuggestion(basePath: string): Promise<{ name: string; path: string }> {
  const query = new URLSearchParams({ basePath })
  const response = await fetchWithTimeout(`/codex-api/project-root-suggestion?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to suggest project name'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {}
  return {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    path: typeof data.path === 'string' ? normalizePathForUi(data.path) : '',
  }
}

export async function searchComposerFiles(cwd: string, query: string, limit = 20): Promise<ComposerFileSuggestion[]> {
  const trimmedCwd = cwd.trim()
  if (!trimmedCwd) return []
  const response = await fetchWithTimeout('/codex-api/composer-file-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: trimmedCwd,
      query: query.trim(),
      limit,
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to search files'))
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const data = Array.isArray(record.data) ? record.data : []
  const suggestions: ComposerFileSuggestion[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const rawPath = row.path
    const value = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (!value) continue
    suggestions.push({ path: value })
  }
  return suggestions
}

export async function searchThreads(query: string, limit = 200): Promise<ThreadSearchResult> {
  const response = await fetchWithTimeout('/codex-api/thread-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  })
  const payload = (await response.json()) as { data?: ThreadSearchResult; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to search threads')
  }
  return payload.data ?? { threadIds: [], indexedThreadCount: 0 }
}
