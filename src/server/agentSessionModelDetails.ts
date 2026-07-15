import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AgentSessionModelDetails = {
  threadId: string
  model: string
  reasoningEffort: string
}

const SESSION_PREFIX_LIMIT_BYTES = 512 * 1024
const SESSION_READ_CONCURRENCY = 8
const UUID_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SESSION_FILE_THREAD_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getCodexHomeDir(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  return configuredHome || join(homedir(), '.codex')
}

function sessionDateDirectories(threadId: string, codexHome: string): string[] {
  if (!UUID_THREAD_ID_PATTERN.test(threadId)) return []
  const timestampMs = Number.parseInt(threadId.replace(/-/gu, '').slice(0, 12), 16)
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return []

  const directories = new Set<string>()
  for (const dayOffset of [-1, 0, 1]) {
    const date = new Date(timestampMs + dayOffset * 24 * 60 * 60 * 1000)
    const localParts = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    const utcParts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    for (const [year, month, day] of [localParts, utcParts]) {
      directories.add(join(
        codexHome,
        'sessions',
        String(year),
        String(month).padStart(2, '0'),
        String(day).padStart(2, '0'),
      ))
    }
  }
  return Array.from(directories)
}

async function readSessionPrefix(sessionPath: string): Promise<string> {
  const handle = await open(sessionPath, 'r')
  try {
    const info = await handle.stat()
    const byteLength = Math.min(Math.max(0, info.size), SESSION_PREFIX_LIMIT_BYTES)
    if (byteLength === 0) return ''
    const buffer = Buffer.allocUnsafe(byteLength)
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function parseAgentSessionModelDetails(sessionPrefix: string): Omit<AgentSessionModelDetails, 'threadId'> | null {
  let fallbackModel = ''
  for (const line of sessionPrefix.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = asRecord(row.payload)
    if (!payload) continue
    if (row.type === 'session_meta') {
      fallbackModel = readString(payload.model) || fallbackModel
      continue
    }
    if (row.type !== 'turn_context') continue

    const collaborationMode = asRecord(payload.collaboration_mode) ?? asRecord(payload.collaborationMode)
    const collaborationSettings = asRecord(collaborationMode?.settings)
    const model = readString(payload.model) || readString(collaborationSettings?.model) || fallbackModel
    const reasoningEffort = readString(payload.effort)
      || readString(payload.reasoning_effort)
      || readString(payload.reasoningEffort)
      || readString(collaborationSettings?.reasoning_effort)
      || readString(collaborationSettings?.reasoningEffort)
    if (model) return { model, reasoningEffort }
  }
  return fallbackModel ? { model: fallbackModel, reasoningEffort: '' } : null
}

export async function readAgentSessionModelDetails(
  threadIds: string[],
  knownSessionPaths: ReadonlyMap<string, string> = new Map(),
  codexHome = getCodexHomeDir(),
): Promise<AgentSessionModelDetails[]> {
  const requestedIds = Array.from(new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)))
  if (requestedIds.length === 0) return []

  const canonicalIdByLowercase = new Map(requestedIds.map((threadId) => [threadId.toLowerCase(), threadId]))
  const sessionPathByThreadId = new Map<string, string>()
  for (const threadId of requestedIds) {
    const knownPath = knownSessionPaths.get(threadId)?.trim()
    if (knownPath) sessionPathByThreadId.set(threadId, knownPath)
  }

  const unresolvedIds = requestedIds.filter((threadId) => !sessionPathByThreadId.has(threadId))
  const candidateDirectories = new Set<string>()
  for (const threadId of unresolvedIds) {
    for (const directory of sessionDateDirectories(threadId, codexHome)) candidateDirectories.add(directory)
  }
  for (const directory of candidateDirectories) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fileThreadId = entry.name.match(SESSION_FILE_THREAD_ID_PATTERN)?.[1]?.toLowerCase()
      const requestedThreadId = fileThreadId ? canonicalIdByLowercase.get(fileThreadId) : undefined
      if (!requestedThreadId || sessionPathByThreadId.has(requestedThreadId)) continue
      sessionPathByThreadId.set(requestedThreadId, join(directory, entry.name))
    }
  }

  const rows = Array.from(sessionPathByThreadId.entries())
  const details: AgentSessionModelDetails[] = []
  for (let index = 0; index < rows.length; index += SESSION_READ_CONCURRENCY) {
    const chunk = rows.slice(index, index + SESSION_READ_CONCURRENCY)
    const resolved = await Promise.all(chunk.map(async ([threadId, sessionPath]) => {
      try {
        const parsed = parseAgentSessionModelDetails(await readSessionPrefix(sessionPath))
        return parsed ? { threadId, ...parsed } : null
      } catch {
        return null
      }
    }))
    details.push(...resolved.filter((row): row is AgentSessionModelDetails => row !== null))
  }
  return details
}
