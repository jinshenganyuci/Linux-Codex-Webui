import { describe, expect, it, vi } from 'vitest'
import { createExtensionInfoReader, NativeRealtimeSessions } from './nativeExtensionRuntime'
import { contextCapabilityLabel, isVolatileRealtimeNotification } from '../nativeExtensions'

const options = { outputModality: 'audio', version: 'v1', transport: { type: 'webrtc', sdp: 'test SDP' } }

describe('native extension runtime', () => {
  it('filters secrets, preserves feature locks, and coalesces simultaneous reads', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'config/read') return { config: { model_provider: 'myproxy', token: 'SECRET_SENTINEL' } }
      if (method === 'account/read') return { account: { type: 'apiKey', email: 'SECRET_SENTINEL' } }
      if (method === 'configRequirements/read') return { requirements: { featureRequirements: { plugins: false }, token: 'SECRET_SENTINEL' } }
      return { data: [{ name: 'context_management', stage: 'underDevelopment', enabled: true, defaultEnabled: false }], nextCursor: null }
    })
    const reader = createExtensionInfoReader(rpc, () => ({ codex: { version: '0.153.4', generation: 1 } }))
    const reports = await Promise.all(Array.from({ length: 20 }, () => reader.read()))
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(reports)).not.toContain('SECRET_SENTINEL')
    expect(reports[0].featureRequirements).toEqual({ plugins: false })
    expect(contextCapabilityLabel(reports[0])).toContain('不能据此认定实际生效')
    reader.invalidate()
    await reader.read()
    expect(rpc).toHaveBeenCalledTimes(8)
  })

  it('invalidates on generation changes and reports unavailable evidence', async () => {
    let generation = 1
    const rpc = vi.fn(async (method: string) => {
      if (method === 'experimentalFeature/list') return { data: [], nextCursor: null }
      throw new Error('unavailable')
    })
    const reader = createExtensionInfoReader(rpc, () => ({ codex: { version: '0.153.4', generation } }))
    expect((await reader.read()).warnings).toHaveLength(3)
    generation = 2
    await reader.read()
    expect(rpc).toHaveBeenCalledTimes(8)
  })

  it('serializes ownership across tabs and never interrupts an ordinary turn', async () => {
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({}))
    const sessions = new NativeRealtimeSessions(rpc)
    const starts = await Promise.allSettled([sessions.request('start', 'thread', 'owner', options), sessions.request('start', 'thread', 'other', options)])
    expect(starts.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(sessions.snapshot('thread', 'other').owned).toBe(false)
    await expect(sessions.request('stop', 'thread', 'other')).rejects.toThrow('其他页面')
    await sessions.request('text', 'thread', 'owner', { text: 'hello' })
    expect(rpc).toHaveBeenLastCalledWith('thread/realtime/appendText', { threadId: 'thread', text: 'hello' })
    await sessions.request('stop', 'thread', 'owner')
    expect(sessions.snapshot('thread', 'owner').active).toBe(false)
    expect(rpc).not.toHaveBeenCalledWith('turn/interrupt', expect.anything())
  })

  it('uses verified V1 WebRTC semantics rather than unsupported V2', async () => {
    const rpc = vi.fn(async () => ({}))
    const sessions = new NativeRealtimeSessions(rpc)
    await expect(sessions.request('start', 'thread', 'owner', { ...options, version: 'v2' })).rejects.toThrow('V1')
    expect(rpc).not.toHaveBeenCalled()
    await sessions.request('start', 'thread', 'owner', options)
    sessions.observe('thread/realtime/started', { threadId: 'thread' }, 1)
    expect(sessions.snapshot('thread', 'owner').phase).toBe('accepted')
    sessions.observe('ready', {}, 2)
    expect(sessions.snapshot('thread', 'owner').active).toBe(false)
  })

  it('cleans abandoned leases without closing external clients', async () => {
    let now = 100
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({}))
    const sessions = new NativeRealtimeSessions(rpc, () => now)
    await sessions.request('start', 'ours', 'owner', options)
    sessions.observe('thread/realtime/started', { threadId: 'external' })
    now += 31000
    await sessions.sweep()
    expect(rpc).toHaveBeenLastCalledWith('thread/realtime/stop', { threadId: 'ours' })
    expect(sessions.snapshot('external', 'owner').active).toBe(true)
    await sessions.dispose()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('never retries uncertain starts and classifies audio/SDP as non-replayable', async () => {
    const rpc = vi.fn(async (method: string) => { if (method.endsWith('/start')) throw new Error('lost confirmation'); return {} })
    const sessions = new NativeRealtimeSessions(rpc)
    await expect(sessions.request('start', 'thread', 'owner', options)).rejects.toThrow('lost confirmation')
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/realtime/start', 'thread/realtime/stop'])
    expect(isVolatileRealtimeNotification('thread/realtime/sdp')).toBe(true)
    expect(isVolatileRealtimeNotification('thread/realtime/outputAudio/delta')).toBe(true)
    expect(isVolatileRealtimeNotification('turn/completed')).toBe(false)
  })
})
