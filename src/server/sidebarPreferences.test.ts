import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getSidebarPreferencesPath,
  listSidebarPreferenceRecoveryFiles,
  normalizeSidebarPreferencesPatch,
  patchSidebarPreferences,
  readSidebarPreferences,
} from './sidebarPreferences'

let codexHome = ''
let previousCodexHome: string | undefined

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = await mkdtemp(join(tmpdir(), 'codex-sidebar-preferences-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await rm(codexHome, { recursive: true, force: true })
})

describe('sidebar preferences', () => {
  it('returns expanded defaults before any browser has stored preferences', async () => {
    await expect(readSidebarPreferences()).resolves.toEqual({
      version: 1,
      revision: 0,
      persisted: false,
      sections: {
        pinned: true,
        chats: true,
        projects: true,
      },
      collapsedProjects: {},
    })
  })

  it('initializes once from legacy browser state and uses private file permissions', async () => {
    const result = await patchSidebarPreferences({
      initializeOnly: true,
      sections: {
        pinned: false,
        chats: true,
        projects: false,
      },
      collapsedProjects: {
        '/repo/a': true,
        '/repo/b': false,
      },
    })

    expect(result).toMatchObject({
      applied: true,
      preferences: {
        revision: 1,
        persisted: true,
        sections: {
          pinned: false,
          chats: true,
          projects: false,
        },
        collapsedProjects: {
          '/repo/a': true,
        },
      },
    })
    expect((await stat(getSidebarPreferencesPath())).mode & 0o777).toBe(0o600)
  })

  it('does not let a second browser migration overwrite stored state', async () => {
    await patchSidebarPreferences({
      initializeOnly: true,
      collapsedProjects: { '/repo/a': true },
    })

    const secondMigration = await patchSidebarPreferences({
      initializeOnly: true,
      sections: { projects: false },
      collapsedProjects: { '/repo/b': true },
    })

    expect(secondMigration.applied).toBe(false)
    expect(secondMigration.preferences.sections.projects).toBe(true)
    expect(secondMigration.preferences.collapsedProjects).toEqual({ '/repo/a': true })
    expect(secondMigration.preferences.revision).toBe(1)
  })

  it('serializes concurrent field patches without dropping unrelated clicks', async () => {
    await Promise.all([
      patchSidebarPreferences({ sections: { chats: false } }),
      patchSidebarPreferences({ collapsedProjects: { '/repo/a': true } }),
      patchSidebarPreferences({ collapsedProjects: { '/repo/b': true } }),
    ])

    await expect(readSidebarPreferences()).resolves.toMatchObject({
      revision: 3,
      persisted: true,
      sections: {
        pinned: true,
        chats: false,
        projects: true,
      },
      collapsedProjects: {
        '/repo/a': true,
        '/repo/b': true,
      },
    })
  })

  it('removes only the explicitly expanded project', async () => {
    await patchSidebarPreferences({
      collapsedProjects: {
        '/repo/a': true,
        '/repo/b': true,
      },
    })
    await patchSidebarPreferences({ collapsedProjects: { '/repo/a': false } })

    expect((await readSidebarPreferences()).collapsedProjects).toEqual({ '/repo/b': true })
  })

  it('backs up malformed state before accepting another click', async () => {
    await writeFile(getSidebarPreferencesPath(), '{broken', { encoding: 'utf8', mode: 0o600 })

    await patchSidebarPreferences({ sections: { pinned: false } })

    const recoveryFiles = await listSidebarPreferenceRecoveryFiles()
    expect(recoveryFiles).toHaveLength(1)
    expect(await readFile(join(codexHome, recoveryFiles[0]), 'utf8')).toBe('{broken')
    expect((await readSidebarPreferences()).sections.pinned).toBe(false)
  })

  it('rejects malformed and empty field patches', async () => {
    expect(normalizeSidebarPreferencesPatch({})).toBeNull()
    expect(normalizeSidebarPreferencesPatch({ sections: { chats: 'yes' } })).toBeNull()
    expect(normalizeSidebarPreferencesPatch({ collapsedProjects: { '': true } })).toBeNull()
    await expect(patchSidebarPreferences({ collapsedProjects: { '/repo/a': 'yes' } }))
      .rejects.toThrow('Invalid sidebar preference patch')
  })
})
