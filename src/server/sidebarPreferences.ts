import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1
const STATE_FILE_NAME = 'linux-codex-webui-sidebar-preferences.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000
const MAX_PROJECT_PREFERENCES = 2_000

export type SidebarSectionPreferences = {
  pinned: boolean
  chats: boolean
  projects: boolean
}

export type SidebarPreferences = {
  version: typeof STATE_VERSION
  revision: number
  persisted: boolean
  sections: SidebarSectionPreferences
  collapsedProjects: Record<string, true>
}

export type SidebarPreferencesPatch = {
  initializeOnly?: boolean
  sections?: Partial<SidebarSectionPreferences>
  collapsedProjects?: Record<string, boolean>
}

type StoredSidebarPreferences = Omit<SidebarPreferences, 'persisted'>

type StoredSidebarPreferencesReadResult = {
  state: StoredSidebarPreferences
  persisted: boolean
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

function defaultStoredState(): StoredSidebarPreferences {
  return {
    version: STATE_VERSION,
    revision: 0,
    sections: {
      pinned: true,
      chats: true,
      projects: true,
    },
    collapsedProjects: {},
  }
}

function normalizeProjectKey(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length <= 4_096 ? normalized : ''
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeSections(value: unknown): SidebarSectionPreferences {
  const record = asRecord(value)
  return {
    pinned: typeof record?.pinned === 'boolean' ? record.pinned : true,
    chats: typeof record?.chats === 'boolean' ? record.chats : true,
    projects: typeof record?.projects === 'boolean' ? record.projects : true,
  }
}

function normalizeCollapsedProjects(value: unknown): Record<string, true> {
  const record = asRecord(value)
  if (!record) return {}

  const collapsedProjects: Record<string, true> = {}
  let count = 0
  for (const [rawProjectKey, collapsed] of Object.entries(record)) {
    if (count >= MAX_PROJECT_PREFERENCES) break
    const projectKey = normalizeProjectKey(rawProjectKey)
    if (projectKey && collapsed === true) {
      collapsedProjects[projectKey] = true
      count += 1
    }
  }
  return collapsedProjects
}

export function normalizeSidebarPreferences(value: unknown): StoredSidebarPreferences {
  const record = asRecord(value)
  return {
    version: STATE_VERSION,
    revision: normalizeRevision(record?.revision),
    sections: normalizeSections(record?.sections),
    collapsedProjects: normalizeCollapsedProjects(record?.collapsedProjects),
  }
}

export function normalizeSidebarPreferencesPatch(value: unknown): SidebarPreferencesPatch | null {
  const record = asRecord(value)
  if (!record) return null

  const patch: SidebarPreferencesPatch = {}
  if (record.initializeOnly === true) patch.initializeOnly = true

  if (record.sections !== undefined) {
    const rawSections = asRecord(record.sections)
    if (!rawSections) return null
    const sections: Partial<SidebarSectionPreferences> = {}
    for (const key of ['pinned', 'chats', 'projects'] as const) {
      const value = rawSections[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') return null
      sections[key] = value
    }
    patch.sections = sections
  }

  if (record.collapsedProjects !== undefined) {
    const rawProjects = asRecord(record.collapsedProjects)
    if (!rawProjects) return null
    const collapsedProjects: Record<string, boolean> = {}
    const entries = Object.entries(rawProjects)
    if (entries.length > MAX_PROJECT_PREFERENCES) return null
    for (const [rawProjectKey, collapsed] of entries) {
      const projectKey = normalizeProjectKey(rawProjectKey)
      if (!projectKey || typeof collapsed !== 'boolean') return null
      collapsedProjects[projectKey] = collapsed
    }
    patch.collapsedProjects = collapsedProjects
  }

  if (!patch.sections && !patch.collapsedProjects && patch.initializeOnly !== true) return null
  return patch
}

export function getSidebarPreferencesPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome || join(homedir(), '.codex')
  return join(codexHome, STATE_FILE_NAME)
}

async function readStoredState(statePath: string): Promise<StoredSidebarPreferencesReadResult> {
  try {
    const raw = await readFile(statePath, 'utf8')
    return {
      state: normalizeSidebarPreferences(JSON.parse(raw) as unknown),
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
  state: StoredSidebarPreferences,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  const payload = normalizeSidebarPreferences(state)
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
      throw new Error('Timed out waiting for the sidebar preference lock')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

function toPublicPreferences(
  state: StoredSidebarPreferences,
  persisted: boolean,
): SidebarPreferences {
  return {
    ...state,
    sections: { ...state.sections },
    collapsedProjects: { ...state.collapsedProjects },
    persisted,
  }
}

async function mutateSidebarPreferences(
  patch: SidebarPreferencesPatch,
): Promise<{ applied: boolean; preferences: SidebarPreferences }> {
  const run = mutationChain.then(async () => {
    const statePath = getSidebarPreferencesPath()
    const releaseLock = await acquireFileLock(statePath)
    try {
      await recoverCorruptStateFile(statePath)
      const current = await readStoredState(statePath)
      if (patch.initializeOnly === true && current.persisted) {
        return {
          applied: false,
          preferences: toPublicPreferences(current.state, true),
        }
      }

      const nextSections = {
        ...current.state.sections,
        ...(patch.sections ?? {}),
      }
      const nextCollapsedProjects = { ...current.state.collapsedProjects }
      for (const [projectKey, collapsed] of Object.entries(patch.collapsedProjects ?? {})) {
        if (collapsed) nextCollapsedProjects[projectKey] = true
        else delete nextCollapsedProjects[projectKey]
      }
      const normalizedProjects = normalizeCollapsedProjects(nextCollapsedProjects)
      const changed = JSON.stringify(current.state.sections) !== JSON.stringify(nextSections)
        || JSON.stringify(current.state.collapsedProjects) !== JSON.stringify(normalizedProjects)
        || !current.persisted
      if (!changed) {
        return {
          applied: true,
          preferences: toPublicPreferences(current.state, true),
        }
      }

      const next: StoredSidebarPreferences = {
        version: STATE_VERSION,
        revision: current.state.revision + 1,
        sections: nextSections,
        collapsedProjects: normalizedProjects,
      }
      await writeStoredStateAtomic(statePath, next)
      return {
        applied: true,
        preferences: toPublicPreferences(next, true),
      }
    } finally {
      await releaseLock()
    }
  })
  mutationChain = run.catch(() => {})
  return run
}

export async function readSidebarPreferences(): Promise<SidebarPreferences> {
  const current = await readStoredState(getSidebarPreferencesPath())
  return toPublicPreferences(current.state, current.persisted)
}

export async function patchSidebarPreferences(
  patchInput: unknown,
): Promise<{ applied: boolean; preferences: SidebarPreferences }> {
  const patch = normalizeSidebarPreferencesPatch(patchInput)
  if (!patch) throw new Error('Invalid sidebar preference patch')
  return await mutateSidebarPreferences(patch)
}

export async function listSidebarPreferenceRecoveryFiles(): Promise<string[]> {
  const statePath = getSidebarPreferencesPath()
  const prefix = `${STATE_FILE_NAME}.corrupt-`
  try {
    return (await readdir(dirname(statePath))).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
