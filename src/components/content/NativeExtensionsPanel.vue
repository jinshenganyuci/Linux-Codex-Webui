<template>
  <Teleport to="body">
    <div class="native-extension-backdrop" @click.self="emit('close')">
      <article ref="dialog" class="native-extension-dialog" role="dialog" aria-modal="true" aria-label="原生扩展" tabindex="-1" data-testid="native-extensions" @keydown="onKeydown">
        <header class="native-extension-heading"><h2>原生扩展</h2><button type="button" data-testid="native-extensions-close" @click="emit('close')">关闭</button></header>
        <nav class="native-extension-tabs" role="tablist" aria-label="扩展能力">
          <button v-for="entry in tabs" :key="entry.id" type="button" role="tab" :aria-selected="tab === entry.id" :data-testid="`extension-tab-${entry.id}`" @click="selectTab(entry.id)">{{ entry.label }}</button>
        </nav>
        <div class="native-extension-body">
          <p v-if="loading" role="status">读取原生能力…</p>
          <p v-if="error" class="native-extension-error" role="alert">{{ error }}</p>
          <p v-if="message" role="status">{{ message }}</p>
          <div v-if="!info && !loading"><button type="button" @click="loadInfo">重新读取能力</button></div>
          <template v-if="info">
            <p class="native-extension-meta">CLI {{ info.cliVersion || '未知' }} · provider {{ info.provider }} · 认证 {{ info.accountType || '未识别／自定义提供商' }}</p>
            <p class="native-extension-meta">能力读取范围：{{ info.threadId ? '当前已加载线程（含项目配置）' : 'CLI 默认配置（不是某个线程的覆盖值）' }}</p>
            <div v-if="tab === 'realtime' && !threadId">请先打开一个会话，再连接实时语音。</div>
            <NativeRealtimePanel v-else-if="tab === 'realtime'" :key="threadId" :thread-id="threadId" :available="supports('realtime')" :enabled="featureEnabled('realtime_conversation')" />
            <NativeRemotePanel v-else-if="tab === 'remote'" :available="supports('remote')" />
            <section v-else-if="tab === 'agents'" class="native-extension-section" data-testid="native-child-threads">
              <h3>派生子任务与历史</h3><button type="button" :disabled="loading" @click="loadChildren">刷新子任务</button>
              <p>按 CLI 的 ancestorThreadId 查询，不扫描全部历史、不逐条 resume。未加载不代表完成；模型与推理字段是线程配置，不是执行遥测。</p>
              <p v-if="!children.length && !loading">CLI 没有返回此线程的派生子任务。</p>
              <p v-if="childrenTruncated">只显示前 200 项，请进入子线程继续查看。</p>
              <ul class="native-extension-list">
                <li v-for="child in children.slice(0, childLimit)" :key="child.id" :data-child-thread="child.id">
                  <div><a :href="childHref(child.id)" @click="emit('close')">{{ child.name }}</a> · {{ child.role || '角色未记录' }} · {{ child.archived ? '已归档' : childStatus(child.status) }}</div>
                  <p>{{ child.preview || '没有任务摘要' }}</p>
                  <p>{{ child.model || '模型未记录' }} / {{ child.effort || '推理未记录' }} · 父线程 {{ child.parentThreadId || '未提供' }}</p>
                </li>
              </ul>
              <button v-if="children.length > childLimit" type="button" @click="childLimit += 20">显示更多子任务</button>
            </section>
            <section v-else-if="tab === 'features'" class="native-extension-section" data-testid="native-feature-panel">
              <h3>插件与实验能力</h3>
              <p>只给当前 CLI 版本中已核对支持运行时切换的稳定能力提供临时开关。0.153.4 不支持 apps/plugins 的运行时修改；开发中或未核对的能力只读，不写 TOML、不重启 CLI。</p>
              <label>搜索能力<input v-model="search" type="search" placeholder="默认显示本批相关能力" /></label>
              <button type="button" :disabled="busy || loading" @click="loadInfo">刷新状态</button>
              <ul class="native-extension-list">
                <li v-for="feature in visibleFeatures" :key="feature.name" :data-feature="feature.name">
                  <div><strong>{{ feature.displayName || feature.name }}</strong> · {{ stageLabel(feature.stage) }} · {{ feature.enabled ? 'CLI 已启用' : 'CLI 未启用' }}</div>
                  <p v-if="feature.description">{{ feature.description }}</p>
                  <p>配置键：features.{{ feature.name }} · 默认 {{ feature.defaultEnabled ? '开启' : '关闭' }}<span v-if="hasRequirement(feature.name)"> · 受托管策略锁定</span></p>
                  <button v-if="canToggle(feature)" type="button" :disabled="busy" @click="pendingFeature = feature">{{ feature.enabled ? '临时关闭' : '临时开启' }}</button>
                </li>
              </ul>
              <p v-if="search && filteredFeatures.length > 40">仅显示前 40 项，请缩小搜索范围。</p>
              <div v-if="pendingFeature" class="native-extension-confirm">
                <p>确认{{ pendingFeature.enabled ? '关闭' : '开启' }} {{ pendingFeature.name }}？作用于整个 CLI 进程，已有回合的实际工具变化以 CLI 为准；不写配置，重启后恢复。</p>
                <button type="button" data-testid="feature-confirm" :disabled="busy" @click="applyFeature">确认临时修改</button><button type="button" @click="pendingFeature = null">取消</button>
              </div>
              <h4>已安装插件的原生状态</h4><a href="#/skills?tab=plugins" @click="emit('close')">打开插件管理：安装、卸载、逐项启用</a>
              <p>安装、插件启用、全局开关、管理员可用性和认证是不同条件；不把已安装当成可调用。</p>
              <p v-if="pluginError" class="native-extension-error">{{ pluginError }}</p>
              <ul class="native-extension-list"><li v-for="plugin in plugins" :key="plugin.id" :data-plugin="plugin.id"><strong>{{ plugin.name }}</strong> · {{ plugin.enabled ? '插件启用' : '插件停用' }} · {{ plugin.availability || '可用性未提供' }}<p>{{ plugin.disabledReason || '没有返回禁用原因' }} · 本地 {{ plugin.localVersion || '未知' }} / 目录 {{ plugin.version || '未知' }}</p></li></ul>
              <p v-if="!plugins.length && !pluginError">CLI 没有返回已安装插件。</p>
            </section>
            <section v-else class="native-extension-section" data-testid="native-context-panel">
              <h3>上下文状态与证据</h3>
              <p>{{ contextCapabilityLabel(info) }}</p>
              <p>普通远端压缩开关：{{ featureEnabled('remote_compaction_v2') ? 'CLI 已启用' : 'CLI 未启用或未提供' }}</p>
              <p data-testid="native-context-window">当前会话 modelContextWindow：{{ tokenUsage?.modelContextWindow?.toLocaleString('zh-CN') || '尚未收到运行时数据' }}</p>
              <p>不会用 TOML 声明值冒充实际上下文窗口，也不会通过输入输出 Token 数推算新上下文引擎已生效。</p>
              <p v-if="compactionNotice">本页观察到压缩事件：{{ compactionNotice }}。这不是新上下文管理引擎已启用的充分证据。</p>
              <p v-else>本页尚未观察到压缩事件；不代表从未压缩。完整对话仍由原历史视图展示。</p>
              <button type="button" :disabled="loading" @click="loadInfo">重新核对 CLI 条件</button>
            </section>
            <p v-for="warning in info.warnings" :key="warning" class="native-extension-error">{{ warning }}</p>
          </template>
        </div>
      </article>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useSubagentNavigation } from '../../router/subagentNavigation'
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { fetchRpcMethodCatalog, rpcCall } from '../../api/codexRpcClient'
import { getExtensionInfo, listNativeChildren, setRuntimeFeature } from '../../api/nativeExtensionsGateway'
import { observeNativeExtensions } from '../../composables/desktop/nativeExtensionEvents'
import { contextCapabilityLabel, extensionRecord, extensionText, NATIVE_EXTENSION_METHODS, RUNTIME_FEATURE_KEYS, RUNTIME_FEATURE_VERSION, type NativeChildThread, type NativeExtensionInfo, type NativeFeature } from '../../nativeExtensions'
import type { UiThreadTokenUsage } from '../../types/codex'

