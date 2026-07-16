import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseSessionRuntimeEvents,
  resolveThreadRuntimeSnapshot,
  ThreadRuntimeState,
  type RuntimeInstanceLease,
  type RuntimeTurnEvidence,
} from './threadRuntimeState.js'

const THREAD_ID = '019f4b00-0000-7000-8000-000000000001'
const FIRST_TURN_ID = '019f4b00-0001-7000-8000-000000000001'
const SECOND_TURN_ID = '019f4b00-0002-7000-8000-000000000002'
const NOW_MS = 1_783_680_000_000

const temporaryDirectories: string[] = []

function sessionEvent(type: 'task_started' | 'task_complete' | 'turn_aborted', turnId: string, timestampMs: number): string {
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

  it('uses a later completion as the latest lifecycle event across overlapping turns', () => {
    const parsed = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 4_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    expect(parsed.latestTurnId).toBe(FIRST_TURN_ID)
    expect(parsed.turns.find((turn) => turn.turnId === FIRST_TURN_ID)?.completedAtMs).toBe(NOW_MS - 1_000)
  })

  it('records an explicit turn abort as interrupted lifecycle evidence', () => {
    const parsed = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 4_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 3_000),
      sessionEvent('turn_aborted', SECOND_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    expect(parsed.latestTurnId).toBe(SECOND_TURN_ID)
    expect(parsed.turns.find((turn) => turn.turnId === SECOND_TURN_ID)).toMatchObject({
      status: 'interrupted',
      completedAtMs: NOW_MS - 1_000,
    })
    expect(resolveThreadRuntimeSnapshot({ threadId: THREAD_ID, session: parsed, nowMs: NOW_MS })).toMatchObject({
      turnId: SECOND_TURN_ID,
      state: 'interrupted',
      completedAtIso: new Date(NOW_MS - 1_000).toISOString(),
    })
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

  it('never lets a fresh lease override matching local completion evidence', () => {
    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session: null,
      localTurns: [{
        threadId: THREAD_ID,
        turnId: FIRST_TURN_ID,
        startedAtMs: NOW_MS - 5_000,
        completedAtMs: NOW_MS - 1_000,
        status: 'completed',
      }],
      leases: [lease()],
      nowMs: NOW_MS,
    })

    expect(state).toMatchObject({ turnId: FIRST_TURN_ID, state: 'completed', source: 'local' })
  })

  it('does not revive a non-latest completed turn from a residual lease', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 10_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 8_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 5_000),
    ].join('\n'))

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease({ turnId: FIRST_TURN_ID, startedAtMs: NOW_MS - 10_000 })],
      localInstanceId: 'observer-instance',
      nowMs: NOW_MS,
    })

    expect(state).toMatchObject({ turnId: SECOND_TURN_ID, state: 'interrupted', isRunning: false })
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

  it('prefers a later task completion over a newer abandoned overlapping turn', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 4_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      nowMs: NOW_MS,
    })

    expect(state).toMatchObject({
      turnId: FIRST_TURN_ID,
      state: 'completed',
      isRunning: false,
      source: 'session',
    })
  })

  it('keeps an orphaned turn interrupted when it starts after the last completion', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 5_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 4_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    expect(resolveThreadRuntimeSnapshot({ threadId: THREAD_ID, session, nowMs: NOW_MS })).toMatchObject({
      turnId: SECOND_TURN_ID,
      state: 'interrupted',
      isRunning: false,
    })
  })

  it('keeps a fresh overlapping owner running when another turn completes later', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 20_000),
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 10_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 1_000),
    ].join('\n'))

    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      leases: [lease({ turnId: SECOND_TURN_ID, startedAtMs: NOW_MS - 20_000 })],
      localInstanceId: 'observer-instance',
      nowMs: NOW_MS,
    })

    expect(state).toMatchObject({
      turnId: SECOND_TURN_ID,
      state: 'running',
      isRunning: true,
      source: 'external',
    })
  })

  it('preserves a later explicit interruption time for downstream ordering', () => {
    const session = parseSessionRuntimeEvents([
      sessionEvent('task_started', FIRST_TURN_ID, NOW_MS - 20_000),
      sessionEvent('task_started', SECOND_TURN_ID, NOW_MS - 15_000),
      sessionEvent('task_complete', FIRST_TURN_ID, NOW_MS - 5_000),
    ].join('\n'))
    const state = resolveThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      session,
      localTurns: [{
        threadId: THREAD_ID,
        turnId: SECOND_TURN_ID,
        startedAtMs: NOW_MS - 15_000,
        completedAtMs: NOW_MS - 1_000,
        status: 'interrupted',
      }],
      nowMs: NOW_MS,
    })

    expect(state).toMatchObject({
      turnId: SECOND_TURN_ID,
      state: 'interrupted',
      completedAtIso: new Date(NOW_MS - 1_000).toISOString(),
    })
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

  it('preserves an interrupted turn/completed notification as interrupted runtime state', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'linux-codex-runtime-'))
    temporaryDirectories.push(codexHome)
    let nowMs = NOW_MS - 5_000
    const runtime = new ThreadRuntimeState({
      codexHome,
      instanceId: 'test-instance',
      processId: 1234,
      processStartedAtMs: NOW_MS - 60_000,
      now: () => nowMs,
    })
    runtime.observeNotification('turn/started', {
      threadId: THREAD_ID,
      turn: { id: FIRST_TURN_ID, startedAt: new Date(nowMs).toISOString() },
    })
    nowMs = NOW_MS - 1_000
    runtime.observeNotification('turn/completed', {
      threadId: THREAD_ID,
      turn: {
        id: FIRST_TURN_ID,
        status: 'interrupted',
        completedAt: new Date(nowMs).toISOString(),
      },
    })

    expect((await runtime.getStates([THREAD_ID]))[0]).toMatchObject({
      turnId: FIRST_TURN_ID,
      state: 'interrupted',
      completedAtIso: new Date(nowMs).toISOString(),
    })
    await runtime.dispose()
  })

  it('retains a long-running turn that was only just interrupted while pruning local history', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'linux-codex-runtime-'))
    temporaryDirectories.push(codexHome)
    const runtime = new ThreadRuntimeState({
      codexHome,
      instanceId: 'test-instance',
      processId: 1234,
      processStartedAtMs: NOW_MS - 300_000,
      now: () => NOW_MS,
    })

    for (let index = 0; index < 12; index += 1) {
      runtime.observeNotification('turn/started', {
        threadId: THREAD_ID,
        turn: {
          id: `short-running-${String(index)}`,
          startedAt: new Date(NOW_MS - 30_000 + index).toISOString(),
        },
      })
    }
    runtime.observeNotification('turn/started', {
      threadId: THREAD_ID,
      turn: {
        id: 'long-running-turn',
        startedAt: new Date(NOW_MS - 120_000).toISOString(),
      },
    })

    runtime.clearLocalActivity()

    const localTurns = (runtime as unknown as {
      localTurnsByThreadId: Map<string, Map<string, RuntimeTurnEvidence>>
    }).localTurnsByThreadId.get(THREAD_ID)
    expect(localTurns?.get('long-running-turn')).toMatchObject({
      status: 'interrupted',
      completedAtMs: NOW_MS,
    })
    await runtime.dispose()
  })
})
