<template>
  <div ref="rootRef" class="model-reasoning-dropdown">
    <button ref="triggerRef" class="model-reasoning-trigger" :class="{ 'is-open': isOpen }" type="button"
      :aria-label="triggerAccessibleLabel" :title="triggerAccessibleLabel" :aria-expanded="isOpen" :aria-controls="layerId" aria-haspopup="dialog"
      :disabled="disabled" @pointerdown.prevent @click="toggleMenu($event)">
      <IconTablerBolt v-if="isFastModeSelected" class="model-reasoning-trigger-fast-icon" />
      <span class="model-reasoning-trigger-summary"><span class="model-reasoning-trigger-model">{{ compactSelectedModelLabel }}</span> <span>{{ selectedReasoningLabel }}</span></span>
    </button>
    <Teleport to="body">
      <div v-if="isOpen && isMobileLayout && isModelMenuOpen" class="model-config-backdrop" :style="{ zIndex: (layerZIndex || 80) - 1 }" @pointerdown.self="closeMenu()" />
      <div v-if="isOpen" :id="layerId" ref="layerRef" class="model-reasoning-layer" :class="{ 'is-mobile-layout': isMobileLayout, 'is-model-open': isModelMenuOpen }"
        :style="layerStyle" role="dialog" :aria-label="isModelMenuOpen ? '模型配置' : t('Reasoning')" :aria-modal="isMobileLayout && isModelMenuOpen || undefined" @keydown="onLayerKey">
        <div v-if="!isModelMenuOpen" class="model-reasoning-menu">
          <div class="model-reasoning-heading">
            <button class="model-reasoning-model-row" type="button" aria-label="选择模型" @click="openModelMenu">
              <span class="model-reasoning-current-effort" :class="{ 'is-ultra': previewEffort === 'ultra' }">{{ previewLabel }} <IconTablerChevronRight /></span>
              <span class="model-reasoning-current-model">{{ compactSelectedModelLabel }}</span>
            </button>
            <button class="model-reasoning-reset" type="button" title="恢复模型默认强度" aria-label="恢复模型默认强度" :disabled="!resetEffort || disabled" @click="resetReasoning">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4v5h5M4.8 8a8 8 0 1 1-.7 7" /></svg>
            </button>
          </div>
          <ReasoningEffortSlider v-if="reasoningOptions.length" :key="selectedModel" :model-value="effectiveEffort" :options="reasoningOptions" :disabled="disabled"
            @preview="previewEffort = $event" @update:model-value="selectReasoning" />
          <p v-else class="model-reasoning-empty">当前模型未提供可调强度</p>
        </div>
        <div v-else class="model-reasoning-model-menu">
          <div class="model-config-grabber" aria-hidden="true" />
          <div class="model-config-heading"><button type="button" aria-label="返回思考强度" @click="backToReasoning">‹</button><h2>配置</h2></div>
          <ul class="model-reasoning-list" role="listbox" :aria-label="t('Model')">
            <li v-for="option in modelOptions" :key="option.value">
              <button class="model-reasoning-option" :class="{ 'is-selected': selectedModel === option.value }" type="button" role="option"
                :aria-selected="selectedModel === option.value" @click="selectModel(option.value)">
                <span>{{ compactModelLabel(option.label) }}</span><span class="model-reasoning-check" aria-hidden="true">{{ selectedModel === option.value ? '✓' : '' }}</span>
              </button>
            </li>
          </ul>
          <details v-if="capabilityNotice" class="model-config-capability"><summary>模型能力说明</summary><p>{{ capabilityNotice }}</p></details>
          <button class="model-config-done" type="button" @click="closeMenu(true)">完成</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import type { ReasoningEffort, SpeedMode } from '../../types/codex'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import ReasoningEffortSlider from './ReasoningEffortSlider.vue'
