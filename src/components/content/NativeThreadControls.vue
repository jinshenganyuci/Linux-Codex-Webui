<template>
  <div v-if="state.threadId" class="native-controls-entry" data-testid="native-thread-controls">
    <button ref="trigger" type="button" class="native-controls-trigger" :class="{ 'is-active': state.expanded, 'has-notice': state.error || state.goal?.status === 'active' }" :aria-expanded="state.expanded" :aria-controls="dialogId" aria-haspopup="dialog" aria-label="会话控制：模型、权限、目标与队列" title="会话控制" data-testid="native-controls-toggle" @click="state.expanded ? close(false, $event.detail === 0) : open('settings', $event.detail === 0)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h5m4 0h7M4 17h9m4 0h3" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg>
    </button>
    <Teleport to="body">
      <div v-if="rendered" class="native-controls-overlay" :data-open="state.expanded" @click.self="close()">
        <article ref="dialog" :id="dialogId" class="native-thread-controls native-controls-dialog" :data-sheet-expanded="sheetExpanded" :style="panelStyle" role="dialog" aria-modal="true" aria-label="会话控制" tabindex="-1">
          <button type="button" class="native-controls-grabber" :aria-label="sheetExpanded ? '收小设置面板' : '展开设置面板'" :aria-expanded="sheetExpanded" @pointerdown="onDragStart" @pointermove="onDragMove" @pointerup="onDragEnd" @pointercancel="onDragCancel" @lostpointercapture="onDragCancel" @click="onGrabberClick"><span /></button>
          <header class="native-controls-heading">
            <div><h2>会话控制</h2><span class="native-controls-muted">仅作用于当前会话</span></div>
            <button type="button" class="native-controls-close" aria-label="关闭会话控制" @click="close(true, $event.detail === 0)">×</button>
          </header>
          <nav class="native-controls-tabs" aria-label="会话控制分组">
            <div class="native-controls-segments" :data-keyboard="keyboardSection" :style="{ '--segment-count': sections.length, '--segment-index': Math.max(0, sections.findIndex(item => item.id === section)) }">
              <span class="native-controls-selection" aria-hidden="true" />
              <button v-for="item in sections" :key="item.id" type="button" :aria-pressed="section === item.id" @click="section = item.id; keyboardSection = $event.detail === 0">{{ item.label }}</button>
            </div>
            <button class="native-controls-extension-link" type="button" data-testid="native-extensions-open" @click="openExtensions">扩展 ↗</button>
          </nav>
          <div class="native-controls-scroll">
            <p v-if="state.loading" class="native-controls-muted" role="status">读取会话状态…</p>
            <p v-if="state.error" class="native-controls-error" role="alert">{{ state.error }} <button type="button" :disabled="state.busy || state.loading" @click="controller.reload()">重新读取</button></p>
            <p v-if="state.message" class="native-controls-message" role="status">{{ state.message }}</p>

            <div class="native-controls-body">
              <section v-show="section === 'settings'" aria-label="原生运行设置">
                <h3>模型与运行设置</h3>
                <dl class="native-settings-values">
                  <div><dt>模型</dt><dd>{{ settingsPatch.model || '未选择模型' }}</dd></div>
                  <div><dt>推理</dt><dd>{{ settingsPatch.effort || '默认' }}</dd></div>
                  <div><dt>速度</dt><dd>{{ settingsPatch.serviceTier === 'priority' ? '快速' : settingsPatch.serviceTier || '标准' }}</dd></div>
                </dl>
                <div class="native-controls-actions">
                  <button type="button" data-testid="native-apply-turn" :disabled="unavailable || !state.capabilities.turnSettings || !activeTurnId || !isRunning" @click="controller.applySettings(settingsPatch, activeTurnId)">应用到当前回合</button>
                  <button type="button" data-testid="native-apply-thread" :disabled="unavailable || !state.capabilities.threadSettings" @click="controller.applySettings(settingsPatch)">保存为会话设置</button>
                </div>
                <details class="native-controls-help"><summary>这些设置何时生效？</summary><p class="native-controls-muted">应用输入框中选择的模型、推理和速度。保存为会话设置用于后续回合；应用到当前回合只影响后续步骤，已开始的步骤不变。插话仅追加输入。</p></details>
                <details v-if="state.capabilities.turnSettingsReason" class="native-controls-help"><summary>当前回合设置暂不可用</summary><p class="native-controls-muted">{{ state.capabilities.turnSettingsReason }}</p></details>
                <p v-if="state.settings" data-testid="native-effective-settings">CLI 会话设置：{{ state.settings.model }} / {{ state.settings.effort || '默认推理' }} / {{ state.settings.serviceTier || '标准速度' }}</p>
                <p v-else class="native-controls-muted">会话加载后显示 CLI 确认的设置，不用全局默认冒充实际值。</p>
              </section>

              <section v-show="section === 'settings'" v-if="state.capabilities.permissions" aria-label="原生会话权限">
                <h3>会话权限</h3>
                <ComposerDropdown data-testid="native-permission-picker" :model-value="state.settings?.permissionProfile || ''" :options="permissionOptions" placeholder="选择 CLI 允许的权限配置" :disabled="unavailable || permissionOptions.length === 0" open-direction="up" enable-search @update:model-value="applyPermission" />
                <p class="native-controls-muted">仅用于本会话的后续回合，不改变全局默认或当前步骤权限。{{ forbiddenProfileCount ? `另有 ${forbiddenProfileCount} 项被 CLI 策略禁止，未提供选择。` : '' }}</p>
                <p v-if="selectedProfileDescription" class="native-controls-muted">{{ selectedProfileDescription }}</p>
              </section>

              <section v-show="section === 'goal'" v-if="state.capabilities.goals" aria-label="原生 Goal">
                <h3>持续目标 <span v-if="state.goal" class="native-controls-muted">· {{ goalStatus }}</span></h3>
                <p v-if="state.goal" data-testid="native-goal-usage">已用 {{ formatNumber(state.goal.tokensUsed) }} tokens<span v-if="state.goal.tokenBudget !== null"> / 预算 {{ formatNumber(state.goal.tokenBudget) }}</span> · {{ formatNumber(state.goal.timeUsedSeconds) }} 秒</p>
                <p class="native-controls-muted">设置一个持续完成的任务，可随时暂停。</p><details class="native-controls-help"><summary>目标与用量说明</summary><p class="native-controls-muted">这是 CLI 持久目标，不是 update_plan 计划卡；Token 用量不代表完成百分比。</p></details>
                <p v-if="state.goal" class="native-controls-muted">修改目标文本会重置目标用量；仅修改预算会保留用量记录。</p>
                <label class="native-controls-field">目标<textarea v-model="objective" data-testid="native-goal-objective" rows="2" maxlength="4000" placeholder="明确写下你希望完成的目标" @input="goalDirty = true" /></label>
                <label class="native-controls-field">Token 预算（可选）<input v-model="budget" data-testid="native-goal-budget" type="text" inputmode="numeric" placeholder="留空不设置预算" @input="goalDirty = true" /></label>
                <div class="native-controls-actions">
                  <button type="button" data-testid="native-goal-save" :disabled="unavailable || !objective.trim()" @click="saveGoal">{{ state.goal ? '保存目标' : '创建目标' }}</button>
                  <button v-if="state.goal" type="button" data-testid="native-goal-toggle" :disabled="unavailable" @click="controller.saveGoal({ status: state.goal.status === 'active' ? 'paused' : 'active' })">{{ state.goal.status === 'active' ? '暂停目标' : '启用目标' }}</button>
                  <button v-if="state.goal" type="button" data-testid="native-goal-clear" :disabled="unavailable" @click="clearGoal">{{ confirmClear ? '确认清除目标' : '清除目标' }}</button>
                </div>
              </section>

              <section v-show="section === 'queue'" v-if="state.capabilities.queue || state.mode === 'native'" aria-label="队列归属">
                <h3>队列归属：{{ state.mode === 'native' ? 'Codex CLI' : 'WebUI 兼容队列' }}</h3>
                <p class="native-controls-muted">原生队列按 CLI 会话设置执行，不保存逐条模型或一次性规划设置。旧消息不会被自动搬运或丢弃；请先完成旧队列再切换。</p>
                <button type="button" data-testid="native-queue-toggle" :disabled="unavailable || !state.capabilities.queue || isRunning || legacyQueueCount > 0 || state.queue.length > 0" @click="controller.changeQueueMode(state.mode === 'native' ? 'legacy' : 'native')">{{ state.mode === 'native' ? '切回兼容队列' : '启用原生队列' }}</button>
                <p v-if="isRunning || legacyQueueCount > 0 || state.queue.length > 0" class="native-controls-muted">需要会话空闲，并且两种队列都为空。</p>
              </section>
              <p v-if="!state.loading && !Object.values(state.capabilities).some(Boolean)" class="native-controls-muted">当前 CLI 未提供这些原生接口，保留原有功能。</p>
            </div>

          </div>
        </article>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, useId } from 'vue'
