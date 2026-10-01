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
    kind: 'checklist',
    itemId: undefined,
    explanation: undefined,
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

  it('retains checklist and multiple proposal summaries for the same turn', async () => {
    const checklist = summary('thread-a', 'turn-a')
    await writePlanSummary(checklist)
    for (const itemId of ['draft-a', 'draft-b']) await writePlanSummary({ ...checklist, kind: 'proposal', itemId, messageId: itemId, steps: [], text: `Proposal ${itemId}` })
    const rows = (await readPlanSummaryHistory('thread-a'))['thread-a']
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(row => row.id)).size).toBe(3)
    expect(rows.filter(row => row.kind === 'proposal').map(row => row.itemId)).toEqual(['draft-a', 'draft-b'])
  })

  it('does not replace a newer persisted summary with a late old revision', async () => {
    await writePlanSummary({ ...summary('thread-a', 'turn-a'), revision: 9 })
    await writePlanSummary({ ...summary('thread-a', 'turn-a'), revision: 2, lifecycle: 'failed' })
    expect((await readPlanSummaryHistory('thread-a'))['thread-a'][0]).toMatchObject({ revision: 9, lifecycle: 'completed' })
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
