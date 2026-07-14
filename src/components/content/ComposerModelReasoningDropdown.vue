<template>
  <div ref="rootRef" class="model-reasoning-dropdown">
    <button
      class="model-reasoning-trigger"
      type="button"
      :aria-label="triggerAccessibleLabel"
      :title="triggerAccessibleLabel"
      :disabled="disabled"
      @click="toggleMenu"
    >
      <IconTablerBolt v-if="isFastModeSelected" class="model-reasoning-trigger-fast-icon" />
      <span class="model-reasoning-trigger-summary">
        {{ compactSelectedModelLabel }} <span aria-hidden="true">·</span> {{ selectedReasoningLabel }}
      </span>
      <IconTablerChevronDown class="model-reasoning-trigger-chevron" />
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="layerRef"
        class="model-reasoning-layer"
        :class="[
          isMobileLayout ? 'is-mobile-layout' : `is-model-${modelMenuSide}`,
          { 'is-model-open': isModelMenuOpen },
        ]"
        :style="layerStyle"
        @keydown.esc.stop.prevent="closeMenu"
      >
        <div ref="menuRef" class="model-reasoning-menu">
          <div class="model-reasoning-menu-label">{{ t('Reasoning') }}</div>
          <ul class="model-reasoning-list" role="listbox" :aria-label="t('Reasoning')">
            <li v-for="option in reasoningOptions" :key="option.value">
              <button
                class="model-reasoning-option"
                :class="{ 'is-selected': selectedReasoningEffort === option.value }"
                type="button"
                @click="selectReasoning(option.value)"
              >
                <span>{{ option.label }}</span>
                <span class="model-reasoning-check">{{ selectedReasoningEffort === option.value ? '✓' : '' }}</span>
              </button>
            </li>
          </ul>

          <div class="model-reasoning-divider" />

          <button
            class="model-reasoning-model-row"
            :class="{ 'is-open': isModelMenuOpen }"
            type="button"
            @pointerenter="onModelRowPointerEnter"
            @click="onModelRowClick"
          >
            <span class="model-reasoning-model-row-label">{{ selectedModelLabel || t('Model') }}</span>
            <IconTablerChevronRight class="model-reasoning-model-row-chevron" />
          </button>
        </div>

        <div v-if="isModelMenuOpen" ref="modelMenuRef" class="model-reasoning-model-menu">
          <div class="model-reasoning-menu-label">{{ t('Model') }}</div>
          <ul v-if="modelOptions.length > 0" class="model-reasoning-list" role="listbox" :aria-label="t('Model')">
            <li v-for="option in modelOptions" :key="option.value">
              <button
                class="model-reasoning-option"
                :class="{ 'is-selected': selectedModel === option.value }"
                type="button"
                @click="selectModel(option.value)"
              >
                <span>{{ option.label }}</span>
                <span class="model-reasoning-check">{{ selectedModel === option.value ? '✓' : '' }}</span>
              </button>
            </li>
          </ul>
          <div v-else class="model-reasoning-empty">{{ t('No results') }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import type { ReasoningEffort, SpeedMode } from '../../types/codex'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'

type DropdownOption<T extends string = string> = {
  value: T
  label: string
}

const props = defineProps<{
  selectedModel: string
  selectedReasoningEffort: ReasoningEffort | ''
  selectedSpeedMode: SpeedMode
  isFastModeSupported?: boolean
  modelOptions: DropdownOption[]
  reasoningOptions: DropdownOption<ReasoningEffort>[]
  disabled?: boolean
  openDirection?: 'up' | 'down'
}>()

const emit = defineEmits<{
  'update:selected-model': [value: string]
  'update:selected-reasoning-effort': [value: ReasoningEffort]
}>()

const { t } = useUiLanguage()
const rootRef = ref<HTMLElement | null>(null)
const layerRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const modelMenuRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const isModelMenuOpen = ref(false)
const isMobileLayout = ref(false)
const modelMenuSide = ref<'left' | 'right'>('left')
const layerStyle = ref<Record<string, string>>({})

const selectedModelLabel = computed(() => {
  const selected = props.modelOptions.find((option) => option.value === props.selectedModel)
  return selected?.label || formatModelLabel(props.selectedModel)
})

const compactSelectedModelLabel = computed(() => compactModelLabel(selectedModelLabel.value || t('Model')))

const selectedReasoningLabel = computed(() => {
  const selected = props.reasoningOptions.find((option) => option.value === props.selectedReasoningEffort)
  return selected?.label || t('Thinking')
})

const isFastModeSelected = computed(() => props.selectedSpeedMode === 'fast' && props.isFastModeSupported === true)

const triggerAccessibleLabel = computed(() =>
  `${t('Model')}: ${selectedModelLabel.value || t('Model')}, ${t('Reasoning')}: ${selectedReasoningLabel.value}${isFastModeSelected.value ? `, ${t('Fast mode')}: ${t('enabled')}` : ''}`,
)

function formatModelLabel(modelId: string): string {
  return modelId.trim().replace(/^gpt/i, 'GPT')
}

function compactModelLabel(label: string): string {
  const trimmed = label.trim()
  return trimmed.replace(/^GPT[-\s]?/i, '')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function updateMenuPosition(): void {
  if (!isOpen.value) return
  const root = rootRef.value
  if (!root || typeof window === 'undefined') return

  const rect = root.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const viewportPadding = 8
  const gap = 8
  const mobile = viewportWidth < 640
  isMobileLayout.value = mobile

  const mainWidth = mobile ? Math.min(292, viewportWidth - viewportPadding * 2) : 196
  const modelWidth = mobile ? mainWidth : 232
  const modelSide = rect.right + gap + modelWidth + viewportPadding <= viewportWidth ? 'right' : 'left'
  modelMenuSide.value = modelSide

  let left = rect.right - mainWidth
  if (!mobile && isModelMenuOpen.value && modelSide === 'left') {
    left = Math.max(left, viewportPadding + modelWidth + gap)
  }
  if (!mobile && isModelMenuOpen.value && modelSide === 'right') {
    left = Math.min(left, viewportWidth - mainWidth - modelWidth - gap - viewportPadding)
  }
  left = clamp(left, viewportPadding, Math.max(viewportPadding, viewportWidth - mainWidth - viewportPadding))

  const layerHeight = layerRef.value?.offsetHeight ?? menuRef.value?.offsetHeight ?? 260
  let top = props.openDirection === 'down'
    ? rect.bottom + gap
    : rect.top - layerHeight - gap
  if (top + layerHeight > viewportHeight - viewportPadding) {
    top = viewportHeight - layerHeight - viewportPadding
  }
  top = Math.max(viewportPadding, top)

  layerStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${mainWidth}px`,
  }
}

function toggleMenu(): void {
  if (props.disabled) return
  isOpen.value = !isOpen.value
  if (!isOpen.value) {
    isModelMenuOpen.value = false
  }
}

function closeMenu(): void {
  isOpen.value = false
  isModelMenuOpen.value = false
}

function openModelMenu(): void {
  if (props.disabled) return
  isModelMenuOpen.value = true
}

function onModelRowPointerEnter(event: PointerEvent): void {
  if (isMobileLayout.value) return
  if (event.pointerType !== 'mouse') return
  openModelMenu()
}

function onModelRowClick(): void {
  if (props.disabled) return
  if (!isMobileLayout.value) {
    openModelMenu()
    return
  }
  isModelMenuOpen.value = !isModelMenuOpen.value
}

function selectReasoning(value: ReasoningEffort): void {
  emit('update:selected-reasoning-effort', value)
  closeMenu()
}

function selectModel(value: string): void {
  emit('update:selected-model', value)
  closeMenu()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (rootRef.value?.contains(target)) return
  if (layerRef.value?.contains(target)) return
  closeMenu()
}

function onWindowLayoutChange(): void {
  if (!isOpen.value) return
  updateMenuPosition()
}

watch([isOpen, isModelMenuOpen], ([open]) => {
  if (!open) return
  void nextTick(() => {
    updateMenuPosition()
    window.requestAnimationFrame(updateMenuPosition)
  })
})

onMounted(() => {
  window.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('resize', onWindowLayoutChange)
  window.addEventListener('scroll', onWindowLayoutChange, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('resize', onWindowLayoutChange)
  window.removeEventListener('scroll', onWindowLayoutChange, true)
})
</script>

<style scoped>
@reference "tailwindcss";

.model-reasoning-dropdown {
  @apply relative inline-flex min-w-0 w-full;
}

.model-reasoning-trigger {
  @apply inline-flex min-h-7 w-full min-w-0 items-center gap-1 border-0 bg-transparent px-0 py-0.5 text-sm leading-tight text-zinc-500 outline-none transition hover:text-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-400;
}

.model-reasoning-trigger-fast-icon {
  @apply -ml-0.5 h-3.5 w-3.5 shrink-0 text-orange-500;
}

.model-reasoning-trigger-summary {
  @apply min-w-0 flex-1 truncate whitespace-nowrap pb-px text-left;
}

.model-reasoning-trigger-chevron {
  @apply mt-px h-3.5 w-3.5 shrink-0 text-zinc-500;
}

.model-reasoning-layer {
  @apply z-50;
}

.model-reasoning-menu,
.model-reasoning-model-menu {
  @apply rounded-lg border border-zinc-200 bg-white p-1 shadow-lg;
}

.model-reasoning-menu-label {
  @apply px-2 py-1 text-xs text-zinc-500;
}

.model-reasoning-list {
  @apply m-0 max-h-64 list-none overflow-y-auto p-0;
}

.model-reasoning-option,
.model-reasoning-model-row {
  @apply flex min-h-8 w-full items-center justify-between gap-3 rounded-lg border-0 bg-transparent px-2 py-1 text-left text-sm text-zinc-700 transition hover:bg-zinc-100;
}

.model-reasoning-option.is-selected,
.model-reasoning-model-row.is-open {
  @apply bg-zinc-100 text-zinc-900;
}

.model-reasoning-check {
  @apply w-4 shrink-0 text-right text-zinc-600;
}

.model-reasoning-divider {
  @apply my-1 h-px bg-zinc-100;
}

.model-reasoning-model-row-label {
  @apply min-w-0 truncate;
}

.model-reasoning-model-row-chevron {
  @apply h-4 w-4 shrink-0 text-zinc-500;
}

.model-reasoning-model-menu {
  @apply w-[14.5rem];
}

.model-reasoning-layer:not(.is-mobile-layout) .model-reasoning-model-menu {
  @apply absolute bottom-0;
}

.model-reasoning-layer.is-model-left .model-reasoning-model-menu {
  right: calc(100% + 0.5rem);
}

.model-reasoning-layer.is-model-right .model-reasoning-model-menu {
  left: calc(100% + 0.5rem);
}

.model-reasoning-layer.is-mobile-layout .model-reasoning-model-menu {
  @apply mt-1 w-full;
}

.model-reasoning-layer.is-mobile-layout.is-model-open .model-reasoning-menu {
  @apply hidden;
}

.model-reasoning-layer.is-mobile-layout.is-model-open .model-reasoning-model-menu {
  @apply mt-0;
}

.model-reasoning-empty {
  @apply px-2 py-2 text-sm text-zinc-500;
}
</style>
