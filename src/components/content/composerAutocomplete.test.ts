import { describe, expect, it } from 'vitest'
import {
  buildSlashCommandInsertion,
  COMPOSER_SLASH_COMMANDS,
  filterComposerSkills,
  filterComposerSlashCommands,
  findComposerAutocompleteMatch,
  replaceComposerAutocompleteMatch,
} from './composerAutocomplete'

describe('composerAutocomplete', () => {
  it('keeps the terminal palette commands used by the reference flow first', () => {
    expect(COMPOSER_SLASH_COMMANDS.slice(0, 8).map((command) => command.name)).toEqual([
      'model',
      'fast',
      'ide',
      'permissions',
      'keymap',
      'vim',
      'experimental',
      'approve',
    ])
    expect(COMPOSER_SLASH_COMMANDS.some((command) => command.name === 'goal')).toBe(true)
  })

  it('opens slash completion only for a command leading the whole message', () => {
    expect(findComposerAutocompleteMatch('/per', 4)).toEqual({
      trigger: '/',
      query: 'per',
      start: 0,
      end: 4,
    })
    expect(findComposerAutocompleteMatch('first line\n  /mod', 17)).toBeNull()
    expect(findComposerAutocompleteMatch('explain /model', 14)).toBeNull()
  })

  it('finds a skill token anywhere after whitespace and includes text after the cursor', () => {
    expect(findComposerAutocompleteMatch('use $image now', 8)).toEqual({
      trigger: '$',
      query: 'ima',
      start: 4,
      end: 10,
    })
    expect(findComposerAutocompleteMatch('price$usd', 9)).toBeNull()
  })

  it('replaces only the active autocomplete token', () => {
    const match = findComposerAutocompleteMatch('use $image now', 10)
    expect(match).not.toBeNull()
    expect(replaceComposerAutocompleteMatch('use $image now', match!, '')).toEqual({
      text: 'use  now',
      cursor: 4,
    })
  })

  it('filters slash commands by command and description', () => {
    expect(filterComposerSlashCommands('/perm').map((command) => command.name)).toEqual(['permissions', 'delete'])
    expect(filterComposerSlashCommands('model and reasoning').map((command) => command.name)).toContain('model')
  })

  it('keeps argument-taking slash commands ready for continued typing', () => {
    const model = COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'model')
    const goal = COMPOSER_SLASH_COMMANDS.find((command) => command.name === 'goal')
    expect(buildSlashCommandInsertion(model!)).toBe('/model')
    expect(buildSlashCommandInsertion(goal!)).toBe('/goal ')
  })

  it('ranks and caps skill matches without changing the source list', () => {
    const skills = [
      { name: 'docs-helper', displayName: 'Docs Helper', description: 'Reference documentation', path: '/skills/docs' },
      { name: 'imagegen', displayName: 'Image Gen', description: 'Generate images', path: '/skills/imagegen' },
      { name: 'other', description: 'Works with image assets', path: '/skills/other' },
    ]
    expect(filterComposerSkills(skills, '$image', 2).map((skill) => skill.name)).toEqual(['imagegen', 'other'])
    expect(skills.map((skill) => skill.name)).toEqual(['docs-helper', 'imagegen', 'other'])
    expect(filterComposerSkills(skills, '', 1).map((skill) => skill.name)).toEqual(['docs-helper'])
  })
})
