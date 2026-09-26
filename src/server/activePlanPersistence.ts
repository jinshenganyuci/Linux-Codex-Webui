import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ActivePlanSnapshot, UiPlanLifecycle, UiPlanStep } from '../types/codex'

export const ACTIVE_PLAN_PERSISTENCE_MAX_COUNT = 64
export const ACTIVE_PLAN_PERSISTENCE_MAX_BYTES = 512 * 1024
export const ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES = 2 * 1024 * 1024
export const ACTIVE_PLAN_PERSISTENCE_DEBOUNCE_MS = 200
const MAX_TEXT_BYTES = 64 * 1024
const MAX_ID_BYTES = 512
const MAX_STEPS = 64
const MAX_CANDIDATES = 4096
const MAX_TOMBSTONES = 2048
const MAX_TOMBSTONE_BYTES = 256 * 1024
const LIFECYCLES = new Set<UiPlanLifecycle>([
  'live', 'completed', 'failed', 'interrupted', 'incomplete', 'unconfirmed',
])

type ActivePlanPersistenceOptions = {
  path?: () => string
  onError?: (error: Error) => void
  onSaved?: () => void
}

export type ActivePlanPersistence = {
  load(): Promise<ActivePlanSnapshot[]>
  /** Merge desired local snapshots with other instances; deletion uses removeThread explicitly. */
  schedule(snapshots: ActivePlanSnapshot[], immediate?: boolean): void
  removeThread(threadId: string): Promise<void>
  flush(): Promise<void>
  dispose(): Promise<void>
}

type DeletedThread = { threadId: string; deletedAtIso: string }
type DiskState = { snapshots: ActivePlanSnapshot[]; deletedThreads: DeletedThread[]; raw: string | null }

