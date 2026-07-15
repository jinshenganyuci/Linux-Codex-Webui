import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAgentSessionModelDetails,
  readAgentSessionModelDetails,
} from './agentSessionModelDetails'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent session model details', () => {
  it('reads model and thinking from the child turn context itself', () => {
    const raw = [
      JSON.stringify({ type: 'session_meta', payload: { model: 'fallback-model' } }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-child-a',
          effort: 'ultra',
          service_tier: 'fast',
        },
      }),
    ].join('\n')

    expect(parseAgentSessionModelDetails(raw)).toEqual({
      model: 'gpt-child-a',
      reasoningEffort: 'ultra',
    })
  })

  it('keeps model details isolated per child when resolving rollout paths', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'agent-session-model-details-'))
    temporaryDirectories.push(codexHome)
    const childA = '019f66ac-cfe3-7331-9e2e-879d2d58a6e5'
    const childB = '019f66ac-dc20-7c60-b9bd-fbb90800ec4e'
    const timestampMs = Number.parseInt(childA.replace(/-/gu, '').slice(0, 12), 16)
    const date = new Date(timestampMs)
    const sessionDirectory = join(
      codexHome,
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    )
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, `rollout-a-${childA}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: childA } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-child-a', effort: 'high' } }),
    ].join('\n'))
    await writeFile(join(sessionDirectory, `rollout-b-${childB}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: childB } }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          collaboration_mode: {
            settings: { model: 'gpt-child-b', reasoning_effort: 'ultra' },
          },
        },
      }),
    ].join('\n'))

    expect(await readAgentSessionModelDetails([childA, childB], new Map(), codexHome)).toEqual([
      { threadId: childA, model: 'gpt-child-a', reasoningEffort: 'high' },
      { threadId: childB, model: 'gpt-child-b', reasoningEffort: 'ultra' },
    ])
  })
})
