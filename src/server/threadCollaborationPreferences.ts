import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1
const STATE_FILE_NAME = 'linux-codex-webui-thread-collaboration-preferences.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000
const MAX_THREAD_PREFERENCES = 2_000

export type ThreadCollaborationPreferences = {
  version: typeof STATE_VERSION
  revision: number
  persisted: boolean
  modes: Record<string, 'plan'>
}

export type ThreadCollaborationPreferencesPatch = {
  initializeOnly?: boolean
  modes?: Record<string, 'plan' | 'default'>
}

type StoredThreadCollaborationPreferences = Omit<ThreadCollaborationPreferences, 'persisted'>
type StoredReadResult = { state: StoredThreadCollaborationPreferences; persisted: boolean }

let mutationChain: Promise<unknown> = Promise.resolve()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function normalizeThreadId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized && normalized.length <= 512 ? normalized : ''
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeModes(value: unknown): Record<string, 'plan'> {
  const record = asRecord(value)
  if (!record) return {}
  const modes: Record<string, 'plan'> = {}
  let count = 0
  for (const [rawThreadId, rawMode] of Object.entries(record)) {
    if (count >= MAX_THREAD_PREFERENCES) break
    const threadId = normalizeThreadId(rawThreadId)
    if (threadId && rawMode === 'plan') {
      modes[threadId] = 'plan'
      count += 1
    }
  }
  return modes
}

function defaultStoredState(): StoredThreadCollaborationPreferences {
  return { version: STATE_VERSION, revision: 0, modes: {} }
}

export function normalizeThreadCollaborationPreferences(value: unknown): StoredThreadCollaborationPreferences {
  const record = asRecord(value)
  return {
    version: STATE_VERSION,
    revision: normalizeRevision(record?.revision),
    modes: normalizeModes(record?.modes),
  }
}

export function normalizeThreadCollaborationPreferencesPatch(
  value: unknown,
): ThreadCollaborationPreferencesPatch | null {
  const record = asRecord(value)
  if (!record) return null
  const patch: ThreadCollaborationPreferencesPatch = {}
  if (record.initializeOnly === true) patch.initializeOnly = true
  if (record.modes !== undefined) {
    const rawModes = asRecord(record.modes)
    if (!rawModes || Object.keys(rawModes).length > MAX_THREAD_PREFERENCES) return null
    const modes: Record<string, 'plan' | 'default'> = {}
    for (const [rawThreadId, rawMode] of Object.entries(rawModes)) {
      const threadId = normalizeThreadId(rawThreadId)
      if (!threadId || (rawMode !== 'plan' && rawMode !== 'default')) return null
      modes[threadId] = rawMode
    }
    patch.modes = modes
  }
  if (!patch.modes && patch.initializeOnly !== true) return null
  return patch
}

export function getThreadCollaborationPreferencesPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome || join(homedir(), '.codex')
  return join(codexHome, STATE_FILE_NAME)
}

async function readStoredState(statePath: string): Promise<StoredReadResult> {
  try {
    return {
      state: normalizeThreadCollaborationPreferences(JSON.parse(await readFile(statePath, 'utf8')) as unknown),
      persisted: true,
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return { state: defaultStoredState(), persisted: false }
    }
    throw error
  }
}

async function recoverCorruptStateFile(statePath: string): Promise<void> {
  try {
    JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return
    if (!(error instanceof SyntaxError)) throw error
    await rename(statePath, `${statePath}.corrupt-${Date.now()}-${randomUUID()}`)
  }
}

