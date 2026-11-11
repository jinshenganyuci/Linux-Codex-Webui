import type { UiProjectGroup } from '../../types/codex'

export type ComposerChatSuggestion = {
  id: string
  title: string
  projectName: string
}

export function searchComposerChats(
  groups: UiProjectGroup[],
  query: string,
  limit = 8,
): ComposerChatSuggestion[] {
  const needle = query.trim().toLowerCase()
  if (!needle || limit <= 0) return []

  const seen = new Set<string>()
  const maxResults = Math.floor(limit)
  const matches: Array<ComposerChatSuggestion & { score: number; updatedAtIso: string }> = []
  for (const group of groups) {
    for (const thread of group.threads) {
      const id = thread.id.trim()
      if (!id || seen.has(id)) continue

      const title = thread.title.trim() || thread.preview.trim()
      if (!title) continue
      seen.add(id)
      const projectName = thread.projectName.trim() || group.projectName.trim()
      const lowerTitle = title.toLowerCase()
      const lowerPreview = thread.preview.toLowerCase()
      const lowerProject = projectName.toLowerCase()
      const score = lowerTitle === needle
        ? 0
        : lowerTitle.startsWith(needle)
          ? 1
          : lowerTitle.includes(needle)
            ? 2
            : lowerPreview.includes(needle)
              ? 3
              : lowerProject.includes(needle)
                ? 4
                : -1
      if (score < 0) continue

      const candidate = {
        id,
        title,
        projectName,
        score,
        updatedAtIso: thread.updatedAtIso,
      }
      let insertAt = 0
      while (insertAt < matches.length) {
        const current = matches[insertAt]
        if (candidate.score < current.score || (
          candidate.score === current.score && candidate.updatedAtIso > current.updatedAtIso
        )) break
        insertAt += 1
      }
      if (insertAt >= maxResults) continue
      matches.splice(insertAt, 0, candidate)
      if (matches.length > maxResults) matches.pop()
    }
  }
  return matches.map(({ id, title, projectName }) => ({ id, title, projectName }))
}
