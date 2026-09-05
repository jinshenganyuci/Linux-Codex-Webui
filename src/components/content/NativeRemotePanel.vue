<template>
  <section class="native-extension-section" data-testid="native-remote-panel">
    <h3>CLI 原生远程控制</h3>
    <p>不是 WebUI 的网页访问地址。启用后可由已配对客户端控制这个 CLI；默认不启动，只提供显式的临时启用。</p>
    <p v-if="!available">当前 CLI 缺少完整远控接口。</p>
    <template v-else>
      <p role="status" data-testid="remote-status">状态：{{ statusLabel }} · {{ status?.serverName || '未读取' }}</p>
      <p>状态由 CLI 提供；“连接中”不等于已连接，API key／自定义 provider 的认证限制仍由 CLI 执行。</p>
      <div class="native-extension-actions">
        <button type="button" :disabled="busy" @click="readStatus">刷新状态</button>
        <button type="button" data-testid="remote-enable" :disabled="busy || !status || status.status !== 'disabled'" @click="confirmEnable = true">临时启用远控</button>
        <button type="button" data-testid="remote-disable" :disabled="busy || !status || status.status === 'disabled'" @click="disable">停用远控</button>
      </div>
      <div v-if="confirmEnable" class="native-extension-confirm">
        <p>确认临时开放此 CLI 给已配对远端客户端？作用于整个 CLI 进程，不写入配置，重启后恢复原有配置。</p>
        <button type="button" data-testid="remote-confirm-enable" :disabled="busy" @click="enable">确认临时启用</button>
        <button type="button" @click="confirmEnable = false">取消</button>
      </div>
      <div v-if="status?.status === 'connected'" class="native-extension-section">
        <button type="button" data-testid="remote-pair" :disabled="busy" @click="startPairing">生成临时配对码</button>
        <div v-if="pairing && remainingSeconds > 0" class="native-extension-confirm" data-testid="remote-pairing">
          <p>配对码只在本页显示，不写入浏览器存储或日志；请勿公开分享。</p>
          <code>{{ pairing.manualPairingCode || pairing.pairingCode }}</code>
          <p>剩余 {{ remainingSeconds }} 秒</p>
          <button type="button" :disabled="busy" @click="checkPairing">查询配对结果</button>
          <button type="button" @click="clearPairing">隐藏配对码</button>
        </div>
        <p v-if="pairing && remainingSeconds <= 0">配对码已过期，请重新生成。</p>
        <h4>已配对客户端</h4>
        <button type="button" :disabled="busy" @click="readClients">刷新客户端</button>
        <p v-if="!clients.length">当前没有返回客户端。</p>
        <ul class="native-extension-list">
          <li v-for="client in clients" :key="client.clientId">
            <span>{{ client.displayName || client.clientId }} · {{ client.platform || '平台未知' }}</span>
            <button type="button" :disabled="busy" @click="revokeTarget = client.clientId">撤销访问</button>
          </li>
        </ul>
        <div v-if="revokeTarget" class="native-extension-confirm">
          <p>确认撤销该客户端的远控访问？</p>
          <button type="button" data-testid="remote-confirm-revoke" :disabled="busy" @click="revoke">确认撤销</button>
          <button type="button" @click="revokeTarget = ''">取消</button>
        </div>
      </div>
    </template>
    <p v-if="error" class="native-extension-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p>关闭面板不会擅自断开用户显式开启的远控；停用请点击上面的按钮。实验 remote_control 标记可能已移除，不据此猜测远控接口是否存在。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { rpcCall } from '../../api/codexRpcClient'
import { observeNativeExtensions } from '../../composables/desktop/nativeExtensionEvents'
import { extensionRecord, type NativePairing, type NativeRemoteClient, type NativeRemoteStatus } from '../../nativeExtensions'