async function withStateLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`
  const candidate = await open(candidatePath, 'wx', 0o600)
  try {
    try {
      await candidate.writeFile(JSON.stringify({ pid: process.pid }))
    } finally {
      await candidate.close()
    }
    const started = Date.now()
    while (true) {
      let owned = false
      try {
        // Linking a completed owner record is atomic; a crash cannot leave an empty lock file.
        await link(candidatePath, lockPath)
        owned = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (owned) {
        try {
          return await action()
        } finally {
          await unlink(lockPath).catch((error: unknown) => { if (!isMissing(error)) throw error })
        }
      }
      // Only one contender may reap a dead owner's lock; otherwise a second reaper could unlink
      // a newly acquired live lock. A live owner is never stolen based on elapsed time.
      const recoveryPath = `${lockPath}.recovery`
      let recoveryOwned = false
      try {
        await mkdir(recoveryPath)
        recoveryOwned = true
        const owner = record(JSON.parse(await readFile(lockPath, 'utf8')))
        if (Number.isSafeInteger(owner?.pid) && Number(owner?.pid) > 0) {
          try { process.kill(Number(owner?.pid), 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lockPath)
          }
        }
      } catch (error) {
        if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'EEXIST' && !(error instanceof SyntaxError)) throw error
      } finally {
        if (recoveryOwned) await rmdir(recoveryPath)
      }
      if (Date.now() - started >= 5000) throw new Error(`Timed out acquiring active plan lock: ${lockPath}`)
      await delay(15)
    }
  } finally {
    await unlink(candidatePath).catch((error: unknown) => { if (!isMissing(error)) throw error })
  }
}

export function getActivePlanPersistencePath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'linux-codex-webui-active-plans.json')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_ID_BYTES) return undefined
  const result = value.trim()
  // Reject oversized identifiers rather than truncating distinct identities into one.
  return result && Buffer.byteLength(result, 'utf8') <= MAX_ID_BYTES ? result : undefined
}

function cappedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 0) return ''
  // Slice before encoding so a malformed huge field cannot allocate a huge Buffer.
  const prefix = value.slice(0, maxBytes)
  if (Buffer.byteLength(prefix, 'utf8') <= maxBytes) return prefix
  const bytes = Buffer.from(prefix, 'utf8')
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeSnapshot(value: unknown): ActivePlanSnapshot | null {
  const row = record(value)
  if (!row) return null
  const threadId = identifier(row.threadId)
  const turnId = identifier(row.turnId)
  const messageId = identifier(row.messageId)
  const createdAtIso = timestamp(row.createdAtIso)
  const updatedAtIso = timestamp(row.updatedAtIso)
  if (!threadId || !turnId || !messageId || !createdAtIso || !updatedAtIso) return null
  const steps: UiPlanStep[] = []
  let truncated = row.truncated === true || (Array.isArray(row.steps) && row.steps.length > MAX_STEPS)
  let remainingStepBytes = MAX_TEXT_BYTES / 2
  for (const candidate of (Array.isArray(row.steps) ? row.steps : []).slice(0, MAX_STEPS)) {
    const step = record(candidate)
    const text = cappedText(step?.step, remainingStepBytes)
    if (typeof step?.step === 'string' && text !== step.step) truncated = true
    if (!text) continue
    remainingStepBytes -= Buffer.byteLength(text, 'utf8')
    steps.push({
      step: text,
      status: step?.status === 'completed' ? 'completed'
        : step?.status === 'inProgress' || step?.status === 'in_progress' ? 'inProgress' : 'pending',
    })
  }
  return {
    kind: row.kind === 'proposal' ? 'proposal' : 'checklist',
    itemId: row.kind === 'proposal' ? identifier(row.itemId) : undefined,
    threadId,
    turnId,
    messageId,
    text: cappedText(row.text, MAX_TEXT_BYTES),
    explanation: cappedText(row.explanation, MAX_TEXT_BYTES / 4) || undefined,
    steps,
    revision: nonnegativeInteger(row.revision),
    createdAtIso,
    updatedAtIso,
    generation: nonnegativeInteger(row.generation),
    lifecycle: LIFECYCLES.has(row.lifecycle as UiPlanLifecycle)
      ? row.lifecycle as UiPlanLifecycle : 'unconfirmed',
    ...(truncated ? { truncated: true } : {}),
  }
}

function normalizeDeletedThreads(value: unknown): DeletedThread[] {
  const entries = new Map<string, DeletedThread>()
  for (const candidate of (Array.isArray(value) ? value : []).slice(-MAX_CANDIDATES)) {
    const row = record(candidate)
    const threadId = identifier(row?.threadId)
    const deletedAtIso = timestamp(row?.deletedAtIso)
    if (!threadId || !deletedAtIso) continue
    if ((entries.get(threadId)?.deletedAtIso ?? '') <= deletedAtIso) entries.set(threadId, { threadId, deletedAtIso })
  }
  let bytes = 2
  return [...entries.values()].sort((a, b) => b.deletedAtIso.localeCompare(a.deletedAtIso)
    || b.threadId.localeCompare(a.threadId)).filter((entry, index) => {
    bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    return index < MAX_TOMBSTONES && bytes <= MAX_TOMBSTONE_BYTES
  }).reverse()
}

function normalizeSnapshots(value: unknown, deletedThreads: DeletedThread[] = []): ActivePlanSnapshot[] {
  if (!Array.isArray(value)) return []
  const deleted = new Set(deletedThreads.map((entry) => entry.threadId))
  const byIdentity = new Map<string, { value: unknown; updatedAtIso: string; revision: number; active: boolean }>()
  // Store order is oldest to newest. Input scanning and field sizes are bounded as well as output.
  for (const candidate of value.slice(-MAX_CANDIDATES)) {
    const row = record(candidate)
    if (!row) continue
    const threadId = identifier(row.threadId)
    const turnId = identifier(row.turnId)
    const messageId = identifier(row.messageId)
    const updatedAtIso = timestamp(row.updatedAtIso)
    if (!threadId || deleted.has(threadId) || !turnId || !messageId || !updatedAtIso || !timestamp(row.createdAtIso)) continue
    const revision = nonnegativeInteger(row.revision)
    const active = row.lifecycle === 'live' || row.lifecycle === 'unconfirmed' || !LIFECYCLES.has(row.lifecycle as UiPlanLifecycle)
    const kind = row.kind === 'proposal' ? 'proposal' : 'checklist'
    const key = JSON.stringify([threadId, turnId, kind, kind === 'proposal' ? identifier(row.itemId) ?? '' : ''])
    const previous = byIdentity.get(key)
    if (previous && !previous.active && active) continue
    if (!previous || (previous.active && !active) || previous.revision < revision
      || (previous.revision === revision && previous.updatedAtIso <= updatedAtIso)) {
      byIdentity.set(key, { value: candidate, updatedAtIso, revision, active })
    }
  }
  const newest = [...byIdentity.entries()].sort(([leftKey, left], [rightKey, right]) =>
    Number(right.active) - Number(left.active) || right.updatedAtIso.localeCompare(left.updatedAtIso) || right.revision - left.revision
      || rightKey.localeCompare(leftKey))
  const result: ActivePlanSnapshot[] = []
  // Include the envelope and delimiters in the on-disk size bound, including JSON escaping.
  let totalBytes = Buffer.byteLength(serialize([], deletedThreads), 'utf8')
  for (const [, candidate] of newest) {
    // Normalize text only after ordering; do not retain thousands of expanded text Buffers.
    const snapshot = normalizeSnapshot(candidate.value)!
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + (result.length ? 1 : 0)
    if (totalBytes + bytes > ACTIVE_PLAN_PERSISTENCE_MAX_BYTES) continue
    result.push(snapshot)
    totalBytes += bytes
    if (result.length === ACTIVE_PLAN_PERSISTENCE_MAX_COUNT) break
  }
  return result.reverse()
}

function cloneSnapshots(snapshots: ActivePlanSnapshot[]): ActivePlanSnapshot[] {
  return snapshots.map((snapshot) => ({ ...snapshot, steps: snapshot.steps.map((step) => ({ ...step })) }))
}

function captureScheduledSnapshots(snapshots: ActivePlanSnapshot[]): ActivePlanSnapshot[] {
  // Strings are immutable. Keep a bounded detached copy without encoding/serializing every delta.
  return snapshots.slice(-MAX_CANDIDATES).map((snapshot) => ({
    ...snapshot,
    ...(Array.isArray(snapshot?.steps) && snapshot.steps.length > MAX_STEPS ? { truncated: true } : {}),
    steps: (Array.isArray(snapshot?.steps) ? snapshot.steps : [])
      .slice(0, MAX_STEPS).map((step) => ({ ...step })),
  }))
}

function serialize(snapshots: ActivePlanSnapshot[], deletedThreads: DeletedThread[] = []): string {
  return `${JSON.stringify({ version: 1, snapshots, deletedThreads })}\n`
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function createActivePlanPersistence(options: ActivePlanPersistenceOptions = {}): ActivePlanPersistence {
  let statePath: string | undefined
  const path = () => statePath ??= (options.path ?? getActivePlanPersistencePath)()
  const report = (error: unknown) => {
    const detail = error instanceof Error ? error : new Error(String(error))
    if (options.onError) options.onError(detail)
    else console.warn('[active-plan-persistence]', detail.message)
  }
  let loadPromise: Promise<ActivePlanSnapshot[]> | null = null
  let snapshots: ActivePlanSnapshot[] | null = null
  let pendingDeletes: DeletedThread[] = []
  let version = 0
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let writer: Promise<void> | null = null
  let closing = false
  let disposePromise: Promise<void> | null = null
  const removalsInProgress = new Map<string, number>()

  async function readCurrent(): Promise<DiskState> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path(), 'r')
    } catch (error) {
      if (isMissing(error)) return { snapshots: [], deletedThreads: [], raw: null }
      throw error
    }
    let raw = ''
    let invalid: Error | null = null
    try {
      const size = (await handle.stat()).size
      if (size > ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES) {
        invalid = new Error('Active plan file exceeds the 2 MiB read limit')
      } else {
        const buffer = Buffer.alloc(Math.min(ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES + 1, size + 1))
        let length = 0
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length)
          if (read.bytesRead === 0) break
          length += read.bytesRead
        }
        if (length > ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES) {
          invalid = new Error('Active plan file exceeds the 2 MiB read limit')
        } else raw = buffer.subarray(0, length).toString('utf8')
      }
    } finally {
      await handle.close()
    }
    if (!invalid) {
      try {
        const parsed = record(JSON.parse(raw))
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.snapshots)) {
          invalid = new Error('Invalid active plan file schema')
        } else {
          const deletedThreads = normalizeDeletedThreads(parsed.deletedThreads)
          return { snapshots: normalizeSnapshots(parsed.snapshots, deletedThreads), deletedThreads, raw }
        }
      } catch (error) {
        invalid = error instanceof Error ? error : new Error(String(error))
      }
    }
    const backupPath = `${path()}.corrupt-${Date.now()}-${randomUUID()}`
    // Never overwrite a corrupt/oversized original unless preserving it succeeded.
    await rename(path(), backupPath)
    report(new Error(`Cannot load active plans: ${invalid!.message}. Original preserved at ${backupPath}`))
    return { snapshots: [], deletedThreads: [], raw: null }
  }

  function initial(): Promise<ActivePlanSnapshot[]> {
    if (!loadPromise) {
      loadPromise = withStateLock(path(), readCurrent).then(({ snapshots: loaded }) => {
        snapshots ??= loaded
        return loaded
      }).catch((error: unknown) => {
        loadPromise = null
        throw error
      })
    }
    return loadPromise
  }

  function clearTimer(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  async function writeAtomically(raw: string, writingVersion: number): Promise<boolean> {
    await mkdir(dirname(path()), { recursive: true })
    const temporaryPath = `${path()}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      // A queued deletion/newer revision supersedes this file before its atomic publication.
      if (writingVersion !== version) return false
      await rename(temporaryPath, path())
      return true
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error
      })
    }
  }

  function startWriter(): Promise<void> {
    if (writer) return writer
    writer = (async () => {
      await initial()
      while (dirty) {
        const writingVersion = version
        const saved = await withStateLock(path(), async () => {
          const current = await readCurrent()
          const deletedThreads = normalizeDeletedThreads([...current.deletedThreads, ...pendingDeletes])
          const merged = normalizeSnapshots([...current.snapshots, ...(snapshots ?? [])], deletedThreads)
          const raw = serialize(merged, deletedThreads)
          return raw === current.raw || await writeAtomically(raw, writingVersion)
        })
        if (saved) options.onSaved?.()
        if (writingVersion === version) {
          dirty = false
          pendingDeletes = []
        }
      }
    })().finally(() => { writer = null })
    // schedule() is intentionally fire-and-forget, while flush/removeThread expose failures.
    void writer.catch(report)
    return writer
  }

  function requestWrite(immediate: boolean): void {
    if (immediate) {
      clearTimer()
      void startWriter()
    } else if (!timer) {
      // A fixed window also persists continuously streaming plans instead of postponing forever.
      timer = setTimeout(() => {
        timer = null
        void startWriter()
      }, ACTIVE_PLAN_PERSISTENCE_DEBOUNCE_MS)
      timer.unref?.()
    }
  }

  async function flush(): Promise<void> {
    clearTimer()
    await initial()
    while (dirty || writer) await startWriter()
    clearTimer()
  }

  return {
    async load() { return cloneSnapshots(await initial()) },
    schedule(next, immediate = false) {
      if (closing) return
      snapshots = captureScheduledSnapshots(next).filter((snapshot) => !removalsInProgress.has(snapshot.threadId))
      version += 1
      dirty = true
      requestWrite(immediate)
    },
    async removeThread(threadId) {
      if (!identifier(threadId)) return
      removalsInProgress.set(threadId, (removalsInProgress.get(threadId) ?? 0) + 1)
      pendingDeletes = normalizeDeletedThreads([...pendingDeletes, { threadId, deletedAtIso: new Date().toISOString() }])
      version += 1
      try {
        await initial()
        snapshots = (snapshots ?? []).filter((snapshot) => snapshot.threadId !== threadId)
        dirty = true
        await flush()
      } finally {
        const remaining = (removalsInProgress.get(threadId) ?? 1) - 1
        if (remaining) removalsInProgress.set(threadId, remaining)
        else removalsInProgress.delete(threadId)
      }
    },
    flush,
    dispose() {
      closing = true
      disposePromise ??= flush()
      return disposePromise
    },
  }
}
