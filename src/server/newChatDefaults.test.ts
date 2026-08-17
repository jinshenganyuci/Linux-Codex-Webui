import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getNewChatDefaultsPath,
  listNewChatDefaultRecoveryFiles,
  normalizeNewChatDefaultPatch,
  patchNewChatDefaults,
  readNewChatDefaults,
} from './newChatDefaults'

let codexHome = ''
let previousCodexHome: string | undefined

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-new-chat-defaults-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('new chat defaults', () => {
  it('returns an empty provider map before configuration', async () => {
    await expect(readNewChatDefaults()).resolves.toEqual({
      version: 1,
      revision: 0,
      providers: {},
    })
  })

  it('persists normalized provider defaults with private permissions', async () => {
    await patchNewChatDefaults({
      providerId: ' OpenAI ',
      model: ' gpt-5.6-luna ',
      reasoningEffort: 'HIGH',
    })

    await expect(readNewChatDefaults()).resolves.toEqual({
      version: 1,
      revision: 1,
      providers: {
        codex: { model: 'gpt-5.6-luna', reasoningEffort: 'high' },
      },
    })
    expect((await stat(getNewChatDefaultsPath())).mode & 0o777).toBe(0o600)
  })

  it('merges concurrent updates for different providers', async () => {
    await Promise.all([
      patchNewChatDefaults({ providerId: 'codex', model: 'gpt-5.6-sol' }),
      patchNewChatDefaults({ providerId: 'my_proxy', reasoningEffort: 'max' }),
    ])

    await expect(readNewChatDefaults()).resolves.toEqual({
      version: 1,
      revision: 2,
      providers: {
        codex: { model: 'gpt-5.6-sol' },
        'my-proxy': { reasoningEffort: 'max' },
      },
    })
  })

  it('removes inherited fields and deletes an empty provider entry', async () => {
    await patchNewChatDefaults({
      providerId: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    })
    await patchNewChatDefaults({ providerId: 'codex', model: null })
    expect((await readNewChatDefaults()).providers.codex).toEqual({ reasoningEffort: 'high' })

    await patchNewChatDefaults({ providerId: 'codex', reasoningEffort: null })
    expect((await readNewChatDefaults()).providers).toEqual({})
  })

  it('does not increment revision for a no-op patch', async () => {
    await patchNewChatDefaults({ providerId: 'codex', model: 'gpt-5.6-luna' })
    const state = await patchNewChatDefaults({ providerId: 'codex', model: 'gpt-5.6-luna' })
    expect(state.revision).toBe(1)
  })

  it('backs up malformed state before accepting a preference', async () => {
    await writeFile(getNewChatDefaultsPath(), '{broken', { encoding: 'utf8', mode: 0o600 })

    await patchNewChatDefaults({ providerId: 'codex', reasoningEffort: 'xhigh' })

    const recoveryFiles = await listNewChatDefaultRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
    expect((await readNewChatDefaults()).providers.codex).toEqual({ reasoningEffort: 'xhigh' })
  })

  it('rejects invalid provider, model, and reasoning patches', async () => {
    expect(normalizeNewChatDefaultPatch({ providerId: '', model: 'gpt-5.6-luna' })).toBeNull()
    expect(normalizeNewChatDefaultPatch({ providerId: 'codex' })).toBeNull()
    expect(normalizeNewChatDefaultPatch({ providerId: 'codex', model: '' })).toBeNull()
    expect(normalizeNewChatDefaultPatch({ providerId: 'codex', reasoningEffort: 'impossible' })).toBeNull()
    await expect(patchNewChatDefaults({ providerId: 'codex', reasoningEffort: 3 }))
      .rejects.toThrow('Invalid new chat default patch')
  })
})
