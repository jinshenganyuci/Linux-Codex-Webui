import { reactive } from 'vue'
import { controlRealtime, getRealtimeSnapshot } from '../../api/nativeExtensionsGateway'
import { extensionRecord, extensionText } from '../../nativeExtensions'
import type { RpcNotification } from '../../api/codexRpcClient'

type Dependencies = {
  media: () => Promise<MediaStream>
  peer: () => RTCPeerConnection
  audio: () => HTMLAudioElement
  control: typeof controlRealtime
  snapshot: typeof getRealtimeSnapshot
}

export function createNativeRealtimeClient(threadId: string, dependencies: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    media: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
    peer: () => new RTCPeerConnection(), audio: () => new Audio(), control: controlRealtime, snapshot: getRealtimeSnapshot,
    ...dependencies,
  }
  const state = reactive({ phase: 'idle', error: '', notice: '', transcript: [] as Array<{ role: string; text: string; complete?: boolean }>, muted: false, playbackBlocked: false, foreignSession: false })
  let generation = 0
  const newOwnerId = () => globalThis.crypto?.randomUUID?.() ?? `realtime-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let ownerId = newOwnerId()
  let stream: MediaStream | null = null
  let peer: RTCPeerConnection | null = null
  let speaker: HTMLAudioElement | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let connectionTimeout: ReturnType<typeof setTimeout> | null = null
  let requested = false
  let stopping: Promise<void> | null = null
  let disposed = false

  function releaseMedia() {
    if (heartbeat) clearInterval(heartbeat)
    if (connectionTimeout) clearTimeout(connectionTimeout)
    heartbeat = null
    connectionTimeout = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    if (peer) { peer.onconnectionstatechange = null; peer.ontrack = null; peer.close(); peer = null }
    if (speaker) { speaker.pause(); speaker.srcObject = null; speaker = null }
  }

  async function refresh() {
    try {
      const result = await deps.snapshot(threadId, ownerId)
      if (!disposed) state.foreignSession = result.active && !result.owned
    } catch (failure) { if (!disposed) state.error = failure instanceof Error ? failure.message : '连接归属读取失败。' }
  }

  async function stop(reason = ''): Promise<void> {
    if (stopping) return stopping
    generation += 1
    const targetOwner = ownerId
    const shouldStop = requested
    requested = false
    releaseMedia()
    state.phase = shouldStop ? 'stopping' : 'idle'
    if (reason) state.error = reason
    const pending = (async () => {
      if (shouldStop) {
        try { await deps.control('stop', threadId, targetOwner) }
        catch { state.error = '麦克风已停止，但 CLI 停止未确认；服务器会按租约清理，请核对后重连。' }
      }
      state.phase = state.error ? 'error' : 'idle'
    })()
    stopping = pending
    try { await pending } finally { if (stopping === pending) stopping = null }
  }

  async function play() {
    if (!speaker) return
    try { await speaker.play(); state.playbackBlocked = false } catch { state.playbackBlocked = true }
  }

  async function start(model = '', voice = '') {
    if (disposed || stopping || !['idle', 'error'].includes(state.phase)) return
    const revision = ++generation
    const current = () => !disposed && revision === generation
    ownerId = newOwnerId()
    state.error = ''
    state.notice = ''
    state.transcript = []
    state.phase = 'preparing'
    try {
      const status = await deps.snapshot(threadId, ownerId)
      if (!current()) return
      if (status.active) { state.foreignSession = true; throw new Error('该线程已有实时会话，不会接管其他页面的麦克风。') }
      const microphone = await deps.media()
      if (!current()) { microphone.getTracks().forEach(track => track.stop()); return }
      stream = microphone
      const connection = deps.peer()
      peer = connection
      speaker = deps.audio()
      speaker.autoplay = true
      speaker.muted = state.muted
      connection.ontrack = event => {
        if (!current() || !speaker) return
        speaker.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void play()
      }
      for (const track of microphone.getTracks()) connection.addTrack(track, microphone)
      connection.createDataChannel('oai-events')
      connection.onconnectionstatechange = () => {
        if (!current()) return
        if (connection.connectionState === 'connected') {
          state.phase = 'connected'
          if (connectionTimeout) clearTimeout(connectionTimeout)
          connectionTimeout = null
        } else if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) void stop('实时连接已断开；已停止麦克风，不会自动重连。')
      }
      await connection.setLocalDescription(await connection.createOffer())
      if (!current()) return
      const sdp = connection.localDescription?.sdp
      if (!sdp) throw new Error('浏览器未生成 SDP。')
      requested = true
      state.phase = 'connecting'
      heartbeat = setInterval(() => { void deps.control('heartbeat', threadId, ownerId).catch(() => stop('实时租约失联；已停止麦克风。')) }, 10000)
      connectionTimeout = setTimeout(() => { void stop('实时连接超时；没有把 CLI 接收请求当成已连接。') }, 25000)
      const result = await deps.control('start', threadId, ownerId, { outputModality: 'audio', version: 'v1', transport: { type: 'webrtc', sdp }, ...(model.trim() ? { model: model.trim() } : {}), ...(voice ? { voice } : {}) })
      if (current() && (!result.active || !result.owned)) throw new Error('CLI 没有保留本页的实时会话。')
    } catch (error) {
      if (current()) await stop(error instanceof Error ? error.message : '实时会话启动失败。')
    }
  }

  async function sendText(text: string): Promise<boolean> {
    if (state.phase !== 'connected' || !requested) return false
    try { await deps.control('text', threadId, ownerId, { text }); return true }
    catch (error) { state.error = error instanceof Error ? error.message : '实时文本未确认。'; return false }
  }

  function observe(notification: RpcNotification) {
    if (notification.method === 'connection/status' && extensionRecord(notification.params)?.status !== 'connected' && requested) { void stop('通知连接断开；已停止麦克风，不自动重连。'); return }
    const params = extensionRecord(notification.params)
    if (params?.threadId !== threadId || !requested) return
    if (notification.method === 'thread/realtime/sdp' && peer) {
      const connection = peer
      if (connection.signalingState !== 'have-local-offer') return
      const revision = generation
      void connection.setRemoteDescription({ type: 'answer', sdp: extensionText(params.sdp, 128 * 1024) }).catch(error => { if (generation === revision) void stop(error.message) })
    } else if (notification.method === 'thread/realtime/error') void stop(extensionText(params.message, 2000) || 'CLI 实时会话失败。')
    else if (notification.method === 'thread/realtime/closed') { requested = false; state.notice = `CLI 实时会话已结束：${extensionText(params.reason, 500) || '未提供原因'}`; void stop() }
    else if (notification.method === 'thread/realtime/transcript/delta' || notification.method === 'thread/realtime/transcript/done') {
      const complete = notification.method.endsWith('/done')
      const role = extensionText(params.role, 32) || 'unknown'
      const delta = extensionText(complete ? params.text : params.delta, 8000)
      const last = state.transcript.at(-1)
      if (last?.role === role && !last.complete) { last.text = complete ? delta : (last.text + delta).slice(-8000); last.complete = complete }
      else if (!(complete && last?.role === role && last.text === delta)) state.transcript.push({ role, text: delta, complete })
      state.transcript = state.transcript.slice(-12)
    }
  }

  function setMuted(muted: boolean) { state.muted = muted; if (speaker) speaker.muted = muted }
  function pagehide() {
    const payload = requested ? JSON.stringify({ action: 'stop', threadId, ownerId }) : ''
    generation += 1
    requested = false
    releaseMedia()
    state.phase = 'idle'
    state.notice = '页面离开后已停止麦克风；返回页面不会自动重连。'
    if (payload && typeof navigator.sendBeacon === 'function') navigator.sendBeacon('/codex-api/realtime-session', new Blob([payload], { type: 'application/json' }))
  }
  async function dispose() { disposed = true; await stop() }
  return { state, refresh, start, stop, observe, sendText, play, setMuted, pagehide, dispose }
}
