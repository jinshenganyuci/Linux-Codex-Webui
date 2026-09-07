<template>
  <div ref="track" class="reasoning-slider" :class="{ 'is-ultra': previewValue === 'ultra', 'is-dragging': dragging, 'is-disabled': disabled || options.length < 2 }"
    role="slider" :tabindex="disabled || options.length < 2 ? -1 : 0" :aria-label="t('Reasoning')" aria-orientation="horizontal"
    :aria-valuemin="0" :aria-valuemax="Math.max(0, options.length - 1)" :aria-valuenow="previewIndex"
    :aria-valuetext="options[previewIndex]?.label || t('Thinking')" :aria-disabled="disabled || options.length < 2"
    @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="cancel" @keydown="onKey">
    <div class="reasoning-slider-track" aria-hidden="true">
      <div class="reasoning-slider-fill" :style="{ width: `calc(var(--slider-thumb) + (100% - var(--slider-thumb)) * ${position / 100})` }" />
      <span v-for="(option, index) in options" :key="option.value" class="reasoning-slider-tick" :class="{ 'is-filled': index <= previewIndex }"
        :style="{ left: `calc(var(--slider-thumb) / 2 + (100% - var(--slider-thumb)) * ${index / Math.max(1, options.length - 1)})` }" />
      <span class="reasoning-slider-thumb" :style="{ left: `calc((100% - var(--slider-thumb)) * ${position / 100})` }" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ReasoningEffort } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { advanceSheetSpring } from './sheetMotion'
