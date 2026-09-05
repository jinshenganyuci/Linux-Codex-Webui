import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNativeTurnInput, steerThreadTurn } from './codexGateway'
import { nativeCapabilities, normalizeNativeGoal, validateGoalPatch } from '../nativeThreadControls'
import { addNativeQueueInput, getNativeCapabilities, getNativePermissionProfiles, invalidateNativeCapabilities, updateNativeSettings } from './nativeThreadGateway'

describe('native thread protocol', () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  beforeEach(() => { requests.length = 0; invalidateNativeCapabilities() })
  afterEach(() => vi.unstubAllGlobals())

  function respond(handler: (method: string, params: Record<string, unknown>) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
      if (input === '/codex-api/meta/methods') return new Response(JSON.stringify({ data: ['turn/steer'] }))
      const body = JSON.parse(String(options?.body))
      requests.push(body)
      return new Response(JSON.stringify({ result: handler(body.method, body.params) }))
    }))
  }

  it('steers only the expected live turn without start, resume, settings, or replay', async () => {
    respond(() => ({ turnId: 'turn-live' }))
    await steerThreadTurn('thread-1', 'turn-live', 'focus on tests', ['https://example.test/image.png'], [{ name: 'audit', path: '/skills/audit' }])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({ method: 'turn/steer', params: { threadId: 'thread-1', expectedTurnId: 'turn-live', input: [
      { type: 'text', text: 'focus on tests' }, { type: 'image', url: 'https://example.test/image.png' }, { type: 'skill', name: 'audit', path: '/skills/audit' },
    ] } })
  })

  it('does not send when the turn is unknown or replay a refused steer', async () => {
    respond(() => ({ turnId: 'other-turn' }))
    await expect(steerThreadTurn('thread-1', '', 'hello')).rejects.toThrow('当前回合')
    expect(requests).toHaveLength(0)
    await expect(steerThreadTurn('thread-1', 'turn-live', 'hello')).rejects.toThrow('不匹配')
    expect(requests).toHaveLength(1)
  })

  it('keeps attachment references in native input without adding turn-level fields', async () => {
    const input = await buildNativeTurnInput('read it', [], [], [{ label: 'README.md', path: '/repo/README.md', fsPath: '/repo/README.md' }])
    expect(input[0].text).toContain('README.md')
    expect(input[0].text).toContain('read it')
    expect(Object.keys(input[0]).sort()).toEqual(['text', 'type'])
  })

  it('separates current-turn changes from future settings and preserves null service tiers', async () => {
    respond(method => method === 'turn/settings/update' ? { status: 'targetUnavailable' } : {})
    expect(await updateNativeSettings('thread', { model: 'gpt-6-astra', effort: 'ultra', serviceTier: null }, 'turn')).toBe('targetUnavailable')
    expect(await updateNativeSettings('thread', { permissions: ':workspace' })).toBe('saved')
    expect(requests[0].params).toEqual({ threadId: 'thread', turnId: 'turn', model: 'gpt-6-astra', effort: 'ultra', serviceTier: null })
    expect(requests[1].method).toBe('thread/settings/update')
    await expect(updateNativeSettings('thread', { permissions: ':workspace' }, 'turn')).rejects.toThrow('后续回合')
    expect(requests).toHaveLength(2)
  })

  it('requires the complete native queue API and coalesces capability requests', async () => {
    respond(() => ({}))
    expect(nativeCapabilities(['thread/queue/add']).queue).toBe(false)
    const results = await Promise.all(Array.from({ length: 12 }, () => getNativeCapabilities()))
    expect(results.every(value => value.steer && !value.queue)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honors allowed profiles and detects broken pagination rather than looping', async () => {
    respond(() => ({ data: [{ id: ':workspace', allowed: true }, { id: ':danger', allowed: false }], nextCursor: 'again' }))
    await expect(getNativePermissionProfiles()).rejects.toThrow('重复分页')
    expect(requests).toHaveLength(2)
  })

  it('reconciles uncertain queue adds without sending a second add', async () => {
    const submission = { id: 'queued-1', clientUserMessageId: 'client-1', input: [{ type: 'text', text: 'hello' }] }
    vi.stubGlobal('fetch', vi.fn(async (_input: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)); requests.push(body)
      if (body.method === 'thread/queue/add') throw new Error('connection lost')
      return new Response(JSON.stringify({ result: { data: [submission], nextCursor: null } }))
    }))
    expect(await addNativeQueueInput('thread', 'client-1', submission.input)).toEqual(submission)
    expect(requests.map(value => value.method)).toEqual(['thread/queue/add', 'thread/queue/list'])
  })

  it('keeps goal usage separate from status and validates explicit budgets', () => {
    const goal = { threadId: 'thread', objective: 'finish', status: 'active', tokensUsed: 200, tokenBudget: 100, timeUsedSeconds: 7, createdAt: 1, updatedAt: 2 }
    expect(normalizeNativeGoal(goal, 'thread')?.status).toBe('active')
    expect(normalizeNativeGoal(goal, 'another')).toBeNull()
    expect(() => validateGoalPatch({ objective: ' ' })).toThrow()
    expect(() => validateGoalPatch({ tokenBudget: 0 })).toThrow()
    expect(() => validateGoalPatch({ tokenBudget: null })).not.toThrow()
  })
})