import ComposerDropdown from './ComposerDropdown.vue'
import { advanceSheetSpring, sheetReleaseAction } from './sheetMotion'
import type { createNativeThreadController } from '../../composables/desktop/nativeThreadController'
import type { NativeSettingsPatch } from '../../nativeThreadControls'

const props = defineProps<{
  controller: ReturnType<typeof createNativeThreadController>
  settingsPatch: NativeSettingsPatch
  activeTurnId: string
  isRunning: boolean
  legacyQueueCount: number
}>()
const emit = defineEmits<{ extensions: [] }>()
const state = computed(() => props.controller.state)
const unavailable = computed(() => state.value.loading || state.value.busy)
const objective = ref('')
const budget = ref('')
const goalDirty = ref(false)
const confirmClear = ref(false)
const goalStatus = computed(() => ({ active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算受限', complete: '已完成' })[state.value.goal?.status ?? 'active'])
const permissionOptions = computed(() => state.value.profiles.filter(profile => profile.allowed).map(profile => ({ value: profile.id, label: profile.id })))
const forbiddenProfileCount = computed(() => state.value.profiles.filter(profile => !profile.allowed).length)
const selectedProfileDescription = computed(() => state.value.profiles.find(profile => profile.id === state.value.settings?.permissionProfile)?.description)
const formatNumber = (value: number) => value.toLocaleString('zh-CN')

watch(() => state.value.threadId, () => { goalDirty.value = false; confirmClear.value = false; objective.value = ''; budget.value = '' })
watch(() => [state.value.goal?.objective, state.value.goal?.tokenBudget], () => {
  if (goalDirty.value) return
  objective.value = state.value.goal?.objective ?? ''
  budget.value = state.value.goal?.tokenBudget == null ? '' : String(state.value.goal.tokenBudget)
}, { immediate: true })

async function saveGoal() {
  const nextObjective = objective.value.trim()
  await props.controller.saveGoal({
    ...(state.value.goal?.objective === nextObjective ? {} : { objective: nextObjective }),
    tokenBudget: budget.value.trim() ? Number(budget.value) : null,
  })
  if (!state.value.error) {
    goalDirty.value = false
    confirmClear.value = false
    objective.value = state.value.goal?.objective ?? ''
    budget.value = state.value.goal?.tokenBudget == null ? '' : String(state.value.goal.tokenBudget)
  }
}

async function clearGoal() {
  if (!confirmClear.value) { confirmClear.value = true; return }
  await props.controller.removeGoal()
  if (!state.value.error) { confirmClear.value = false; goalDirty.value = false; objective.value = ''; budget.value = '' }
}

function applyPermission(id: string) {
  if (!state.value.profiles.some(profile => profile.id === id && profile.allowed)) return
  void props.controller.applySettings({ permissions: id })
}

const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const dialogId = `native-controls-${useId()}`
const section = ref<'settings' | 'goal' | 'queue'>('settings')
const panelStyle = ref<Record<string, string>>({})
const sections = computed(() => [
  { id: 'settings' as const, label: '运行与权限' },
  ...(state.value.capabilities.goals ? [{ id: 'goal' as const, label: '目标' }] : []),
  ...(state.value.capabilities.queue || state.value.mode === 'native' ? [{ id: 'queue' as const, label: '队列' }] : []),
])
const rendered = ref(false)
const sheetExpanded = ref(false)
const keyboardSection = ref(false)
let instantOpen = false
let frame = 0
let position = 0
let velocity = 0
let motionTarget = 0
let lastFrame = 0
let motionExtent = 1
let drag: { id: number; start: number; offset: number; last: number; time: number; velocity: number } | null = null
let dragged = false
let disposed = false
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const mobilePanel = () => window.innerWidth < 768

function paintMotion() {
  if (!dialog.value) return
  dialog.value.style.transform = `translate3d(0, ${position}px, 0)`
  dialog.value.style.opacity = String(mobilePanel() ? 1 : Math.max(0, Math.min(1, 1 - position / motionExtent)))
}
function stopMotion() { if (frame) cancelAnimationFrame(frame); frame = 0; lastFrame = 0 }
function animateTo(target: number, instant = false) {
  stopMotion()
  motionTarget = target
  if (instant || reducedMotion()) {
    position = target; velocity = 0; paintMotion()
    if (!state.value.expanded) rendered.value = false
    return
  }
  const tick = (time: number) => {
    const step = advanceSheetSpring(position, velocity, motionTarget, lastFrame ? (time - lastFrame) / 1000 : 1 / 60)
    lastFrame = time; position = step.position; velocity = step.velocity; paintMotion()
    if (step.settled) {
      frame = 0; lastFrame = 0
      if (!state.value.expanded) rendered.value = false
    } else frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}
function onDragStart(event: PointerEvent) {
  if (!mobilePanel() || event.button !== 0 || !state.value.expanded) return
  stopMotion()
  dragged = false
  drag = { id: event.pointerId, start: event.clientY, offset: position, last: event.clientY, time: event.timeStamp, velocity: 0 }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function onDragMove(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  const delta = event.clientY - drag.start
  if (Math.abs(delta) > 6) dragged = true
  const elapsed = event.timeStamp - drag.time
  if (elapsed > 0) drag.velocity = (event.clientY - drag.last) / elapsed * 1000
  drag.last = event.clientY; drag.time = event.timeStamp
  position = Math.max(0, drag.offset) + (delta < 0 ? delta * 0.18 : delta)
  paintMotion()
}
function onDragEnd(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  const delta = event.clientY - drag.start
  velocity = event.timeStamp - drag.time > 100 ? 0 : drag.velocity
  drag = null
  const action = sheetReleaseAction(delta, velocity)
  if (action === 'close') close()
  else {
    if (action === 'expand') { sheetExpanded.value = true; positionPanel() }
    animateTo(0)
  }
}
function onDragCancel() { if (drag) { drag = null; velocity = 0; animateTo(0) } }
function onGrabberClick(event: MouseEvent) {
  if (dragged) { dragged = false; return }
  sheetExpanded.value = !sheetExpanded.value
  positionPanel()
  if (event.detail === 0) animateTo(0, true)
}

let returnFocus: HTMLElement | null = null

function positionPanel() {
  const viewport = window.visualViewport
  const height = viewport?.height ?? window.innerHeight
  const offset = viewport?.offsetTop ?? 0
  if (window.innerWidth < 768) {
    panelStyle.value = { left: '8px', right: '8px', bottom: `${Math.max(0, window.innerHeight - height - offset) + 8}px`, maxHeight: `${Math.max(120, sheetExpanded.value ? height - 32 : Math.min(height - 32, height * 0.74))}px`, ...(sheetExpanded.value ? { height: `${Math.max(120, height - 32)}px` } : {}) }
  } else {
    const rect = trigger.value?.getBoundingClientRect()
    const bottom = rect ? window.innerHeight - rect.top + 10 : 140
    panelStyle.value = { left: `${Math.max(16, Math.min(rect?.left ?? 16, window.innerWidth - 536))}px`, bottom: `${bottom}px`, width: '520px', maxHeight: `${Math.max(160, Math.min(640, window.innerHeight - bottom - 16))}px` }
  }
}
function close(restoreFocus = false, instant = false) {
  props.controller.state.expanded = false
  if (instant) { stopMotion(); rendered.value = false }
  if (restoreFocus) {
    const target = returnFocus?.isConnected && returnFocus !== document.body && returnFocus !== document.documentElement && returnFocus.getClientRects().length ? returnFocus : trigger.value?.getClientRects().length ? trigger.value : document.querySelector<HTMLElement>('.thread-composer-attach-trigger')
    target?.focus()
  }
}
async function open(next: 'settings' | 'goal' | 'queue' = 'settings', instant = false) {
  instantOpen = instant
  section.value = next
  if (!state.value.expanded) await props.controller.expand()
}
function openExtensions() { close(false, true); emit('extensions') }
function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  // ComposerDropdown renders its list outside the dialog. Let its search handle Escape first.
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true, true); return }
  if (event.key !== 'Tab') return
  const roots: HTMLElement[] = dialog.value ? [dialog.value] : []
  dialog.value?.querySelectorAll('[aria-controls]').forEach(el => {
    const menu = document.getElementById(el.getAttribute('aria-controls') || '')
    if (menu) roots.push(menu)
  })
  const controls = roots.flatMap(root => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]).filter(el => el.getClientRects().length > 0)
  const first = controls[0]; const last = controls.at(-1)
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
function removeListeners() {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', positionPanel)
  window.visualViewport?.removeEventListener('resize', positionPanel)
  window.visualViewport?.removeEventListener('scroll', positionPanel)
}
watch(() => state.value.expanded, async expanded => {
  removeListeners()
  if (!expanded) {
    drag = null
    if (rendered.value) animateTo(mobilePanel() ? (dialog.value?.offsetHeight ?? 600) + 32 : motionExtent)
    return
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const fresh = !rendered.value
  rendered.value = true
  positionPanel()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', positionPanel)
  window.visualViewport?.addEventListener('resize', positionPanel)
  window.visualViewport?.addEventListener('scroll', positionPanel)
  await nextTick()
  if (disposed || !state.value.expanded) return
  if (fresh) {
    motionExtent = mobilePanel() ? (dialog.value?.offsetHeight ?? 500) + 32 : 12
    position = motionExtent; velocity = 0; paintMotion()
  }
  animateTo(0, instantOpen || Boolean(returnFocus?.matches(':focus-visible')))
  instantOpen = false
  dialog.value?.focus({ preventScroll: true })
}, { immediate: true })
watch(() => state.value.threadId, () => { close(false, true); section.value = 'settings'; sheetExpanded.value = false })
onBeforeUnmount(() => { disposed = true; stopMotion(); removeListeners() })
defineExpose({ open })
</script>
