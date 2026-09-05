import { REASONING_EFFORT_VALUES, type ReasoningEffort, type UiModelCapability } from './types/codex'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function effort(value: unknown): ReasoningEffort | null {
  return REASONING_EFFORT_VALUES.includes(value as ReasoningEffort) ? value as ReasoningEffort : null
}

export function normalizeModelCapability(
  value: unknown,
  source: NonNullable<UiModelCapability['metadataSource']> = 'app-server',
): UiModelCapability | null {
  const row = asRecord(value)
  if (!row) return null
  const id = text(row.id) || text(row.model) || text(row.slug)
  if (!id) return null
  const levels = row.supportedReasoningEfforts ?? row.supported_reasoning_levels
  const supportedReasoningEfforts = Array.isArray(levels)
    ? levels.flatMap((value) => {
        const option = asRecord(value)
        const normalized = effort(option?.reasoningEffort ?? option?.effort ?? value)
        return normalized ? [normalized] : []
      })
    : []
  const tiers = row.serviceTiers ?? row.service_tiers
  const speedTiers = row.additionalSpeedTiers ?? row.additional_speed_tiers
  const fastTier = (Array.isArray(tiers) ? tiers : []).map(asRecord).find((tier) => (
    ['fast', 'priority'].includes(text(tier?.id).toLowerCase()) || text(tier?.name).toLowerCase() === 'fast'
  ))
  const supportsFastMode = Boolean(fastTier || (Array.isArray(speedTiers) && speedTiers.some(value => text(value).toLowerCase() === 'fast')))
  const hasTierMetadata = Array.isArray(tiers) || Array.isArray(speedTiers)
  return {
    id,
    displayName: text(row.displayName) || text(row.display_name) || id,
    supportedReasoningEfforts: [...new Set(supportedReasoningEfforts)],
    defaultReasoningEffort: effort(row.defaultReasoningEffort ?? row.default_reasoning_level),
    supportsFastMode,
    metadataSource: source,
    reasoningSupport: Array.isArray(levels) ? (supportedReasoningEfforts.length > 0 ? 'supported' : 'unsupported') : 'unknown',
    fastModeSupport: supportsFastMode ? 'supported' : hasTierMetadata ? 'unsupported' : 'unknown',
    fastServiceTier: supportsFastMode ? text(fastTier?.id) || 'fast' : null,
    fastDescription: text(fastTier?.description) || null,
  }
}

export function providerModelCapability(id: string, metadata: UiModelCapability[] = []): UiModelCapability {
  return metadata.find(model => model.id === id) ?? normalizeModelCapability({ id }, 'provider')!
}
