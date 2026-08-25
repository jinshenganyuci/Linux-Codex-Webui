import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  normalizeRequestUserInputHistoryState,
  normalizeRequestUserInputSummary,
  upsertRequestUserInputSummary,
} from '../requestUserInputHistory.js'
import type { UiRequestUserInputHistoryState, UiRequestUserInputSummary } from '../types/codex.js'

const STATE_VERSION = 1
const STATE_FILE_NAME = 'linux-codex-webui-request-user-input-history.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000

type StoredRequestUserInputHistoryState = {
  version: typeof STATE_VERSION
  threads: UiRequestUserInputHistoryState
}

let mutationChain: Promise<unknown> = Promise.resolve()

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function normalizeThreadId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function getRequestUserInputHistoryPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome || join(homedir(), '.codex')
  return join(codexHome, STATE_FILE_NAME)
}

async function readStoredState(statePath: string): Promise<StoredRequestUserInputHistoryState> {
  try {
    const raw = await readFile(statePath, 'utf8')
    return {
      version: STATE_VERSION,
      threads: normalizeRequestUserInputHistoryState(JSON.parse(raw) as unknown),
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return { version: STATE_VERSION, threads: {} }
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
  threads: UiRequestUserInputHistoryState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  const payload: StoredRequestUserInputHistoryState = {
    version: STATE_VERSION,
    threads: normalizeRequestUserInputHistoryState(threads),
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
      throw new Error('Timed out waiting for the request user input history lock')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

async function mutateRequestUserInputHistory<T>(
  update: (state: UiRequestUserInputHistoryState) => { state: UiRequestUserInputHistoryState; result: T },
): Promise<T> {
  const run = mutationChain.then(async () => {
    const statePath = getRequestUserInputHistoryPath()
    const releaseLock = await acquireFileLock(statePath)
    try {
      await recoverCorruptStateFile(statePath)
      const current = (await readStoredState(statePath)).threads
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

export async function readRequestUserInputHistory(threadIdInput?: unknown): Promise<UiRequestUserInputHistoryState> {
  const threads = (await readStoredState(getRequestUserInputHistoryPath())).threads
  const threadId = normalizeThreadId(threadIdInput)
  if (!threadId) return threads
  return threads[threadId] ? { [threadId]: [...threads[threadId]] } : {}
}

export async function writeRequestUserInputSummary(input: unknown): Promise<UiRequestUserInputSummary> {
  const summary = normalizeRequestUserInputSummary(input)
  if (!summary) throw new Error('Invalid request user input summary')

  return await mutateRequestUserInputHistory((current) => {
    const next = {
      ...current,
      [summary.threadId]: upsertRequestUserInputSummary(current[summary.threadId] ?? [], summary),
    }
    return {
      state: normalizeRequestUserInputHistoryState(next),
      result: summary,
    }
  })
}

export async function deleteRequestUserInputHistory(threadIdInput: unknown): Promise<void> {
  const threadId = normalizeThreadId(threadIdInput)
  if (!threadId) throw new Error('Missing threadId')
  await mutateRequestUserInputHistory((current) => {
    if (!(threadId in current)) return { state: current, result: undefined }
    const next = { ...current }
    delete next[threadId]
    return { state: next, result: undefined }
  })
}

export async function listRequestUserInputHistoryRecoveryFiles(): Promise<string[]> {
  const statePath = getRequestUserInputHistoryPath()
  const prefix = `${STATE_FILE_NAME}.corrupt-`
  try {
    return (await readdir(dirname(statePath))).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