const NativeRealtimePanel = defineAsyncComponent(() => import('./NativeRealtimePanel.vue'))
const NativeRemotePanel = defineAsyncComponent(() => import('./NativeRemotePanel.vue'))
const props = defineProps<{ threadId: string; cwd: string; tokenUsage?: UiThreadTokenUsage | null }>()

const { childHref } = useSubagentNavigation(() => props.threadId)
const emit = defineEmits<{ close: [] }>()
const tabs = [{ id: 'features', label: '插件与能力' }, { id: 'realtime', label: '实时语音' }, { id: 'remote', label: '远程控制' }, { id: 'agents', label: '子任务' }, { id: 'context', label: '上下文' }]
const tab = ref('features')
const info = ref<NativeExtensionInfo | null>(null)
const methods = ref<string[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const message = ref('')
const search = ref('')
const pendingFeature = ref<NativeFeature | null>(null)
const children = ref<NativeChildThread[]>([])
const childrenTruncated = ref(false)
const childLimit = ref(20)
const pluginError = ref('')
const plugins = ref<Array<{ id: string; name: string; enabled: boolean; availability: string; disabledReason: string; version: string; localVersion: string }>>([])
const compactionNotice = ref('')
const dialog = ref<HTMLElement | null>(null)
const returnFocus = document.activeElement as HTMLElement | null
const previousOverflow = document.body.style.overflow
let disposed = false
let loadRevision = 0
let childTimer: ReturnType<typeof setTimeout> | null = null
let childLoad: Promise<void> | null = null
const defaultFeatures = new Set(['apps', 'plugins', 'realtime_conversation', 'context_management', 'multi_agent', 'multi_agent_v2', 'remote_compaction_v2', 'step_model_switching', ...RUNTIME_FEATURE_KEYS])
const filteredFeatures = computed(() => (info.value?.features ?? []).filter(feature => search.value.trim() ? `${feature.name} ${feature.displayName || ''} ${feature.description || ''}`.toLowerCase().includes(search.value.trim().toLowerCase()) : defaultFeatures.has(feature.name)))
const visibleFeatures = computed(() => filteredFeatures.value.slice(0, 40))
const supports = (kind: keyof typeof NATIVE_EXTENSION_METHODS) => NATIVE_EXTENSION_METHODS[kind].every(method => methods.value.includes(method))
const featureEnabled = (name: string) => info.value?.features.find(feature => feature.name === name)?.enabled === true
const stageLabel = (stage: string) => ({ stable: '稳定', beta: '测试阶段', underDevelopment: '开发中', removed: '已移除', deprecated: '已弃用' }[stage] || stage)
const childStatus = (status: string) => ({ notLoaded: '未加载（不代表完成）', idle: '空闲', active: '活动中', systemError: '系统错误' }[status] || status)
const hasRequirement = (name: string) => Object.prototype.hasOwnProperty.call(info.value?.featureRequirements ?? {}, name)
const canToggle = (feature: NativeFeature) => info.value?.cliVersion === RUNTIME_FEATURE_VERSION && info.value.requirementsKnown === true && RUNTIME_FEATURE_KEYS.some(name => name === feature.name) && feature.stage === 'stable' && !hasRequirement(feature.name) && methods.value.includes('experimentalFeature/enablement/set')

async function loadPlugins() {
  pluginError.value = ''
  if (!methods.value.includes('plugin/installed')) { pluginError.value = '当前 CLI 未提供 plugin/installed；不猜测安装状态。'; return }
  try {
    const value = await rpcCall<{ marketplaces: Array<{ plugins: unknown[] }>; marketplaceLoadErrors?: Array<{ message: string }> }>('plugin/installed', { cwds: props.cwd ? [props.cwd] : [] })
    if (disposed) return
    plugins.value = value.marketplaces.flatMap(marketplace => marketplace.plugins).slice(0, 200).flatMap(raw => {
      const row = extensionRecord(raw)
      return row && typeof row.id === 'string' ? [{ id: row.id, name: extensionText(row.name), enabled: row.enabled === true, availability: extensionText(row.availability), disabledReason: extensionText(row.disabledReason), version: extensionText(row.version), localVersion: extensionText(row.localVersion) }] : []
    })
    pluginError.value = (value.marketplaceLoadErrors ?? []).slice(0, 3).map(item => extensionText(item.message)).join('；')
  } catch (failure) { if (!disposed) pluginError.value = failure instanceof Error ? failure.message : '插件状态读取失败。' }
}
async function loadInfo() {
  const revision = ++loadRevision
  loading.value = true; error.value = ''
  try {
    const [nextInfo, nextMethods] = await Promise.all([getExtensionInfo(props.threadId), methods.value.length ? Promise.resolve(methods.value) : fetchRpcMethodCatalog()])
    if (disposed || revision !== loadRevision) return
    info.value = nextInfo; methods.value = nextMethods
    if (tab.value === 'features') await loadPlugins()
    if (tab.value === 'agents') await loadChildren()
  } catch (failure) { if (!disposed && revision === loadRevision) error.value = failure instanceof Error ? failure.message : '能力读取失败。' }
  finally { if (!disposed && revision === loadRevision) loading.value = false }
}
async function loadChildren() {
  if (childLoad) return childLoad
  if (!props.threadId || info.value?.descendantThreads !== true) { error.value = '需要已选线程和经 Schema 确认的 ancestorThreadId 过滤；不会改为扫描全部会话。'; return }
  loading.value = true; error.value = ''
  const pending = listNativeChildren(props.threadId).then(value => { if (!disposed) { children.value = value.data; childrenTruncated.value = value.truncated } }).catch(failure => { if (!disposed) error.value = failure instanceof Error ? failure.message : '子任务读取失败。' }).finally(() => { if (!disposed) loading.value = false; childLoad = null })
  childLoad = pending
  return pending
}
function selectTab(next: string) { tab.value = next; error.value = ''; message.value = ''; if (next === 'agents') void loadChildren(); if (next === 'features' && info.value) void loadPlugins() }
async function applyFeature() {
  const feature = pendingFeature.value
  if (!feature || !canToggle(feature) || busy.value) return
  busy.value = true; error.value = ''; message.value = ''; pendingFeature.value = null
  try { const value = await setRuntimeFeature(feature.name, !feature.enabled, props.threadId); if (!disposed) { info.value = value; message.value = 'CLI 确认运行时开关已更新；未写入配置。'; await loadPlugins() } }
  catch (failure) { if (!disposed) { const detail = failure instanceof Error ? failure.message : '开关未确认'; await loadInfo(); error.value = detail } }
  finally { busy.value = false }
}
const unsubscribe = observeNativeExtensions(notification => {
  const params = extensionRecord(notification.params)
  if (notification.method === 'ready') { methods.value = []; void loadInfo() }
  if (params?.threadId === props.threadId && (notification.method === 'thread/compacted' || (notification.method === 'item/completed' && extensionRecord(params.item)?.type === 'contextCompaction'))) compactionNotice.value = notification.atIso
  const affected = extensionText(params?.threadId) || extensionText(extensionRecord(params?.progress)?.rootThreadId)
  const parent = extensionText(extensionRecord(params?.thread)?.parentThreadId)
  const related = affected === props.threadId || parent === props.threadId || children.value.some(child => child.id === affected || child.id === parent)
  if (related && tab.value === 'agents' && ['thread/started', 'thread/status/changed', 'codex-ui/agent-progress'].includes(notification.method)) {
    if (!childTimer) childTimer = setTimeout(() => { childTimer = null; if (!disposed && tab.value === 'agents') void loadChildren() }, 1000)
  }
})
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close') }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea, [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length)
  const first = controls[0]; const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(() => props.threadId, () => emit('close'))
onMounted(async () => { document.body.style.overflow = 'hidden'; await nextTick(); dialog.value?.focus(); void loadInfo() })
onUnmounted(() => { disposed = true; loadRevision += 1; unsubscribe(); if (childTimer) clearTimeout(childTimer); document.body.style.overflow = previousOverflow; returnFocus?.focus() })
</script>
