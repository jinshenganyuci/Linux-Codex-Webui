import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePlanSnapshot } from '../types/codex'
import {
  ACTIVE_PLAN_PERSISTENCE_MAX_BYTES,
  ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES,
  createActivePlanPersistence,
  getActivePlanPersistencePath,
  type ActivePlanPersistence,
} from './activePlanPersistence'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

function snapshot(overrides: Partial<ActivePlanSnapshot> = {}): ActivePlanSnapshot {
  return {
    kind: 'checklist',
    threadId: 'thread-a',
    turnId: 'turn-a',
    messageId: 'turn-a:plan',
    text: 'Finish the change',
    explanation: 'Check correctness',
    steps: [{ step: 'Run tests', status: 'inProgress' }],
    revision: 1,
    createdAtIso: '2026-09-27T00:00:00.000Z',
    updatedAtIso: '2026-09-27T00:00:01.000Z',
    generation: 1,
    lifecycle: 'live',
    ...overrides,
  }
}

describe('active plan persistence', () => {
  let directory: string
  let path: string
  let instances: ActivePlanPersistence[]
  let errors: Error[]

  function create(): ActivePlanPersistence {
    const instance = createActivePlanPersistence({ path: () => path, onError: (error) => errors.push(error) })
    instances.push(instance)
    return instance
  }

  async function contents(): Promise<ActivePlanSnapshot[]> {
    return JSON.parse(await readFile(path, 'utf8')).snapshots as ActivePlanSnapshot[]
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'active-plan-persistence-'))
    path = join(directory, 'plans.json')
    instances = []
    errors = []
    vi.mocked(fs.rename).mockClear()
    vi.mocked(fs.writeFile).mockClear()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(instances.map((instance) => instance.dispose().catch(() => undefined)))
    await rm(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('uses global CODEX_HOME by default', () => {
    vi.stubEnv('CODEX_HOME', directory)
    expect(getActivePlanPersistencePath()).toBe(join(directory, 'linux-codex-webui-active-plans.json'))
    vi.unstubAllEnvs()
  })

  it('coalesces a burst within 200 ms and skips writing unchanged snapshots', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persistence = create()
    await persistence.load()
    for (let revision = 1; revision <= 20; revision += 1) {
      persistence.schedule([snapshot({ revision })])
    }
    await vi.advanceTimersByTimeAsync(199)
    expect(fs.rename).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await persistence.flush()
    expect(fs.rename).toHaveBeenCalledTimes(1)
    expect((await contents())[0]?.revision).toBe(20)

    persistence.schedule([snapshot({ revision: 20 })])
    await persistence.flush()
    expect(fs.rename).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('does not postpone continuous live updates forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persistence = create()
    await persistence.load()
    persistence.schedule([snapshot({ revision: 1 })])
    await vi.advanceTimersByTimeAsync(150)
    persistence.schedule([snapshot({ revision: 2 })])
    await vi.advanceTimersByTimeAsync(50)
    await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledTimes(1))
    expect((await contents())[0]?.revision).toBe(2)
  })

  it('writes terminal snapshots atomically with mode 0600 and reloads all identity fields', async () => {
    const persistence = create()
    const completed = snapshot({
      kind: 'proposal', itemId: 'item-a', messageId: 'item-a:plan',
      revision: 7, lifecycle: 'completed', steps: [],
    })
    persistence.schedule([completed], true)
    await persistence.flush()
    expect(await contents()).toEqual([completed])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const [temporary, target] = vi.mocked(fs.rename).mock.calls[0]!
    expect(temporary).toMatch(/\.tmp$/u)
    expect(target).toBe(path)
    expect(await readdir(directory)).toEqual(['plans.json'])
    expect(await create().load()).toEqual([completed])
  })

  it('copies scheduled state and protects returned loaded state from caller mutations', async () => {
    const persistence = create()
    const original = snapshot()
    persistence.schedule([original])
    original.text = 'mutated after scheduling'
    original.steps[0]!.step = 'mutated nested step'
    await persistence.flush()
    const reloaded = create()
    const loaded = await reloaded.load()
    expect(loaded).toEqual([snapshot()])
    loaded[0]!.steps[0]!.step = 'mutated after load'
    expect(await reloaded.load()).toEqual([snapshot()])
  })

  it('keeps disk startup data available for caller merge even if events arrived first', async () => {
    const old = snapshot({ threadId: 'old-thread' })
    await writeFile(path, JSON.stringify({ version: 1, snapshots: [old] }))
    const persistence = create()
    const event = snapshot({ threadId: 'new-thread', revision: 2 })
    persistence.schedule([event])
    const restored = await persistence.load()
    expect(restored).toEqual([old])
    persistence.schedule([...restored, event])
    await persistence.flush()
    expect((await contents()).map((row) => row.threadId).sort()).toEqual(['new-thread', 'old-thread'])
  })

  it('removes a thread from an in-flight write and pending replacements without resurrection', async () => {
    const persistence = create()
    await persistence.load()
    const actualWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
    let releaseWrite!: () => void
    let enteredWrite!: () => void
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve })
    const entered = new Promise<void>((resolve) => { enteredWrite = resolve })
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args: Parameters<typeof writeFile>) => {
      enteredWrite()
      await blocked
      await actualWriteFile(...args)
    })
    persistence.schedule([snapshot()], true)
    await entered
    persistence.schedule([snapshot({ revision: 2 }), snapshot({ threadId: 'thread-b' })])
    const removed = persistence.removeThread('thread-a')
    await Promise.resolve()
    // An old full snapshot set delivered while deletion waits for disk must not resurrect it.
    persistence.schedule([snapshot({ revision: 3 }), snapshot({ threadId: 'thread-b' })])
    releaseWrite()
    await removed
    expect((await contents()).map((row) => row.threadId)).toEqual(['thread-b'])
    expect(fs.rename).toHaveBeenCalledTimes(1)
    expect(await readdir(directory)).toEqual(['plans.json'])
    await persistence.flush()
    expect((await create().load()).map((row) => row.threadId)).toEqual(['thread-b'])
  })

  it('removes persisted data even before load was called and keeps unrelated threads', async () => {
    await writeFile(path, JSON.stringify({ version: 1, snapshots: [snapshot(), snapshot({ threadId: 'thread-b' })] }))
    const persistence = create()
    await persistence.removeThread('thread-a')
    expect((await contents()).map((row) => row.threadId)).toEqual(['thread-b'])
  })

  it('retains at most 64 recent plans and distinguishes proposal items within one turn', async () => {
    const persistence = create()
    persistence.schedule(Array.from({ length: 100 }, (_, revision) => snapshot({
      kind: 'proposal', itemId: `item-${revision}`, messageId: `item-${revision}:plan`, revision,
    })))
    await persistence.flush()
    const stored = await contents()
    expect(stored).toHaveLength(64)
    expect(stored.map((row) => row.revision)).toEqual(Array.from({ length: 64 }, (_, index) => index + 36))
  })

  it('merges concurrent instances sharing a file and does not let an empty instance erase peers', async () => {
    const first = create(), second = create(), empty = create()
    await Promise.all([first.load(), second.load(), empty.load()])
    first.schedule([snapshot({ threadId: 'thread-a' })], true)
    second.schedule([snapshot({ threadId: 'thread-b' })], true)
    empty.schedule([], true)
    await Promise.all([first.flush(), second.flush(), empty.flush()])
    expect((await contents()).map((row) => row.threadId).sort()).toEqual(['thread-a', 'thread-b'])
    expect(await readdir(directory)).toEqual(['plans.json'])
  })

  it('keeps tombstones across instances so a stale writer cannot restore a deleted thread', async () => {
    const first = create(), stale = create()
    first.schedule([snapshot()], true)
    await first.flush()
    const oldState = await stale.load()
    await first.removeThread('thread-a')
    stale.schedule([...oldState, snapshot({ threadId: 'thread-b' })], true)
    await stale.flush()
    expect((await contents()).map((row) => row.threadId)).toEqual(['thread-b'])
    const disk = JSON.parse(await readFile(path, 'utf8'))
    expect(disk.deletedThreads).toEqual([{ threadId: 'thread-a', deletedAtIso: expect.any(String) }])
  })

  it('recovers a crashed lock owner without losing data and removes lock artifacts', async () => {
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 2_147_483_647 }))
    const persistence = create()
    persistence.schedule([snapshot()], true)
    await persistence.flush()
    expect(await contents()).toEqual([snapshot()])
    expect(await readdir(directory)).toEqual(['plans.json'])
  })

  it('never lets a stale live instance overwrite a confirmed terminal revision', async () => {
    const first = create(), stale = create()
    first.schedule([snapshot({ lifecycle: 'completed', revision: 2 })], true)
    await first.flush()
    stale.schedule([snapshot({ lifecycle: 'unconfirmed', revision: 3,
      updatedAtIso: '2026-09-27T00:00:05.000Z' })], true)
    await stale.flush()
    expect((await contents())[0]).toMatchObject({ lifecycle: 'completed', revision: 2 })
  })

  it('retains active and unconfirmed plans ahead of newer terminal history', async () => {
    const persistence = create()
    persistence.schedule([
      snapshot({ turnId: 'active-old', lifecycle: 'live', updatedAtIso: '2020-01-01T00:00:00.000Z' }),
      snapshot({ turnId: 'unconfirmed-old', lifecycle: 'unconfirmed', updatedAtIso: '2020-01-01T00:00:00.000Z' }),
      ...Array.from({ length: 64 }, (_, revision) => snapshot({ turnId: `terminal-${revision}`, lifecycle: 'completed', revision })),
    ])
    await persistence.flush()
    const stored = await contents()
    expect(stored).toHaveLength(64)
    expect(stored.filter((row) => row.lifecycle !== 'completed').map((row) => row.turnId).sort())
      .toEqual(['active-old', 'unconfirmed-old'])
  })

  it('restores truncated checklist metadata and marks dropped steps explicitly', async () => {
    const persistence = create()
    persistence.schedule([snapshot({ steps: Array.from({ length: 65 }, () => ({ step: 'done', status: 'completed' as const })) })])
    await persistence.flush()
    expect((await create().load())[0]).toMatchObject({ truncated: true })
    expect((await contents())[0]?.steps).toHaveLength(64)
  })

  it('bounds deletion tombstones while retaining the newest deletions', async () => {
    await writeFile(path, JSON.stringify({ version: 1, snapshots: [], deletedThreads:
      Array.from({ length: 2100 }, (_, index) => ({ threadId: `thread-${index}`, deletedAtIso: new Date(index * 1000).toISOString() })) }))
    const persistence = create()
    await persistence.load()
    persistence.schedule([])
    await persistence.flush()
    const disk = JSON.parse(await readFile(path, 'utf8'))
    expect(disk.deletedThreads).toHaveLength(2048)
    expect(disk.deletedThreads.at(-1).threadId).toBe('thread-2099')
    expect(Buffer.byteLength(await readFile(path, 'utf8'), 'utf8')).toBeLessThanOrEqual(ACTIVE_PLAN_PERSISTENCE_MAX_BYTES)
  })

  it('bounds escaped JSON bytes, step counts, and UTF-8 fields without replacement characters', async () => {
    const persistence = create()
    persistence.schedule(Array.from({ length: 80 }, (_, revision) => snapshot({
      turnId: `turn-${revision}`, messageId: `turn-${revision}:plan`, revision,
      text: '😀'.repeat(100_000),
      explanation: '\u0000'.repeat(100_000),
      steps: Array.from({ length: 100 }, () => ({ step: '你'.repeat(100_000), status: 'pending' as const })),
    })))
    await persistence.flush()
    const raw = await readFile(path, 'utf8')
    const stored = await contents()
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(ACTIVE_PLAN_PERSISTENCE_MAX_BYTES)
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.at(-1)?.revision).toBe(79)
    expect(raw).not.toContain('�')
    expect(stored.every((row) => row.steps.length <= 64)).toBe(true)
    expect(stored.every((row) => Buffer.byteLength(row.text, 'utf8') <= 64 * 1024)).toBe(true)
  })

  it('rejects oversized identities, strips unknown fields, and normalizes invalid scalar values', async () => {
    const persistence = create()
    persistence.schedule([
      snapshot({ threadId: 'a'.repeat(513) }),
      { ...snapshot({ revision: -9, generation: Number.POSITIVE_INFINITY }),
        kind: undefined, lifecycle: 'bad-lifecycle', extra: 'ignored' } as unknown as ActivePlanSnapshot,
    ])
    await persistence.flush()
    expect(await contents()).toEqual([snapshot({ revision: 0, generation: 0, lifecycle: 'unconfirmed' })])
  })

  it('preserves malformed data under a corrupt filename and reports recovery', async () => {
    await writeFile(path, '{broken')
    const persistence = create()
    expect(await persistence.load()).toEqual([])
    expect(errors).toHaveLength(1)
    const backup = (await readdir(directory)).find((file) => file.includes('.corrupt-'))!
    expect(await readFile(join(directory, backup), 'utf8')).toBe('{broken')
    expect(errors[0]?.message).toContain(backup)
    persistence.schedule([snapshot()], true)
    await persistence.flush()
    expect(await contents()).toEqual([snapshot()])
    expect(await readFile(join(directory, backup), 'utf8')).toBe('{broken')
  })

  it('preserves oversized files without reading an unbounded payload', async () => {
    await writeFile(path, 'x'.repeat(ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES + 1))
    expect(await create().load()).toEqual([])
    const backup = (await readdir(directory)).find((file) => file.includes('.corrupt-'))!
    expect((await stat(join(directory, backup))).size).toBe(ACTIVE_PLAN_PERSISTENCE_MAX_FILE_BYTES + 1)
    expect(errors[0]?.message).toContain('2 MiB')
  })

  it('does not overwrite corrupt data if its backup fails and permits a later load retry', async () => {
    await writeFile(path, '{broken')
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('backup blocked'))
    const persistence = create()
    await expect(persistence.load()).rejects.toThrow('backup blocked')
    expect(await readFile(path, 'utf8')).toBe('{broken')
    expect(await persistence.load()).toEqual([])
    const backup = (await readdir(directory)).find((file) => file.includes('.corrupt-'))!
    expect(await readFile(join(directory, backup), 'utf8')).toBe('{broken')
  })

  it('reports async write errors, rejects flush, and can retry without losing pending state', async () => {
    const saved = vi.fn()
    const persistence = createActivePlanPersistence({
      path: () => path, onError: (error) => errors.push(error), onSaved: saved,
    })
    instances.push(persistence)
    await persistence.load()
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('disk unavailable'))
    persistence.schedule([snapshot()], true)
    await expect(persistence.flush()).rejects.toThrow('disk unavailable')
    expect(errors).toHaveLength(1)
    expect(saved).not.toHaveBeenCalled()
    await persistence.flush()
    expect(saved).toHaveBeenCalledTimes(1)
    expect(await contents()).toEqual([snapshot()])
    expect(await readdir(directory)).toEqual(['plans.json'])
  })

  it('flushes pending changes on dispose and ignores late scheduled notifications', async () => {
    const persistence = create()
    persistence.schedule([snapshot({ lifecycle: 'unconfirmed' })])
    const disposing = persistence.dispose()
    persistence.schedule([snapshot({ revision: 999 })], true)
    await disposing
    expect(await create().load()).toEqual([snapshot({ lifecycle: 'unconfirmed' })])
    expect(persistence.dispose()).toBe(disposing)
    expect(errors).toEqual([])
  })
})
