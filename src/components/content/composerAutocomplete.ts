export type ComposerAutocompleteTrigger = '/' | '$'

export type ComposerAutocompleteMatch = {
  trigger: ComposerAutocompleteTrigger
  query: string
  start: number
  end: number
}

export type ComposerSlashCommand = {
  name: string
  description: string
  supportsInlineArgs?: boolean
}

export type ComposerSkillCandidate = {
  name: string
  displayName?: string
  description: string
  path: string
}

// Keep the frequently used entries in the same presentation order as the Codex
// terminal palette. `/fast` is exposed by Fast-enabled builds, including the
// reference flow used by this WebUI.
export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { name: 'model', description: 'choose what model and reasoning effort to use' },
  { name: 'fast', description: '1.5x speed, increased usage' },
  { name: 'ide', description: 'include current selection, open files, and other context from your IDE', supportsInlineArgs: true },
  { name: 'permissions', description: 'choose what Codex is allowed to do' },
  { name: 'keymap', description: 'remap TUI shortcuts', supportsInlineArgs: true },
  { name: 'vim', description: 'toggle Vim mode for the composer' },
  { name: 'experimental', description: 'toggle experimental features' },
  { name: 'approve', description: 'approve one retry of a recent auto-review denial' },
  { name: 'setup-default-sandbox', description: 'set up elevated agent sandbox' },
  { name: 'memories', description: 'configure memory use and generation' },
  { name: 'skills', description: 'use skills to improve how Codex performs specific tasks' },
  { name: 'import', description: 'import setup, this project, and recent chats from Claude Code' },
  { name: 'hooks', description: 'view and manage lifecycle hooks' },
  { name: 'review', description: 'review my current changes and find issues', supportsInlineArgs: true },
  { name: 'rename', description: 'rename the current thread', supportsInlineArgs: true },
  { name: 'new', description: 'start a new chat during a conversation' },
  { name: 'archive', description: 'archive this session and exit' },
  { name: 'delete', description: 'permanently delete this session and exit' },
  { name: 'resume', description: 'resume a saved chat', supportsInlineArgs: true },
  { name: 'fork', description: 'fork the current chat' },
  { name: 'init', description: 'create an AGENTS.md file with instructions for Codex' },
  { name: 'compact', description: 'summarize conversation to prevent hitting the context limit' },
  { name: 'plan', description: 'switch to Plan mode', supportsInlineArgs: true },
  { name: 'goal', description: 'set or view the goal for a long-running task', supportsInlineArgs: true },
  { name: 'agent', description: 'switch the active agent thread' },
  { name: 'side', description: 'start a side conversation in an ephemeral fork', supportsInlineArgs: true },
  { name: 'btw', description: 'start a side conversation in an ephemeral fork', supportsInlineArgs: true },
  { name: 'copy', description: 'copy last response as markdown' },
  { name: 'raw', description: 'toggle raw scrollback mode for copy-friendly terminal selection', supportsInlineArgs: true },
  { name: 'diff', description: 'show git diff (including untracked files)' },
  { name: 'mention', description: 'mention a file' },
  { name: 'status', description: 'show current session configuration and token usage' },
  { name: 'usage', description: 'view account usage or use a usage limit reset', supportsInlineArgs: true },
  { name: 'debug-config', description: 'show config layers and requirement sources for debugging' },
  { name: 'title', description: 'configure which items appear in the terminal title' },
  { name: 'statusline', description: 'configure which items appear in the status line' },
  { name: 'theme', description: 'choose a syntax highlighting theme' },
  { name: 'pets', description: 'choose or hide the terminal pet', supportsInlineArgs: true },
  { name: 'mcp', description: 'list configured MCP tools; use /mcp verbose for details', supportsInlineArgs: true },
  { name: 'apps', description: 'manage apps' },
  { name: 'plugins', description: 'browse plugins' },
  { name: 'logout', description: 'log out of Codex' },
  { name: 'quit', description: 'exit Codex' },
  { name: 'exit', description: 'exit Codex' },
  { name: 'feedback', description: 'send logs to maintainers' },
  { name: 'ps', description: 'list background terminals' },
  { name: 'stop', description: 'stop all background terminals' },
  { name: 'clear', description: 'clear the terminal and start a new chat' },
  { name: 'personality', description: 'choose a communication style for Codex' },
  { name: 'subagents', description: 'switch the active agent thread' },
]

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length
  return Math.max(0, Math.min(text.length, Math.trunc(cursor)))
}

