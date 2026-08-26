import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UiPlanSummary } from '../types/codex'
import {
  deletePlanSummaryHistory,
  getPlanSummaryHistoryPath,
  listPlanSummaryHistoryRecoveryFiles,
  readPlanSummaryHistory,
  writePlanSummary,
} from './planSummaryHistory'

let codexHome = ''
let previousCodexHome: string | undefined

function summary(threadId: string, turnId: string): UiPlanSummary {
  return {
    id: `plan-summary:${turnId}`,
    threadId,
    turnId,
    messageId: `${turnId}:plan`,
    text: `- [x] ${turnId}`,
    steps: [{ step: turnId, status: 'completed' }],
    revision: 2,
    lifecycle: 'completed',
    createdAtIso: '2026-08-26T10:00:00.000Z',
    updatedAtIso: '2026-08-26T10:00:10.000Z',
  }
}

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-plan-summary-history-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('plan summary history persistence', () => {
  it('persists per-thread summaries with private file permissions', async () => {
    await writePlanSummary(summary('thread-a', 'turn-a'))
    await expect(readPlanSummaryHistory('thread-a')).resolves.toEqual({
      'thread-a': [summary('thread-a', 'turn-a')],
    })
    expect((await stat(getPlanSummaryHistoryPath())).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent updates and replaces one turn atomically', async () => {
    await Promise.all([
      writePlanSummary(summary('thread-a', 'turn-a')),
      writePlanSummary(summary('thread-b', 'turn-b')),
    ])
    await writePlanSummary({ ...summary('thread-a', 'turn-a'), lifecycle: 'failed', revision: 3 })
    await expect(readPlanSummaryHistory()).resolves.toMatchObject({
      'thread-a': [{ turnId: 'turn-a', lifecycle: 'failed', revision: 3 }],
      'thread-b': [{ turnId: 'turn-b' }],
    })
  })

  it('backs up malformed state before the next write', async () => {
    await writeFile(getPlanSummaryHistoryPath(), '{broken', { encoding: 'utf8', mode: 0o600 })
    await writePlanSummary(summary('thread-a', 'turn-a'))
    const recoveryFiles = await listPlanSummaryHistoryRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
  })

  it('deletes only the selected thread history', async () => {
    await writePlanSummary(summary('thread-a', 'turn-a'))
    await writePlanSummary(summary('thread-b', 'turn-b'))
    await deletePlanSummaryHistory('thread-a')
    await expect(readPlanSummaryHistory()).resolves.toEqual({
      'thread-b': [summary('thread-b', 'turn-b')],
    })
  })
})
