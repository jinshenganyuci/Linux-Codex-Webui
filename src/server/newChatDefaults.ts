import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReasoningEffort } from '../types/codex.js'

const STATE_VERSION = 1
const STATE_FILE_NAME = 'linux-codex-webui-new-chat-defaults.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000
const MAX_PROVIDER_DEFAULTS = 64

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

export type NewChatDefaultPreference = {
  model?: string
  reasoningEffort?: ReasoningEffort
}

export type NewChatDefaultState = {
  version: typeof STATE_VERSION
  revision: number
  providers: Record<string, NewChatDefaultPreference>
}

export type NewChatDefaultPatch = {
  providerId: string
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
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

export function normalizeNewChatDefaultProviderId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase().replace(/_/gu, '-')
  if (!normalized || normalized.length > 128) return ''
  return normalized === 'openai' ? 'codex' : normalized
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length <= 256 ? normalized : ''
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase() as ReasoningEffort
  return REASONING_EFFORTS.has(normalized) ? normalized : null
}

export function normalizeNewChatDefaultPreference(value: unknown): NewChatDefaultPreference | null {
  const record = asRecord(value)
  if (!record) return null
  const preference: NewChatDefaultPreference = {}
  const model = normalizeModel(record.model)
  const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort)
  if (model) preference.model = model
  if (reasoningEffort) preference.reasoningEffort = reasoningEffort
  return Object.keys(preference).length > 0 ? preference : null
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function normalizeNewChatDefaultState(value: unknown): NewChatDefaultState {
  const record = asRecord(value)
  const rawProviders = asRecord(record?.providers)
  const providers: Record<string, NewChatDefaultPreference> = {}
  if (rawProviders) {
    for (const [rawProviderId, rawPreference] of Object.entries(rawProviders)) {
      if (Object.keys(providers).length >= MAX_PROVIDER_DEFAULTS) break
      const providerId = normalizeNewChatDefaultProviderId(rawProviderId)
      const preference = normalizeNewChatDefaultPreference(rawPreference)
      if (providerId && preference) providers[providerId] = preference
    }
  }
  return {
    version: STATE_VERSION,
    revision: normalizeRevision(record?.revision),
    providers,
  }
}

export function normalizeNewChatDefaultPatch(value: unknown): NewChatDefaultPatch | null {
  const record = asRecord(value)
  const providerId = normalizeNewChatDefaultProviderId(record?.providerId)
  if (!record || !providerId) return null
  const hasModel = Object.prototype.hasOwnProperty.call(record, 'model')
  const hasReasoningEffort = Object.prototype.hasOwnProperty.call(record, 'reasoningEffort')
  if (!hasModel && !hasReasoningEffort) return null

  const patch: NewChatDefaultPatch = { providerId }
  if (hasModel) {
    if (record.model === null) patch.model = null
    else {
      const model = normalizeModel(record.model)
      if (!model) return null
      patch.model = model
    }
  }
  if (hasReasoningEffort) {
    if (record.reasoningEffort === null) patch.reasoningEffort = null
    else {
      const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort)
      if (!reasoningEffort) return null
      patch.reasoningEffort = reasoningEffort
    }
  }
  return patch
}

export function getNewChatDefaultsPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome || join(homedir(), '.codex')
  return join(codexHome, STATE_FILE_NAME)
}

async function readStoredState(statePath: string): Promise<NewChatDefaultState> {
  try {
    return normalizeNewChatDefaultState(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return { version: STATE_VERSION, revision: 0, providers: {} }
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

async function writeStoredStateAtomic(statePath: string, state: NewChatDefaultState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  const payload = normalizeNewChatDefaultState(state)
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
      throw new Error('Timed out waiting for the new chat default lock')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

function preferencesEqual(
  first: NewChatDefaultPreference | undefined,
  second: NewChatDefaultPreference | undefined,
): boolean {
  return first?.model === second?.model && first?.reasoningEffort === second?.reasoningEffort
}

async function mutateNewChatDefaults(patch: NewChatDefaultPatch): Promise<NewChatDefaultState> {
  const run = mutationChain.then(async () => {
    const statePath = getNewChatDefaultsPath()
    const releaseLock = await acquireFileLock(statePath)
    try {
      await recoverCorruptStateFile(statePath)
      const current = await readStoredState(statePath)
      const existing = current.providers[patch.providerId]
      const nextPreference: NewChatDefaultPreference = { ...(existing ?? {}) }
      if (patch.model === null) delete nextPreference.model
      else if (patch.model !== undefined) nextPreference.model = patch.model
      if (patch.reasoningEffort === null) delete nextPreference.reasoningEffort
      else if (patch.reasoningEffort !== undefined) nextPreference.reasoningEffort = patch.reasoningEffort
      const normalizedPreference = normalizeNewChatDefaultPreference(nextPreference) ?? undefined
      if (preferencesEqual(existing, normalizedPreference)) return current

      const providers = { ...current.providers }
      if (normalizedPreference) providers[patch.providerId] = normalizedPreference
      else delete providers[patch.providerId]
      const next: NewChatDefaultState = {
        version: STATE_VERSION,
        revision: current.revision + 1,
        providers,
      }
      await writeStoredStateAtomic(statePath, next)
      return next
    } finally {
      await releaseLock()
    }
  })
  mutationChain = run.catch(() => {})
  return run
}

export async function readNewChatDefaults(): Promise<NewChatDefaultState> {
  const state = await readStoredState(getNewChatDefaultsPath())
  return {
    ...state,
    providers: Object.fromEntries(
      Object.entries(state.providers).map(([providerId, preference]) => [providerId, { ...preference }]),
    ),
  }
}

export async function patchNewChatDefaults(patchInput: unknown): Promise<NewChatDefaultState> {
  const patch = normalizeNewChatDefaultPatch(patchInput)
  if (!patch) throw new Error('Invalid new chat default patch')
  return await mutateNewChatDefaults(patch)
}

export async function listNewChatDefaultRecoveryFiles(): Promise<string[]> {
  const statePath = getNewChatDefaultsPath()
  const prefix = `${STATE_FILE_NAME}.corrupt-`
  try {
    return (await readdir(dirname(statePath))).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