async function writeStoredStateAtomic(
  statePath: string,
  state: StoredThreadCollaborationPreferences,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalizeThreadCollaborationPreferences(state), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, statePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function acquireFileLock(statePath: string): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`
  await mkdir(dirname(statePath), { recursive: true })
  const startedAt = Date.now()
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8')
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
      return async () => {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error
    }

    try {
      const lockStats = await stat(lockPath)
      let ownerIsAlive = true
      try {
        const ownerPid = Number.parseInt((await readFile(lockPath, 'utf8')).split(/\s+/u)[0] ?? '', 10)
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0)
          } catch (error) {
            ownerIsAlive = !isNodeErrorWithCode(error, 'ESRCH')
          }
        }
      } catch {
        ownerIsAlive = false
      }
      if (!ownerIsAlive || Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true })
        continue
      }
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) continue
      throw error
    }

    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error('Timed out waiting for the thread collaboration preference lock')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

function toPublicPreferences(
  state: StoredThreadCollaborationPreferences,
  persisted: boolean,
): ThreadCollaborationPreferences {
  return { ...state, modes: { ...state.modes }, persisted }
}

async function mutateThreadCollaborationPreferences(
  patch: ThreadCollaborationPreferencesPatch,
): Promise<{ applied: boolean; preferences: ThreadCollaborationPreferences }> {
  const run = mutationChain.then(async () => {
    const statePath = getThreadCollaborationPreferencesPath()
    const releaseLock = await acquireFileLock(statePath)
    try {
      await recoverCorruptStateFile(statePath)
      const current = await readStoredState(statePath)
      if (patch.initializeOnly === true && current.persisted) {
        return { applied: false, preferences: toPublicPreferences(current.state, true) }
      }
      if (
        patch.initializeOnly === true
        && !current.persisted
        && Object.keys(patch.modes ?? {}).length === 0
      ) {
        return { applied: false, preferences: toPublicPreferences(current.state, false) }
      }
      const nextModes = { ...current.state.modes }
      for (const [threadId, mode] of Object.entries(patch.modes ?? {})) {
        if (mode === 'plan') {
          if (!(threadId in nextModes) && Object.keys(nextModes).length >= MAX_THREAD_PREFERENCES) {
            const oldestThreadId = Object.keys(nextModes)[0]
            if (oldestThreadId) delete nextModes[oldestThreadId]
          }
          nextModes[threadId] = 'plan'
        } else {
          delete nextModes[threadId]
        }
      }
      const normalizedModes = normalizeModes(nextModes)
      const changed = JSON.stringify(current.state.modes) !== JSON.stringify(normalizedModes) || !current.persisted
      if (!changed) return { applied: true, preferences: toPublicPreferences(current.state, true) }
      const next: StoredThreadCollaborationPreferences = {
        version: STATE_VERSION,
        revision: current.state.revision + 1,
        modes: normalizedModes,
      }
      await writeStoredStateAtomic(statePath, next)
      return { applied: true, preferences: toPublicPreferences(next, true) }
    } finally {
      await releaseLock()
    }
  })
  mutationChain = run.catch(() => {})
  return run
}

export async function readThreadCollaborationPreferences(): Promise<ThreadCollaborationPreferences> {
  const current = await readStoredState(getThreadCollaborationPreferencesPath())
  return toPublicPreferences(current.state, current.persisted)
}

export async function patchThreadCollaborationPreferences(
  patchInput: unknown,
): Promise<{ applied: boolean; preferences: ThreadCollaborationPreferences }> {
  const patch = normalizeThreadCollaborationPreferencesPatch(patchInput)
  if (!patch) throw new Error('Invalid thread collaboration preference patch')
  return await mutateThreadCollaborationPreferences(patch)
}

export async function deleteThreadCollaborationPreference(threadIdInput: unknown): Promise<void> {
  const threadId = normalizeThreadId(threadIdInput)
  if (!threadId) throw new Error('Missing threadId')
  await mutateThreadCollaborationPreferences({ modes: { [threadId]: 'default' } })
}

export async function listThreadCollaborationPreferenceRecoveryFiles(): Promise<string[]> {
  const statePath = getThreadCollaborationPreferencesPath()
  const prefix = `${STATE_FILE_NAME}.corrupt-`
  try {
    return (await readdir(dirname(statePath))).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