const props = defineProps<{ modelValue: ReasoningEffort | ''; options: { value: ReasoningEffort; label: string }[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: ReasoningEffort]; preview: [value: ReasoningEffort | ''] }>()
const { t } = useUiLanguage()
const track = ref<HTMLElement | null>(null), dragging = ref(false), position = ref(0)
const selectedIndex = computed(() => Math.max(0, props.options.findIndex(o => o.value === props.modelValue)))
const previewIndex = computed(() => Math.round(position.value / 100 * Math.max(0, props.options.length - 1)))
const previewValue = computed(() => props.options[previewIndex.value]?.value || '')
let pointer = -1, startLeft = 0, span = 1, grabOffset = 0, velocity = 0, lastTime = 0, frame = 0, springTarget = 0
const percentage = (index: number) => index / Math.max(1, props.options.length - 1) * 100
function stop() { cancelAnimationFrame(frame); frame = 0 }
function settle(target: number) {
  stop(); springTarget = target
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { position.value = target; velocity = 0; return }
  let previous = performance.now()
  const tick = (now: number) => {
    const step = advanceSheetSpring(position.value, velocity, target, (now - previous) / 1000)
    position.value = Math.max(0, Math.min(100, step.position)); velocity = step.velocity; previous = now
    frame = step.settled ? 0 : requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}
function move(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== pointer) return
  const next = Math.max(0, Math.min(100, (event.clientX - startLeft - grabOffset) / span * 100))
  const now = performance.now(), elapsed = now - lastTime
  if (elapsed > 0) velocity = Math.max(-800, Math.min(800, (next - position.value) / elapsed * 1000))
  position.value = next; lastTime = now
  emit('preview', previewValue.value)
}
function start(event: PointerEvent) {
  if (props.disabled || props.options.length < 2 || !event.isPrimary || event.button !== 0) return
  event.preventDefault(); stop()
  const el = track.value!, rect = el.getBoundingClientRect()
  const thumb = el.querySelector<HTMLElement>('.reasoning-slider-thumb')!.getBoundingClientRect()
  span = rect.width - thumb.width; startLeft = rect.left + thumb.width / 2
  grabOffset = event.clientX >= thumb.left && event.clientX <= thumb.right ? event.clientX - (thumb.left + thumb.width / 2) : 0
  pointer = event.pointerId; velocity = 0; lastTime = performance.now(); dragging.value = true
  el.setPointerCapture(pointer); move(event)
}
function release() {
  dragging.value = false
  if (track.value?.hasPointerCapture(pointer)) track.value.releasePointerCapture(pointer)
  pointer = -1
}
function finish(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== pointer) return
  move(event)
  const value = previewValue.value, index = previewIndex.value
  release()
  if (value && value !== props.modelValue) emit('update:modelValue', value)
  settle(percentage(index))
}
function cancel() {
  if (!dragging.value) return
  release(); emit('preview', props.modelValue); settle(percentage(selectedIndex.value))
}
function onKey(event: KeyboardEvent) {
  if (props.disabled || props.options.length < 2) return
  const index = selectedIndex.value
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1
    : ['ArrowRight','ArrowUp'].includes(event.key) ? index + 1 : ['ArrowLeft','ArrowDown'].includes(event.key) ? index - 1 : null
  if (next == null) return
  event.preventDefault(); stop(); velocity = 0
  const value = props.options[Math.max(0, Math.min(props.options.length - 1, next))]!.value
  position.value = percentage(Math.max(0, Math.min(props.options.length - 1, next)))
  emit('preview', value)
  if (value !== props.modelValue) emit('update:modelValue', value)
}
watch(() => props.modelValue, () => { if (!dragging.value) { const next = percentage(selectedIndex.value); if (frame && next === springTarget) return; stop(); position.value = next } }, { immediate: true })
watch(() => props.options.map(o => o.value).join(','), () => { if (dragging.value) release(); stop(); position.value = percentage(selectedIndex.value); emit('preview', props.modelValue) })
watch(() => props.disabled, value => { if (value) cancel() })
onBeforeUnmount(() => { stop(); if (dragging.value) release() })
</script>
<style scoped>
.reasoning-slider { --slider-thumb: 32px; height: 44px; display: flex; align-items: center; touch-action: none; user-select: none; cursor: grab; outline-offset: 4px; border-radius: 999px; }
.reasoning-slider:focus-visible { outline: 2px solid var(--mac-accent); }
.reasoning-slider.is-dragging { cursor: grabbing; }
.reasoning-slider.is-disabled { cursor: default; opacity: .55; }
.reasoning-slider-track { position: relative; width: 100%; height: var(--slider-thumb); background: var(--reasoning-track, #e7e7e9); border-radius: 999px; }
.reasoning-slider-fill { position: absolute; inset: 0 auto 0 0; background: #3295ff; border-radius: inherit; }
.reasoning-slider-tick { position: absolute; top: calc(50% - 2.5px); height: 5px; width: 5px; margin-left: -2.5px; border-radius: 50%; background: #b5b5b9; }
.reasoning-slider-tick.is-filled { background: rgb(255 255 255 / 35%); }
.reasoning-slider-thumb { position: absolute; top: 0; width: var(--slider-thumb); height: var(--slider-thumb); border: 1px solid rgb(0 0 0 / 7%); border-radius: 50%; background: white; box-shadow: 0 1px 3px rgb(0 0 0 / 16%); }
.reasoning-slider.is-ultra .reasoning-slider-fill { background: radial-gradient(circle at 20% 40%, #ffffff9c 0 1px, transparent 2px), radial-gradient(circle at 70% 70%, #ffffff90 0 1px, transparent 2px), linear-gradient(105deg, #9ab8ff, #9359ff 60%, #7744ec); background-size: 31px 23px, 43px 27px, 100% 100%; }
@media (max-width: 767px) { .reasoning-slider { --slider-thumb: 44px; height: 56px; } .reasoning-slider-tick { width: 7px; height: 7px; top: calc(50% - 3.5px); margin-left: -3.5px; } .reasoning-slider-thumb { border: 3px solid #3295ff; box-shadow: none; } .reasoning-slider.is-ultra .reasoning-slider-thumb { border-color: #8754f8; } }
</style>