function tokenEndAfterCursor(text: string, cursor: number): number {
  let end = cursor
  while (end < text.length && !/\s/u.test(text[end] ?? '')) end += 1
  return end
}

export function findComposerAutocompleteMatch(
  text: string,
  cursor: number,
): ComposerAutocompleteMatch | null {
  const safeCursor = clampCursor(text, cursor)
  const beforeCursor = text.slice(0, safeCursor)

  const slashMatch = beforeCursor.match(/^[\t ]*(\/([a-zA-Z0-9-]*))$/u)
  if (slashMatch) {
    const token = slashMatch[1] ?? '/'
    return {
      trigger: '/',
      query: slashMatch[2] ?? '',
      start: safeCursor - token.length,
      end: tokenEndAfterCursor(text, safeCursor),
    }
  }

  const skillMatch = beforeCursor.match(/(?:^|\s)(\$([^\s$]*))$/u)
  if (!skillMatch) return null
  const token = skillMatch[1] ?? '$'
  return {
    trigger: '$',
    query: skillMatch[2] ?? '',
    start: safeCursor - token.length,
    end: tokenEndAfterCursor(text, safeCursor),
  }
}

export function replaceComposerAutocompleteMatch(
  text: string,
  match: ComposerAutocompleteMatch,
  replacement: string,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, match.start))
  const end = Math.max(start, Math.min(text.length, match.end))
  return {
    text: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
    cursor: start + replacement.length,
  }
}

export function buildSlashCommandInsertion(command: ComposerSlashCommand): string {
  return `/${command.name}${command.supportsInlineArgs ? ' ' : ''}`
}

export function filterComposerSlashCommands(query: string): ComposerSlashCommand[] {
  const normalizedQuery = query.trim().replace(/^\//u, '').toLowerCase()
  if (!normalizedQuery) return [...COMPOSER_SLASH_COMMANDS]
  return COMPOSER_SLASH_COMMANDS.filter((command) => (
    command.name.includes(normalizedQuery)
    || command.description.toLowerCase().includes(normalizedQuery)
  ))
}

export function filterComposerSkills<T extends ComposerSkillCandidate>(
  skills: readonly T[],
  query: string,
  limit = 50,
): T[] {
  const normalizedQuery = query.trim().replace(/^\$/u, '').toLowerCase()
  const normalizedLimit = Math.max(0, Math.trunc(limit))
  if (normalizedLimit === 0) return []
  if (!normalizedQuery) return skills.slice(0, normalizedLimit)

  const prefixMatches: T[] = []
  const nameMatches: T[] = []
  const descriptionMatches: T[] = []
  for (const skill of skills) {
    const displayName = (skill.displayName || skill.name).toLowerCase()
    const name = skill.name.toLowerCase()
    const description = skill.description.toLowerCase()
    if (displayName.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) {
      if (prefixMatches.length < normalizedLimit) prefixMatches.push(skill)
      continue
    }
    if (displayName.includes(normalizedQuery) || name.includes(normalizedQuery)) {
      if (nameMatches.length < normalizedLimit) nameMatches.push(skill)
      continue
    }
    if (description.includes(normalizedQuery) && descriptionMatches.length < normalizedLimit) {
      descriptionMatches.push(skill)
    }
  }
  return [...prefixMatches, ...nameMatches, ...descriptionMatches].slice(0, normalizedLimit)
}
