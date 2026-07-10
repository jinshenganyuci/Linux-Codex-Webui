import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReasoningEffort } from '../types/codex.js'

const STATE_VERSION = 1
const STATE_FILE_NAME = 'linux-codex-webui-thread-model-preferences.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])

export type ThreadModelPreference = {
  model: string
  reasoningEffort: ReasoningEffort
}

export type ThreadModelPreferenceState = Record<string, ThreadModelPreference>

type StoredThreadModelPreferenceState = {
  version: typeof STATE_VERSION
  preferences: ThreadModelPreferenceState
}

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
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeThreadModelPreference(value: unknown): ThreadModelPreference | null {
  const record = asRecord(value)
  const model = typeof record?.model === 'string' ? record.model.trim() : ''
  const reasoningEffort = typeof record?.reasoningEffort === 'string'
    ? record.reasoningEffort.trim().toLowerCase() as ReasoningEffort
    : null
  if (!model || !reasoningEffort || !REASONING_EFFORTS.has(reasoningEffort)) return null
  return { model, reasoningEffort }
}

export function normalizeThreadModelPreferenceState(value: unknown): ThreadModelPreferenceState {
  const record = asRecord(value)
  const preferencesRecord = asRecord(record?.preferences) ?? record
  if (!preferencesRecord) return {}

  const preferences: ThreadModelPreferenceState = {}
  for (const [rawThreadId, rawPreference] of Object.entries(preferencesRecord)) {
    if (rawThreadId === 'version') continue
    const threadId = normalizeThreadId(rawThreadId)
    const preference = normalizeThreadModelPreference(rawPreference)
    if (threadId && preference) {
      preferences[threadId] = preference
    }
  }
  return preferences
}

export function getThreadModelPreferencesPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome || join(homedir(), '.codex')
  return join(codexHome, STATE_FILE_NAME)
}

async function readStoredState(statePath: string): Promise<StoredThreadModelPreferenceState> {
  try {
    const raw = await readFile(statePath, 'utf8')
    return {
      version: STATE_VERSION,
      preferences: normalizeThreadModelPreferenceState(JSON.parse(raw) as unknown),
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return { version: STATE_VERSION, preferences: {} }
    }
    if (error instanceof SyntaxError) {
      return { version: STATE_VERSION, preferences: {} }
    }
    throw error
  }
}

async function recoverCorruptStateFile(statePath: string): Promise<void> {
  try {
    const raw = await readFile(statePath, 'utf8')
    JSON.parse(raw)
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return
    if (!(error instanceof SyntaxError)) throw error
    await rename(statePath, `${statePath}.corrupt-${Date.now()}-${randomUUID()}`)
  }
}

async function writeStoredStateAtomic(
  statePath: string,
  preferences: ThreadModelPreferenceState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  const payload: StoredThreadModelPreferenceState = {
    version: STATE_VERSION,
    preferences: normalizeThreadModelPreferenceState(preferences),
  }
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
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
      throw new Error('Timed out waiting for the thread model preference lock')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

async function mutateThreadModelPreferences<T>(
  update: (state: ThreadModelPreferenceState) => { state: ThreadModelPreferenceState; result: T },
): Promise<T> {
  const run = mutationChain.then(async () => {
    const statePath = getThreadModelPreferencesPath()
    const releaseLock = await acquireFileLock(statePath)
    try {
      await recoverCorruptStateFile(statePath)
      const current = (await readStoredState(statePath)).preferences
      const { state: next, result } = update(current)
      await writeStoredStateAtomic(statePath, next)
      return result
    } finally {
      await releaseLock()
    }
  })
  mutationChain = run.catch(() => {})
  return run
}

export async function readThreadModelPreferences(): Promise<ThreadModelPreferenceState> {
  const state = await readStoredState(getThreadModelPreferencesPath())
  return { ...state.preferences }
}

export async function writeThreadModelPreference(
  threadIdInput: unknown,
  preferenceInput: unknown,
): Promise<ThreadModelPreference> {
  const threadId = normalizeThreadId(threadIdInput)
  const preference = normalizeThreadModelPreference(preferenceInput)
  if (!threadId) throw new Error('Missing threadId')
  if (!preference) throw new Error('Invalid thread model preference')

  return await mutateThreadModelPreferences((current) => ({
    state: {
      ...current,
      [threadId]: preference,
    },
    result: preference,
  }))
}

export async function deleteThreadModelPreference(threadIdInput: unknown): Promise<void> {
  const threadId = normalizeThreadId(threadIdInput)
  if (!threadId) throw new Error('Missing threadId')

  await mutateThreadModelPreferences((current) => {
    if (!(threadId in current)) return { state: current, result: undefined }
    const next = { ...current }
    delete next[threadId]
    return { state: next, result: undefined }
  })
}

export async function listThreadModelPreferenceRecoveryFiles(): Promise<string[]> {
  const statePath = getThreadModelPreferencesPath()
  const prefix = `${STATE_FILE_NAME}.corrupt-`
  try {
    return (await readdir(dirname(statePath))).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
