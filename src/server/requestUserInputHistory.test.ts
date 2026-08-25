import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UiRequestUserInputSummary } from '../types/codex'
import {
  deleteRequestUserInputHistory,
  getRequestUserInputHistoryPath,
  listRequestUserInputHistoryRecoveryFiles,
  readRequestUserInputHistory,
  writeRequestUserInputSummary,
} from './requestUserInputHistory'

let codexHome = ''
let previousCodexHome: string | undefined

function summary(threadId: string, requestId: number): UiRequestUserInputSummary {
  return {
    id: `request-user-input:1:${requestId}`,
    threadId,
    turnId: `turn-${requestId}`,
    itemId: `item-${requestId}`,
    requestId,
    generation: 1,
    status: 'answered',
    questions: [{ id: 'goal', header: 'Goal', question: 'What is the goal?', answers: ['MVP'], isSecret: false }],
    requestedAtIso: `2026-08-25T10:00:${String(requestId).padStart(2, '0')}.000Z`,
    resolvedAtIso: `2026-08-25T10:01:${String(requestId).padStart(2, '0')}.000Z`,
  }
}

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-request-user-input-history-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('request user input history persistence', () => {
  it('persists per-thread summaries with private file permissions', async () => {
    await writeRequestUserInputSummary(summary('thread-a', 1))
    await expect(readRequestUserInputHistory('thread-a')).resolves.toEqual({
      'thread-a': [summary('thread-a', 1)],
    })
    expect((await stat(getRequestUserInputHistoryPath())).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent updates without dropping either thread', async () => {
    await Promise.all([
      writeRequestUserInputSummary(summary('thread-a', 1)),
      writeRequestUserInputSummary(summary('thread-b', 2)),
    ])
    await expect(readRequestUserInputHistory()).resolves.toEqual({
      'thread-b': [summary('thread-b', 2)],
      'thread-a': [summary('thread-a', 1)],
    })
  })

  it('backs up malformed state before the next write', async () => {
    await writeFile(getRequestUserInputHistoryPath(), '{broken', { encoding: 'utf8', mode: 0o600 })
    await writeRequestUserInputSummary(summary('thread-a', 1))
    const recoveryFiles = await listRequestUserInputHistoryRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
  })

  it('deletes only the selected thread history', async () => {
    await writeRequestUserInputSummary(summary('thread-a', 1))
    await writeRequestUserInputSummary(summary('thread-b', 2))
    await deleteRequestUserInputHistory('thread-a')
    await expect(readRequestUserInputHistory()).resolves.toEqual({
      'thread-b': [summary('thread-b', 2)],
    })
  })
})
