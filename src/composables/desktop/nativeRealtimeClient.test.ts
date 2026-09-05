import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeRealtimeClient } from './nativeRealtimeClient'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function fixture() {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null, muted: false, autoplay: false } as unknown as HTMLAudioElement
  const peer = {
    onconnectionstatechange: null as (() => void) | null, ontrack: null,
    connectionState: 'new', signalingState: 'have-local-offer', localDescription: { sdp: 'local offer' },
    close: vi.fn(), addTrack: vi.fn(), createDataChannel: vi.fn(), createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'local offer' })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}),
  }
  const media = vi.fn(async () => stream)
  const control = vi.fn(async (action: string) => ({ active: action !== 'stop', owned: true, phase: 'accepted' }))
  const snapshot = vi.fn(async () => ({ active: false, owned: false, phase: 'idle' }))
  const client = createNativeRealtimeClient('thread', { media, control, snapshot, peer: () => peer as unknown as RTCPeerConnection, audio: () => audio })
  return { client, control, snapshot, media, peer, track, audio, stream }
}
describe('native browser realtime lifecycle', () => {
  it('can display capability status on HTTP LAN without randomUUID or microphone access', async () => {
    vi.stubGlobal('crypto', undefined)
    const test = fixture()
    await test.client.refresh()
    expect(test.client.state.phase).toBe('idle')
    expect(test.media).not.toHaveBeenCalled()
    await test.client.dispose()
  })

  it('does not keep a connected label or microphone after pagehide and BFCache restoration', async () => {
    const sendBeacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon })
    const test = fixture()
    await test.client.start()
    test.peer.connectionState = 'connected'; test.peer.onconnectionstatechange?.()
    test.client.pagehide()
    expect(test.client.state.phase).toBe('idle')
    expect(test.track.stop).toHaveBeenCalledOnce()
    expect(sendBeacon).toHaveBeenCalledOnce()
    expect(test.client.state.notice).toContain('不会自动重连')
    await test.client.dispose()
  })

  it('replaces streamed transcription with its final text without duplicating the result', async () => {
    const test = fixture()
    await test.client.start()
    test.client.observe({ method: 'thread/realtime/transcript/delta', params: { threadId: 'thread', role: 'assistant', delta: 'draft' }, atIso: '' })
    for (let index = 0; index < 2; index += 1) test.client.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'thread', role: 'assistant', text: 'final' }, atIso: '' })
    expect(test.client.state.transcript).toEqual([{ role: 'assistant', text: 'final', complete: true }])
    await test.client.dispose()
  })

  it('does not request microphone permission before an explicit start and waits for real connectivity', async () => {
    const test = fixture()
    expect(test.media).not.toHaveBeenCalled()
    await test.client.start('', 'cove')
    expect(test.client.state.phase).toBe('connecting')
    expect(test.control.mock.calls[0][0]).toBe('start')
    expect(test.peer.createDataChannel).toHaveBeenCalledWith('oai-events')
    test.client.observe({ method: 'thread/realtime/started', params: { threadId: 'thread' }, atIso: '' })
    expect(test.client.state.phase).toBe('connecting')
    test.client.observe({ method: 'thread/realtime/sdp', params: { threadId: 'other', sdp: 'wrong' }, atIso: '' })
    expect(test.peer.setRemoteDescription).not.toHaveBeenCalled()
    test.client.observe({ method: 'thread/realtime/sdp', params: { threadId: 'thread', sdp: 'answer' }, atIso: '' })
    expect(test.peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' })
    test.peer.connectionState = 'connected'; test.peer.onconnectionstatechange?.()
    expect(test.client.state.phase).toBe('connected')
    await test.client.dispose()
    expect(test.track.stop).toHaveBeenCalledOnce()
    expect(test.peer.close).toHaveBeenCalledOnce()
  })

  it('stops late microphone grants after the panel has closed', async () => {
    const test = fixture()
    let grant!: (stream: MediaStream) => void
    test.media.mockImplementation(() => new Promise(resolve => { grant = resolve }))
    const starting = test.client.start()
    await vi.waitFor(() => expect(grant).toBeTypeOf('function'))
    await test.client.dispose()
    grant(test.stream)
    await starting
    expect(test.track.stop).toHaveBeenCalledOnce()
    expect(test.control).not.toHaveBeenCalled()
  })

  it('does not take over a foreign connection or retry a rejected start', async () => {
    const test = fixture()
    test.snapshot.mockResolvedValueOnce({ active: true, owned: false, phase: 'accepted' })
    await test.client.start()
    expect(test.media).not.toHaveBeenCalled()
    test.control.mockRejectedValueOnce(new Error('provider rejected'))
    await test.client.start()
    expect(test.control.mock.calls.map(call => call[0])).toEqual(['start', 'stop'])
    expect(test.track.stop).toHaveBeenCalledOnce()
    await test.client.dispose()
  })

  it('releases media on lost notifications and bounds transcript memory', async () => {
    const test = fixture()
    await test.client.start()
    for (let index = 0; index < 40; index += 1) test.client.observe({ method: 'thread/realtime/transcript/delta', params: { threadId: 'thread', role: `role-${index}`, delta: 'text'.repeat(3000) }, atIso: '' })
    expect(test.client.state.transcript).toHaveLength(12)
    expect(test.client.state.transcript.every(row => row.text.length <= 8000)).toBe(true)
    test.client.observe({ method: 'connection/status', params: { status: 'reconnecting' }, atIso: '' })
    expect(test.track.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.client.state.phase).toBe('error'))
    expect(test.control.mock.calls.filter(call => call[0] === 'start')).toHaveLength(1)
    await test.client.dispose()
  })
})
