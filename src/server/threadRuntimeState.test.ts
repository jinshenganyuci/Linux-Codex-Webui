import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseSessionRuntimeEvents,
  resolveThreadRuntimeSnapshot,
  ThreadRuntimeState,
  type RuntimeInstanceLease,
} from './threadRuntimeState.js'

const THREAD_ID = '019f4b00-0000-7000-8000-000000000001'
const FIRST_TURN_ID = '019f4b00-0001-7000-8000-000000000001'
const SECOND_TURN_ID = '019f4b00-0002-7000-8000-000000000002'
const NOW_MS = 1_783_680_000_000

const temporaryDirectories: string[] = []

function sessionEvent(type: 'task_started' | 'task_complete', turnId: string, timestampMs: number): string {
  const epochKey = type === 'task_started' ? 'started_at' : 'completed_at'
  return JSON.stringify({
    timestamp: new Date(timestampMs).toISOString(),
    type: 'event_msg',
    payload: {
      type,
      turn_id: turnId,
      [epochKey]: Math.floor(timestampMs / 1000),
    },
  })
}

function lease(input: {
  turnId?: string
  heartbeatAtMs?: number
  startedAtMs?: number
  instanceId?: string
} = {}): RuntimeInstanceLease {
  const instanceId = input.instanceId ?? 'external-instance'
  return {
    version: 1,
    instanceId,
    processId: 4321,
    processIdentity: `4321:1:${instanceId}`,
    port: 4175,
    heartbeatAtMs: input.heartbeatAtMs ?? NOW_MS,
    turns: [{
      threadId: THREAD_ID,
      turnId: input.turnId ?? FIRST_TURN_ID,
      startedAtMs: input.startedAtMs ?? NOW_MS - 5_000,
      sessionPath: '',
    }],
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('parseSessionRuntimeEvents', () => {
  it('keeps a started turn running until matching completion evidence appears', () => {
    const parsed = parseSessionRuntimeEvents(`${sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000)}\n`)

    expect(parsed.latestTurnId).toBe(FIRST_TURN_ID)
    expect(parsed.turns).toEqual([expect.objectContaining({
      turnId: FIRST_TURN_ID,
      completedAtMs: null,
    })])
  })

  it('records task_complete against the matching turn', () => {
    const parsed = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    expect(parsed.latestTurnId).toBe(FIRST_TURN_ID)
    expect(parsed.turns[0]?.completedAtMs).toBe(NOW_MS - 1_000)
  })
})

describe('resolveThreadRuntimeSnapshot', () => {
  it('never lets a fresh external lease override matching task_complete', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease()],
      nowMs: NOW_MS,
    })

    expect(state.state).toBe('completed')
    expect(state.isRunning).toBe(false)
    expect(state.source).toBe('session')
  })

  it('uses a fresh external lease when an observer app-server cannot see the active turn', () => {
    const session = parseSessionRuntimeEvents(`${sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000)}\n`)

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease()],
      localInstanceId: 'observer-instance',
      nowMs: NOW_MS,
    })

    expect(state.state).toBe('running')
    expect(state.source).toBe('external')
    expect(state.owner?.port).toBe(4175)
  })

  it('expires a crashed owner lease instead of leaving an infinite running state', () => {
    const session = parseSessionRuntimeEvents(`${sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 20_000)}\n`)

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease({ heartbeatAtMs: NOW_MS - 11_000 })],
      nowMs: NOW_MS,
      leaseTtlMs: 10_000,
    })

    expect(state.state).toBe('interrupted')
    expect(state.isRunning).toBe(false)
  })

  it('keeps a long quiet command running while its lease heartbeat is fresh', () => {
    const session = parseSessionRuntimeEvents(`${sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 120_000)}\n`)

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease({ startedAtMs: NOW_MS - 120_000, heartbeatAtMs: NOW_MS - 1_000 })],
      nowMs: NOW_MS,
    })

    expect(state.state).toBe('running')
  })

  it('does not let an old completed turn clear a newer running turn', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 20_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 15_000),
    ].join('\n'))

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease({ turnId: SECOND_TURN_ID, startedAtMs: NOW_MS - 2_000 })],
      nowMs: NOW_MS,
    })

    expect(state.turnId).toBe(SECOND_TURN_ID)
    expect(state.state).toBe('running')
  })
})

describe('ThreadRuntimeState incremental session parsing', () => {
  it('observes an appended completion without reparsing state precedence incorrectly', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'linux-codex-runtime-'))
    temporaryDirectories.push(codexHome)
    const sessionPath = join(codexHome, 'session.jsonl')
    await writeFile(sessionPath, `${sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000)}\n`, 'utf8')
    const runtime = new ThreadRuntimeState({
      codexHome,
      instanceId: 'test-instance',
      processId: 1234,
      processStartedAtMs: NOW_MS - 60_000,
      now: () => NOW_MS,
    })
    runtime.observeThreadPayload({ thread: { id: THREAD_ID, path: sessionPath } })

    expect((await runtime.getStates([THREAD_ID]))[0]?.state).toBe('interrupted')

    await appendFile(sessionPath, `${sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000)}\n`, 'utf8')
    expect((await runtime.getStates([THREAD_ID]))[0]?.state).toBe('completed')

    await runtime.dispose()
  })
})
