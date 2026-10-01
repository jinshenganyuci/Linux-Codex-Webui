import { isBlockingServerRequest } from './serverRequests'
import type { UiServerRequest } from './types/codex'

export const PENDING_REQUEST_DRAFTS_KEY = 'codex-web-local.pending-input-drafts.v1'
export const PENDING_REQUEST_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_DRAFTS = 24
const MAX_STORAGE_CHARS = 128 * 1024
const MAX_DRAFT_CHARS = 16 * 1024

export type PendingInputDraft = {
  answers: Record<string, string>
  otherAnswers: Record<string, string>
}
type StoredDraft = PendingInputDraft & { key: string; updatedAt: number }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function pendingRequestDraftIdentity(request: UiServerRequest): string {
  // receivedAtIso is assigned once by the bridge and retained by pending/list.
  // Include it to isolate a restarted bridge whose generation counter restarts.
  return JSON.stringify([
    request.threadId, request.generation, typeof request.id, request.id,
    request.method, request.turnId, request.itemId, request.receivedAtIso,
  ])
}

export function orderPendingRequests(requests: UiServerRequest[]): UiServerRequest[] {
  return [...requests].sort((a, b) => Number(isBlockingServerRequest(b)) - Number(isBlockingServerRequest(a)))
}

export function selectPendingRequest(requests: UiServerRequest[], selectedKey: string): UiServerRequest | null {
  return requests.find((request) => pendingRequestDraftIdentity(request) === selectedKey)
    ?? requests.find(isBlockingServerRequest) ?? requests[0] ?? null
}

export function isUserInputRequest(request: UiServerRequest): boolean {
  return ['item/tool/requestUserInput', 'request_user_input', 'request_user_input_async'].includes(request.method)
}

export function isSecretInputQuestion(question: { isSecret?: unknown; secret?: unknown }): boolean {
  return question.isSecret === true || question.secret === true
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 100 && Object.values(value).every((entry) => typeof entry === 'string')
}

export function createPendingRequestDraftStore(storage: DraftStorage | null, now = Date.now) {
  function readAll(): StoredDraft[] {
    if (!storage) return []
    try {
      const raw = storage.getItem(PENDING_REQUEST_DRAFTS_KEY)
      if (!raw || raw.length > MAX_STORAGE_CHARS) return []
      const data: unknown = JSON.parse(raw)
      if (!Array.isArray(data)) return []
      return data.filter((entry): entry is StoredDraft => (
        entry && typeof entry.key === 'string' && entry.key.length <= 4096
        && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        && entry.updatedAt <= now() && entry.updatedAt > now() - PENDING_REQUEST_DRAFT_TTL_MS
        && isStringRecord(entry.answers) && isStringRecord(entry.otherAnswers)
      )).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DRAFTS)
    } catch { return [] }
  }

  function writeAll(rows: StoredDraft[]): boolean {
    if (!storage) return false
    try {
      let serialized = JSON.stringify(rows)
      while (serialized.length > MAX_STORAGE_CHARS && rows.length > 0) {
        rows.pop()
        serialized = JSON.stringify(rows)
      }
      if (rows.length === 0) storage.removeItem(PENDING_REQUEST_DRAFTS_KEY)
      else storage.setItem(PENDING_REQUEST_DRAFTS_KEY, serialized)
      return true
    } catch { return false }
  }

  return {
    read(key: string): PendingInputDraft | null {
      const row = readAll().find((entry) => entry.key === key)
      return row ? { answers: row.answers, otherAnswers: row.otherAnswers } : null
    },
    write(key: string, draft: PendingInputDraft): boolean {
      if (!isStringRecord(draft.answers) || !isStringRecord(draft.otherAnswers)) return false
      if (key.length > 4096 || JSON.stringify(draft).length > MAX_DRAFT_CHARS) return false
      const rows = readAll().filter((row) => row.key !== key)
      if (Object.values(draft.answers).some(Boolean) || Object.values(draft.otherAnswers).some(Boolean)) {
        rows.unshift({ key, ...draft, updatedAt: now() })
      }
      return writeAll(rows.slice(0, MAX_DRAFTS))
    },
    remove(key: string): boolean { return writeAll(readAll().filter((row) => row.key !== key)) },
  }
}