type DropdownOption<T extends string = string> = { value: T; label: string }
const props = defineProps<{
  selectedModel: string; selectedReasoningEffort: ReasoningEffort | ''; selectedSpeedMode: SpeedMode
  defaultReasoningEffort?: ReasoningEffort | null; isFastModeSupported?: boolean; capabilityNotice?: string
  modelOptions: DropdownOption[]; reasoningOptions: DropdownOption<ReasoningEffort>[]; disabled?: boolean; openDirection?: 'up' | 'down'; layerZIndex?: number
}>()
const emit = defineEmits<{ 'update:selected-model': [value: string]; 'update:selected-reasoning-effort': [value: ReasoningEffort] }>()
const { t } = useUiLanguage()
const rootRef = ref<HTMLElement | null>(null), triggerRef = ref<HTMLButtonElement | null>(null), layerRef = ref<HTMLElement | null>(null)
const isOpen = ref(false), isModelMenuOpen = ref(false), isMobileLayout = ref(false)
const layerStyle = ref<Record<string,string>>({}), previewEffort = ref<ReasoningEffort | ''>('')
const layerId = `model-reasoning-${useId()}`
const compactModelLabel = (label: string) => label.trim().replace(/^gpt[-\s]?/i, '').replace(/-(astra|sol|terra|luna)/ig, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()}`)
const compactSelectedModelLabel = computed(() => compactModelLabel(props.modelOptions.find(o => o.value === props.selectedModel)?.label || props.selectedModel || t('Model')))
const resetEffort = computed(() => props.reasoningOptions.find(o => o.value === props.defaultReasoningEffort)?.value || '')
const effectiveEffort = computed(() => props.reasoningOptions.find(o => o.value === props.selectedReasoningEffort)?.value || resetEffort.value || props.reasoningOptions[0]?.value || '')
const selectedReasoningLabel = computed(() => props.reasoningOptions.find(o => o.value === effectiveEffort.value)?.label || t('Thinking'))
const previewLabel = computed(() => props.reasoningOptions.find(o => o.value === previewEffort.value)?.label || selectedReasoningLabel.value)
const isFastModeSelected = computed(() => props.selectedSpeedMode === 'fast' && props.isFastModeSupported)
const triggerAccessibleLabel = computed(() => `${t('Model')}: ${compactSelectedModelLabel.value}, ${t('Reasoning')}: ${selectedReasoningLabel.value}`)
let frame = 0, observer: ResizeObserver | null = null
function positionMenu() {
  if (!isOpen.value || !rootRef.value) return
  const vv = window.visualViewport, leftEdge = vv?.offsetLeft || 0, topEdge = vv?.offsetTop || 0, width = vv?.width || innerWidth, height = vv?.height || innerHeight
  const mobile = width < 768; isMobileLayout.value = mobile
  const config = mobile && isModelMenuOpen.value, menuWidth = config ? width : Math.min(mobile ? 360 : 282, width - 24)
  const rect = rootRef.value.getBoundingClientRect(), menuHeight = Math.min(layerRef.value?.offsetHeight || 144, height - 20)
  const left = config ? leftEdge : Math.max(leftEdge + 12, Math.min(rect.right - menuWidth, leftEdge + width - menuWidth - 12))
  const top = config ? topEdge + height - menuHeight : Math.max(topEdge + 10, Math.min(props.openDirection === 'down' ? rect.bottom + 8 : rect.top - menuHeight - 12, topEdge + height - menuHeight - 10))
  layerStyle.value = { position:'fixed',left:`${left}px`,top:`${top}px`,width:`${menuWidth}px`,maxHeight:`${height - 20}px`,zIndex:String(props.layerZIndex || 80) }
}
function schedulePosition() { if (!frame && isOpen.value) frame = requestAnimationFrame(() => { frame = 0; positionMenu() }) }
function closeMenu(restoreFocus = false) { isOpen.value = false; isModelMenuOpen.value = false; if (restoreFocus) void nextTick(() => triggerRef.value?.focus({preventScroll:true})) }
function toggleMenu(event?: MouseEvent) { if (!props.disabled) { if (isOpen.value) closeMenu(); else { previewEffort.value = effectiveEffort.value; isOpen.value = true; if (event?.detail === 0) void nextTick(() => layerRef.value?.querySelector<HTMLElement>('[role=slider], button')?.focus({preventScroll:true})) } } }
function openModelMenu() { isModelMenuOpen.value = true; void nextTick(() => layerRef.value?.querySelector<HTMLButtonElement>('.model-reasoning-option.is-selected')?.focus({preventScroll:true})) }
function backToReasoning() { isModelMenuOpen.value = false; void nextTick(() => layerRef.value?.querySelector<HTMLButtonElement>('.model-reasoning-model-row')?.focus({preventScroll:true})) }
function selectReasoning(value: ReasoningEffort) { if (!props.disabled && props.reasoningOptions.some(o => o.value === value)) { previewEffort.value = value; emit('update:selected-reasoning-effort', value) } }
function resetReasoning() { if (resetEffort.value) selectReasoning(resetEffort.value) }
function selectModel(value: string) { if (!props.disabled) emit('update:selected-model',value) }
function outside(event: Event) { if (!(event.target instanceof Node) || rootRef.value?.contains(event.target) || layerRef.value?.contains(event.target)) return; closeMenu() }
function globalKey(event: Event) { if (event instanceof KeyboardEvent && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeMenu(true) } }
function onLayerKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (isModelMenuOpen.value) backToReasoning(); else closeMenu(true) }
  if (event.key === 'Tab') {
    const elements = [...layerRef.value!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"], summary')].filter(el => el.getClientRects().length)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function listeners(add: boolean) {
  const method = add ? 'addEventListener' : 'removeEventListener'
  window[method]('pointerdown',outside); window[method]('keydown',globalKey); window[method]('resize',schedulePosition); window[method]('scroll',schedulePosition,true)
  window.visualViewport?.[method]('resize',schedulePosition); window.visualViewport?.[method]('scroll',schedulePosition)
}
watch(isOpen, async open => {
  listeners(open); observer?.disconnect(); observer = null
  if (!open) { cancelAnimationFrame(frame); frame = 0; return }
  positionMenu(); await nextTick(); if (!isOpen.value) return
  positionMenu(); observer = new ResizeObserver(schedulePosition); if (layerRef.value) observer.observe(layerRef.value)
})
watch(isModelMenuOpen, () => { void nextTick(schedulePosition) })
watch(effectiveEffort, value => { previewEffort.value = value })
watch(() => props.disabled, value => { if (value) closeMenu() })
onBeforeUnmount(() => { listeners(false); observer?.disconnect(); cancelAnimationFrame(frame) })
</script>
<style scoped>
.model-reasoning-dropdown { display:inline-flex; min-width:0; }
.model-reasoning-trigger { display:inline-flex; align-items:center; gap:4px; min-height:32px; padding:4px 8px; border:0; background:transparent; border-radius:999px; color:var(--mac-muted); white-space:nowrap; cursor:pointer; }
.model-reasoning-trigger:hover, .model-reasoning-trigger.is-open { background:var(--mac-hover); }
.model-reasoning-trigger-summary { overflow:hidden; text-overflow:ellipsis; }
.model-reasoning-trigger-fast-icon { width:16px; height:16px; flex-shrink:0; }
.model-reasoning-layer { color:var(--mac-text); overflow:auto; overscroll-behavior:contain; border-radius:22px; }
.model-reasoning-menu { padding:12px 16px 10px; }
.model-reasoning-heading { position:relative; display:flex; justify-content:center; min-height:54px; }
.model-reasoning-model-row { display:flex; flex-direction:column; align-items:center; gap:2px; border:0; padding:0 34px 6px; background:transparent; cursor:pointer; }
.model-reasoning-current-effort { display:inline-flex; align-items:center; gap:2px; color:#3295ff; font-size:15px; font-weight:600; }
.model-reasoning-current-effort.is-ultra { color:#9454ff; }
.model-reasoning-current-effort svg { width:14px; height:14px; color:var(--mac-muted); }
.model-reasoning-current-model { color:var(--mac-muted); font-size:13px; }
.model-reasoning-reset { position:absolute; top:0; right:-6px; display:grid; place-items:center; width:32px; height:32px; border:0; border-radius:50%; background:transparent; color:var(--mac-muted); cursor:pointer; }
.model-reasoning-reset svg { width:19px; height:19px; }
.model-reasoning-reset:hover { background:var(--mac-hover); }
.model-reasoning-reset:disabled { opacity:.4; cursor:default; }
.model-reasoning-model-menu { padding:12px; }
.model-config-heading { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.model-config-heading h2 { font-size:14px; font-weight:500; color:var(--mac-muted); margin:0; }
.model-config-heading button { border:0; background:transparent; color:var(--mac-text); font-size:24px; width:28px; height:28px; border-radius:50%; cursor:pointer; }
.model-reasoning-list { margin:0; padding:0; list-style:none; max-height: min(40vh,360px); overflow:auto; }
.model-reasoning-option { display:flex; align-items:center; justify-content:space-between; width:100%; padding:8px 10px; min-height:36px; border:0; background:transparent; border-radius:10px; color:var(--mac-text); text-align:left; font-size:14px; cursor:pointer; }
.model-reasoning-option:hover { background:var(--mac-hover); }
.model-reasoning-check { font-size:19px; color:var(--mac-muted); }
.model-config-capability { margin:10px 6px; font-size:12px; color:var(--mac-muted); }
.model-config-capability p { margin:6px 0; }
.model-config-done { display:block; margin-top:12px; width:100%; padding:10px; border:0; border-radius:999px; background:var(--mac-text); color:var(--mac-main); cursor:pointer; font-weight:600; }
.model-config-backdrop { position:fixed; inset:0; background:rgb(0 0 0 / 15%); }
.model-config-grabber { display:none; }
.model-reasoning-empty { font-size:13px; color:var(--mac-muted); text-align:center; }
@media (max-width:767px) {
  .model-reasoning-trigger { min-height:44px; padding-inline:4px; font-size:14px; }
  .model-reasoning-trigger-model { color:var(--mac-text); font-weight:600; }
  .model-reasoning-menu { padding:18px 20px 16px; }
  .model-reasoning-heading { min-height:60px; }
  .model-reasoning-model-row { flex-direction:row-reverse; padding:0 20px 12px; gap:6px; }
  .model-reasoning-current-effort, .model-reasoning-current-model { font-size:18px; font-weight:600; }
  .model-reasoning-current-model { color:var(--mac-text); }
  .model-reasoning-current-effort { color:var(--mac-muted); }
  .model-reasoning-reset { top:-8px; right:-14px; width:36px; height:36px; }
  .model-reasoning-model-menu { padding:8px 24px max(20px,env(safe-area-inset-bottom)); }
  .model-config-grabber { display:block; margin:0 auto 12px; width:36px; height:4px; border-radius:99px; background:var(--mac-border-strong); }
  .model-config-heading { position:relative; justify-content:center; margin:8px 0 24px; }
  .model-config-heading h2 { font-size:20px; font-weight:650; color:var(--mac-text); }
  .model-config-heading button { position:absolute; left:0; }
  .model-reasoning-list { border-radius:22px; max-height:46vh; }
  .model-reasoning-option { padding:14px 16px; min-height:54px; font-size:17px; border-radius:0; background:var(--mac-hover); border-bottom:2px solid var(--mac-solid); }
  .model-reasoning-check { font-size:24px; }
  .model-config-done { min-height:50px; margin-top:20px; font-size:18px; }
}
</style>
