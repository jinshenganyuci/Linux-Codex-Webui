import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteThreadModelPreference,
  getThreadModelPreferencesPath,
  listThreadModelPreferenceRecoveryFiles,
  readThreadModelPreferences,
  writeThreadModelPreference,
} from './threadModelPreferences'

let codexHome = ''
let previousCodexHome: string | undefined

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-thread-model-preferences-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('thread model preferences', () => {
  it('persists normalized preferences with private file permissions', async () => {
    await writeThreadModelPreference(' thread-a ', {
      model: ' gpt-5.6-sol ',
      reasoningEffort: 'MAX',
    })

    await expect(readThreadModelPreferences()).resolves.toEqual({
      'thread-a': {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
      },
    })
    expect((await stat(getThreadModelPreferencesPath())).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent updates without dropping either thread', async () => {
    await Promise.all([
      writeThreadModelPreference('thread-a', { model: 'gpt-5.5', reasoningEffort: 'high' }),
      writeThreadModelPreference('thread-b', { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }),
    ])

    await expect(readThreadModelPreferences()).resolves.toEqual({
      'thread-a': { model: 'gpt-5.5', reasoningEffort: 'high' },
      'thread-b': { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
    })
  })

  it('backs up malformed state before accepting a new preference', async () => {
    await writeFile(getThreadModelPreferencesPath(), '{broken', { encoding: 'utf8', mode: 0o600 })

    await writeThreadModelPreference('thread-a', { model: 'gpt-5.5', reasoningEffort: 'xhigh' })

    const recoveryFiles = await listThreadModelPreferenceRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
    await expect(readThreadModelPreferences()).resolves.toEqual({
      'thread-a': { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
    })
  })

  it('recovers a recent lock left by a process that no longer exists', async () => {
    await writeFile(`${getThreadModelPreferencesPath()}.lock`, '99999999\n0\n', {
      encoding: 'utf8',
      mode: 0o600,
    })

    await writeThreadModelPreference('thread-a', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    })

    await expect(readThreadModelPreferences()).resolves.toEqual({
      'thread-a': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    })
  })

  it('deletes only the requested thread preference', async () => {
    await writeThreadModelPreference('thread-a', { model: 'gpt-5.5', reasoningEffort: 'high' })
    await writeThreadModelPreference('thread-b', { model: 'gpt-5.6-sol', reasoningEffort: 'max' })

    await deleteThreadModelPreference('thread-a')

    await expect(readThreadModelPreferences()).resolves.toEqual({
      'thread-b': { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    })
  })

  it('rejects incomplete or unsupported preferences', async () => {
    await expect(writeThreadModelPreference('', {
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })).rejects.toThrow('Missing threadId')
    await expect(writeThreadModelPreference('thread-a', {
      model: '',
      reasoningEffort: 'impossible',
    })).rejects.toThrow('Invalid thread model preference')
  })
})