const props = defineProps<{ available: boolean }>()
const status = ref<NativeRemoteStatus | null>(null)
const clients = ref<NativeRemoteClient[]>([])
const pairing = ref<NativePairing | null>(null)
const confirmEnable = ref(false)
const revokeTarget = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')
const now = ref(Date.now())
let disposed = false
let statusRevision = 0
let timer: ReturnType<typeof setInterval> | null = null
const statusLabel = computed(() => ({ disabled: '已停用', connecting: '连接中', connected: '已连接', errored: '连接出错' }[status.value?.status ?? 'disabled']))
const remainingSeconds = computed(() => pairing.value ? Math.max(0, Math.ceil(((pairing.value.expiresAt > 1e12 ? pairing.value.expiresAt : pairing.value.expiresAt * 1000) - now.value) / 1000)) : 0)
function clearPairing() { pairing.value = null; if (timer) clearInterval(timer); timer = null }
function setStatus(value: NativeRemoteStatus) {
  if (!['disabled', 'connecting', 'connected', 'errored'].includes(value.status)) throw new Error('CLI 返回未知远控状态。')
  if (disposed) return
  if (status.value?.environmentId !== value.environmentId || value.status !== 'connected') { clients.value = []; clearPairing(); revokeTarget.value = '' }
  status.value = value
}
async function operation(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await action() } catch (failure) { if (!disposed) error.value = failure instanceof Error ? failure.message : '远控请求失败，不会自动重试。' }
  finally { busy.value = false }
}
async function readStatus() {
  await operation(async () => {
    const revision = statusRevision
    const value = await rpcCall<NativeRemoteStatus>('remoteControl/status/read', {})
    if (revision === statusRevision) setStatus(value)
  })
}
async function enable() { confirmEnable.value = false; await operation(async () => { const revision = statusRevision; const value = await rpcCall<NativeRemoteStatus>('remoteControl/enable', { ephemeral: true }); if (revision === statusRevision) setStatus(value) }) }
async function disable() { await operation(async () => { const revision = statusRevision; const value = await rpcCall<NativeRemoteStatus>('remoteControl/disable', { ephemeral: true }); if (revision === statusRevision) setStatus(value) }) }
async function loadClients() {
  const environmentId = status.value?.environmentId
  if (!environmentId || status.value?.status !== 'connected') return
  const rows: NativeRemoteClient[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for (let page = 0; page < 10; page += 1) {
    const result: { data: NativeRemoteClient[]; nextCursor?: string | null } = await rpcCall('remoteControl/client/list', { environmentId, cursor, limit: 50, order: 'desc' })
    if (!Array.isArray(result.data)) throw new Error('客户端列表无效。')
    rows.push(...result.data)
    cursor = result.nextCursor ?? null
    if (!cursor) break
    if (seen.has(cursor) || page === 9) throw new Error('客户端分页超过上限或游标重复。')
    seen.add(cursor)
  }
  if (!disposed && status.value?.environmentId === environmentId && status.value.status === 'connected') clients.value = rows
}
async function readClients() { await operation(loadClients) }
async function startPairing() {
  await operation(async () => {
    const environmentId = status.value?.environmentId
    const value = await rpcCall<NativePairing>('remoteControl/pairing/start', { manualCode: true })
    if (disposed || value.environmentId !== environmentId || status.value?.environmentId !== environmentId) return
    if (typeof value.pairingCode !== 'string' || value.pairingCode.length > 8192 || !Number.isFinite(value.expiresAt)) throw new Error('配对信息无效。')
    clearPairing(); pairing.value = value; now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now(); if (remainingSeconds.value <= 0 && timer) { clearInterval(timer); timer = null } }, 1000)
  })
}
async function checkPairing() {
  await operation(async () => {
    const current = pairing.value
    if (!current || remainingSeconds.value <= 0) return
    const result = await rpcCall<{ claimed: boolean }>('remoteControl/pairing/status', { pairingCode: current.pairingCode })
    if (disposed || pairing.value !== current) return
    message.value = result.claimed ? 'CLI 确认已完成配对。' : 'CLI 尚未确认配对。'
    if (result.claimed) { clearPairing(); await loadClients() }
  })
}
async function revoke() {
  await operation(async () => {
    const environmentId = status.value?.environmentId
    const clientId = revokeTarget.value
    if (!environmentId || !clientId) return
    await rpcCall('remoteControl/client/revoke', { environmentId, clientId })
    revokeTarget.value = ''; await loadClients()
  })
}
const unsubscribe = observeNativeExtensions(notification => {
  if (notification.method === 'remoteControl/status/changed') {
    const value = extensionRecord(notification.params)
    if (value && typeof value.status === 'string') { statusRevision += 1; try { setStatus(value as NativeRemoteStatus) } catch { error.value = '未知远控通知，请刷新核对。' } }
  }
})
onMounted(() => { if (props.available) void readStatus() })
onUnmounted(() => { disposed = true; clearPairing(); unsubscribe() })
</script>
