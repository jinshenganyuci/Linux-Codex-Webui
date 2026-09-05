<template>
  <section class="native-extension-section" data-testid="native-realtime-panel">
    <h3>原生实时语音</h3>
    <p>WebRTC / V1 音频会话，转写文本由 CLI 通知提供。不会把普通聊天模型当成实时模型。</p>
    <p v-if="!available" role="status">当前 CLI 缺少完整实时接口。</p>
    <p v-else-if="!enabled" role="status">未启用开发中的 realtime_conversation。请先在你选定的配置中显式启用并重启对应 CLI；这里不会自动改配置。</p>
    <p v-if="!browserSupported">麦克风和 WebRTC 需要 HTTPS 或 localhost，以及浏览器授权。</p>
    <p v-if="client.state.foreignSession">该线程已有其他页面或客户端的实时连接；不能抢占。</p>
    <label>实时模型（可留空，使用 CLI 配置）<input v-model="model" maxlength="128" placeholder="使用 CLI 实时模型" :disabled="isActive" /></label>
    <ComposerDropdown v-model="voice" :options="voices.map(value => ({ value, label: value }))" placeholder="CLI 默认声音" :disabled="isActive || !voices.length" />
    <div class="native-extension-actions">
      <button type="button" :disabled="isActive" @click="client.refresh()">刷新连接归属</button>
      <button data-testid="realtime-start" type="button" :disabled="!available || !enabled || !browserSupported || isActive || client.state.foreignSession" @click="client.start(model, voice)">连接并开启麦克风</button>
      <button data-testid="realtime-stop" type="button" :disabled="!isActive" @click="client.stop()">停止实时会话</button>
      <button type="button" @click="client.setMuted(!client.state.muted)">{{ client.state.muted ? '开启播放' : '静音播放' }}</button>
      <button v-if="client.state.playbackBlocked" type="button" @click="client.play()">点击播放声音</button>
    </div>
    <p role="status" data-testid="realtime-status">{{ phaseLabel }}<span v-if="client.state.phase === 'connecting'">；接收启动请求不等于 WebRTC 已连接。</span></p>
    <p v-if="client.state.error" class="native-extension-error" role="alert">{{ client.state.error }}</p>
    <p v-if="client.state.notice" role="status">{{ client.state.notice }}</p>
    <label>向实时会话补充文本<textarea v-model="text" rows="2" maxlength="16000" /></label>
    <button type="button" :disabled="client.state.phase !== 'connected' || !text.trim()" @click="sendText">发送到实时会话</button>
    <div class="native-realtime-transcript" aria-label="实时转写" aria-live="polite">
      <p v-for="(entry, index) in client.state.transcript" :key="index"><strong>{{ entry.role }}：</strong>{{ entry.text }}</p>
    </div>
    <p>只有点击连接才申请麦克风。关闭面板、切换标签页、刷新或断线会停止本页录音；不会自动重连。转写仅本页有界暂存，不保存音频。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ComposerDropdown from './ComposerDropdown.vue'
import { rpcCall } from '../../api/codexRpcClient'
import { createNativeRealtimeClient } from '../../composables/desktop/nativeRealtimeClient'
import { observeNativeExtensions } from '../../composables/desktop/nativeExtensionEvents'

const props = defineProps<{ threadId: string; available: boolean; enabled: boolean }>()
const client = createNativeRealtimeClient(props.threadId)
const model = ref('')
const voice = ref('')
const voices = ref<string[]>([])
const text = ref('')
const browserSupported = Boolean(globalThis.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof globalThis.RTCPeerConnection === 'function')
const isActive = computed(() => !['idle', 'error'].includes(client.state.phase))
const phaseLabel = computed(() => ({ idle: '未连接', preparing: '等待麦克风授权', connecting: '连接中', connected: 'WebRTC 已连接', stopping: '正在停止', error: '未连接／发生错误' }[client.state.phase] || client.state.phase))
const unsubscribe = observeNativeExtensions(client.observe)
const hidden = () => { if (document.hidden) void client.stop('页面转入后台，麦克风已停止。') }
onMounted(async () => {
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('pagehide', client.pagehide)
  try {
    await client.refresh()
    if (props.available) {
      const response = await rpcCall<{ voices: { v1: string[]; defaultV1: string } }>('thread/realtime/listVoices', {})
      voices.value = response.voices.v1.slice(0, 40)
      voice.value = response.voices.defaultV1
    }
  } catch (error) { client.state.error = error instanceof Error ? error.message : '实时能力读取失败。' }
})
onUnmounted(() => { unsubscribe(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', client.pagehide); void client.dispose() })
async function sendText() { const submitted = text.value; if (await client.sendText(submitted) && text.value === submitted) text.value = '' }
</script>
