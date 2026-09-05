import type { UiMessage } from './types/codex'

const EXISTING_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'commandExecution', 'fileChange', 'imageView', 'imageGeneration', 'image_generation'])
const MAX_BODY = 32 * 1024

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit = MAX_BODY): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_BODY + 1)
  if (!Array.isArray(value)) return ''
  let body = ''
  for (const part of value.slice(0, 64)) {
    body += `${text(record(part).text, MAX_BODY + 1 - body.length)}\n`
    if (body.length > MAX_BODY) break
  }
  return body
}

export function normalizeRuntimeItem(value: unknown, completed = true): UiMessage | null {
  const row = record(value)
  const id = text(row.id, 512)
  const type = text(row.type, 128)
  if (!id || !type || EXISTING_ITEMS.has(type)) return null
  let title = 'Codex activity'
  let body = [type, text(row.name, 256), text(row.tool, 256)].filter(Boolean).join(' · ')
  let agentThreadId: string | undefined
  if (type === 'sleep') {
    title = 'Waiting'
    body = typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? `${Math.max(0, row.durationMs)} ms` : ''
  } else if (type === 'functionCallOutput') {
    title = 'Tool output'
    body = [text(row.namespace, 256), text(row.name, 256)].filter(Boolean).join('.') + '\n' + contentText(row.output)
  } else if (type === 'subAgentActivity') {
    title = 'Subagent activity'
    body = [text(row.agentPath, 512), text(row.kind, 128)].filter(Boolean).join(' · ')
    agentThreadId = text(row.agentThreadId, 512) || undefined
  } else if (type === 'hookPrompt') {
    title = 'Hook context'
    body = contentText(row.fragments)
  } else if (type === 'contextCompaction') {
    title = 'Context compacted'
    body = ''
  }
  return {
    id,
    role: 'system',
    text: title,
    messageType: type,
    isUnhandled: title === 'Codex activity',
    runtimeItem: {
      title,
      body: body.slice(0, MAX_BODY),
      status: completed ? text(row.status, 64) || 'completed' : 'inProgress',
      ...(agentThreadId ? { agentThreadId } : {}),
      truncated: body.length > MAX_BODY || row.outputTruncated === true,
    },
  }
}
