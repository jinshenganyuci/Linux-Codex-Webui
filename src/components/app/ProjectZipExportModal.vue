<template>
  <div class="project-zip-modal-backdrop" role="presentation">
    <div
      ref="modalRef"
      class="project-zip-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Export Project')"
      tabindex="-1"
      @click.stop
      @keydown="onModalKeydown"
    >
      <div class="project-zip-modal-header">
        <h2 class="project-zip-modal-title">{{ t('Export Project') }}</h2>
        <button
          ref="closeButtonRef"
          class="project-zip-modal-close"
          type="button"
          :aria-label="t('Close')"
          :disabled="presentation.isExporting"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
      <p class="project-zip-modal-copy">
        {{ presentation.copy }}
      </p>
      <div class="project-zip-progress-label" role="status" aria-live="polite">
        <span>{{ presentation.phaseLabel }}</span>
        <span>{{ presentation.progressText }}</span>
      </div>
      <div class="project-zip-progress-track">
        <div class="project-zip-progress-fill" :style="{ transform: progressTransform }" />
      </div>
      <p v-if="status.error" class="project-zip-modal-error" role="alert">
        {{ status.error }}
      </p>
      <div class="project-zip-modal-actions">
        <button class="project-zip-modal-cancel" type="button" :disabled="presentation.isExporting" @click="emit('close')">
          {{ t('Close') }}
        </button>
        <button class="project-zip-modal-action" type="button" :disabled="!presentation.hasDownload" @click="emit('download')">
          {{ t('Download') }}
        </button>
        <button class="project-zip-modal-action project-zip-modal-action-primary" type="button" :disabled="!presentation.hasDownload" @click="emit('share')">
          {{ t('Share') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { getProjectZipExportPresentation, type ProjectZipExportStatus } from './projectZipExportModal'

const props = defineProps<{
  status: ProjectZipExportStatus
}>()

const emit = defineEmits<{
  close: []
  download: []
  share: []
}>()

const presentation = computed(() => getProjectZipExportPresentation(props.status, t))
const modalRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
let previouslyFocusedElement: HTMLElement | null = null
let backgroundElement: HTMLElement | null = null
let backgroundWasInert = false
let previousBodyOverflow = ''
const progressTransform = computed(() => {
  const percent = Number.parseFloat(presentation.value.progressWidth)
  const scale = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : 0
  return `scaleX(${scale})`
})

onMounted(() => {
  previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  backgroundElement = document.querySelector<HTMLElement>('.desktop-layout')
  backgroundWasInert = backgroundElement?.hasAttribute('inert') ?? false
  if (backgroundElement && !backgroundWasInert) backgroundElement.setAttribute('inert', '')
  void nextTick(() => {
    const closeButton = closeButtonRef.value
    if (closeButton && !closeButton.disabled) closeButton.focus({ preventScroll: true })
    else modalRef.value?.focus({ preventScroll: true })
  })
})

onBeforeUnmount(() => {
  document.body.style.overflow = previousBodyOverflow
  if (backgroundElement && !backgroundWasInert) backgroundElement.removeAttribute('inert')
  const focusTarget = previouslyFocusedElement
  backgroundElement = null
  previouslyFocusedElement = null
  void nextTick(() => {
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true })
  })
})

function onModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (presentation.value.isExporting) return
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const modal = modalRef.value
  if (!modal) return
  const focusable = Array.from(modal.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getClientRects().length > 0)
  if (focusable.length === 0) {
    event.preventDefault()
    modal.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}
</script>

<style scoped>
@reference "tailwindcss";

.project-zip-modal-backdrop {
  @apply fixed inset-0 flex items-center justify-center bg-black/35 px-4;
  z-index: var(--ui-z-modal);
}

.project-zip-modal {
  @apply flex w-full max-w-md flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 text-zinc-900 shadow-2xl;
}

.project-zip-modal-header {
  @apply flex items-center justify-between gap-3;
}

.project-zip-modal-title {
  @apply text-base font-semibold;
}

.project-zip-modal-close {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg leading-none text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-default disabled:opacity-60;
}

.project-zip-modal-copy {
  @apply min-h-5 truncate text-sm text-zinc-600;
}

.project-zip-modal-error {
  @apply rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900;
}

.project-zip-progress-label {
  @apply flex items-center justify-between gap-3 text-sm font-semibold;
}

.project-zip-progress-label span:last-child {
  @apply shrink-0 text-xs font-medium text-zinc-500;
}

.project-zip-progress-track {
  @apply h-2 overflow-hidden rounded-full bg-zinc-100;
}

.project-zip-progress-fill {
  @apply h-full w-full rounded-full bg-emerald-600;
  transform-origin: left center;
  transition: transform 150ms var(--ui-ease-out);
}

.project-zip-modal-actions {
  @apply flex items-center justify-end gap-2;
}

.project-zip-modal-cancel,
.project-zip-modal-action {
  @apply rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-default disabled:opacity-60;
}

.project-zip-modal-action-primary {
  @apply border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800;
}

@media (hover: none), (pointer: coarse) {
  .project-zip-modal-close,
  .project-zip-modal-cancel,
  .project-zip-modal-action {
    min-height: 2.75rem;
  }

  .project-zip-modal-close {
    min-width: 2.75rem;
  }
}

:global(:root.dark .project-zip-modal) {
  @apply border-zinc-700 bg-zinc-900 text-zinc-100;
}

:global(:root.dark .project-zip-modal-close),
:global(:root.dark .project-zip-modal-cancel),
:global(:root.dark .project-zip-modal-action) {
  @apply border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800;
}

:global(:root.dark .project-zip-modal-copy) {
  @apply text-zinc-400;
}

:global(:root.dark .project-zip-modal-error) {
  @apply border-amber-900/60 bg-amber-950/40 text-amber-100;
}

:global(:root.dark .project-zip-modal-action-primary) {
  @apply border-zinc-100 bg-zinc-100 text-zinc-950 hover:bg-white;
}

:global(:root.dark .project-zip-progress-label span:last-child) {
  @apply text-zinc-400;
}

:global(:root.dark .project-zip-progress-track) {
  @apply bg-zinc-800;
}

:global(:root.dark .project-zip-progress-fill) {
  @apply bg-emerald-500;
}
</style>
