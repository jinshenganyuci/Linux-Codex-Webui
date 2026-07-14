const MODEL_STRENGTH_RANK: Record<string, number> = {
  'gpt-5.6-sol': 900,
  'gpt-5.6-terra': 800,
  'gpt-5.5': 700,
  'gpt-5.6-luna': 600,
  'gpt-5.4': 500,
  'gpt-5.4-mini': 400,
  'gpt-5.3-codex-spark': 300,
  'gpt-5.2': 200,
  'codex-auto-review': 100,
}

function strengthRank(modelId: string): number {
  return MODEL_STRENGTH_RANK[modelId.trim().toLowerCase()] ?? 0
}

export function sortModelIdsByStrength(modelIds: string[]): string[] {
  return modelIds
    .map((modelId, index) => ({ modelId, index, rank: strengthRank(modelId) }))
    .sort((first, second) => second.rank - first.rank || first.index - second.index)
    .map(({ modelId }) => modelId)
}
