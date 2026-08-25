import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteThreadCollaborationPreference,
  getThreadCollaborationPreferencesPath,
  listThreadCollaborationPreferenceRecoveryFiles,
  patchThreadCollaborationPreferences,
  readThreadCollaborationPreferences,
} from './threadCollaborationPreferences'

let codexHome = ''
let previousCodexHome: string | undefined

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-thread-collaboration-preferences-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('thread collaboration preferences', () => {
  it('starts unpersisted and initializes once from browser migration state', async () => {
    await expect(readThreadCollaborationPreferences()).resolves.toMatchObject({
      revision: 0,
      persisted: false,
      modes: {},
    })
    const initialized = await patchThreadCollaborationPreferences({
      initializeOnly: true,
      modes: { 'thread-a': 'plan' },
    })
    expect(initialized.applied).toBe(true)
    expect(initialized.preferences).toMatchObject({ revision: 1, persisted: true, modes: { 'thread-a': 'plan' } })
    expect((await stat(getThreadCollaborationPreferencesPath())).mode & 0o777).toBe(0o600)

    const ignored = await patchThreadCollaborationPreferences({
      initializeOnly: true,
      modes: { 'thread-b': 'plan' },
    })
    expect(ignored.applied).toBe(false)
    expect(ignored.preferences.modes).toEqual({ 'thread-a': 'plan' })
  })

  it('does not let an empty browser cache claim migration ownership', async () => {
    const result = await patchThreadCollaborationPreferences({ initializeOnly: true, modes: {} })
    expect(result).toMatchObject({
      applied: false,
      preferences: { persisted: false, revision: 0, modes: {} },
    })
    await expect(stat(getThreadCollaborationPreferencesPath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent thread changes and treats default as removal', async () => {
    await Promise.all([
      patchThreadCollaborationPreferences({ modes: { 'thread-a': 'plan' } }),
      patchThreadCollaborationPreferences({ modes: { 'thread-b': 'plan' } }),
    ])
    await expect(readThreadCollaborationPreferences()).resolves.toMatchObject({
      persisted: true,
      modes: { 'thread-a': 'plan', 'thread-b': 'plan' },
    })
    await deleteThreadCollaborationPreference('thread-a')
    await expect(readThreadCollaborationPreferences()).resolves.toMatchObject({
      modes: { 'thread-b': 'plan' },
    })
  })

  it('backs up malformed state before accepting the next patch', async () => {
    await writeFile(getThreadCollaborationPreferencesPath(), '{broken', { encoding: 'utf8', mode: 0o600 })
    await patchThreadCollaborationPreferences({ modes: { 'thread-a': 'plan' } })
    const recoveryFiles = await listThreadCollaborationPreferenceRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
  })

  it('rejects invalid modes and thread ids', async () => {
    await expect(patchThreadCollaborationPreferences({ modes: { 'thread-a': 'invalid' as 'plan' } }))
      .rejects.toThrow('Invalid thread collaboration preference patch')
    await expect(deleteThreadCollaborationPreference('')).rejects.toThrow('Missing threadId')
  })
})
