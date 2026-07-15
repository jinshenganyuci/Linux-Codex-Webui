<template>
  <div
    class="codex-login-modal-backdrop"
    role="presentation"
    @click="emit('cancel')"
  >
    <form
      class="codex-login-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Complete Codex login')"
      @submit.prevent="emit('submit')"
      @click.stop
    >
      <div class="codex-login-modal-header">
        <h2 class="codex-login-modal-title">{{ t('Complete Codex login') }}</h2>
        <button
          class="codex-login-modal-close"
          type="button"
          :aria-label="t('Close')"
          :disabled="presentation.controlsDisabled"
          @click="emit('cancel')"
        >
          ×
        </button>
      </div>
      <p class="codex-login-modal-copy">
        {{ t('Finish login in the browser, then paste the localhost callback URL here.') }}
      </p>
      <a
        v-if="loginUrl"
        class="codex-login-modal-link"
        :href="loginUrl"
        target="_blank"
        rel="noreferrer"
      >
        {{ t('Open login URL') }}
      </a>
      <input
        ref="callbackInputRef"
        :value="callbackUrl"
        class="codex-login-modal-input"
        type="url"
        inputmode="url"
        :placeholder="t('Paste localhost callback URL')"
        :disabled="presentation.controlsDisabled"
        @input="onCallbackInput"
      >
      <div v-if="error" class="codex-login-modal-error visible-error-with-feedback">
        <span>{{ error }}</span>
        <a class="visible-error-feedback" :href="feedbackMailto" @click="emit('prepare-feedback', $event, error)">{{ t('Send feedback') }}</a>
      </div>
      <div class="codex-login-modal-actions">
        <button
          class="codex-login-modal-cancel"
          type="button"
          :disabled="presentation.controlsDisabled"
          @click="emit('cancel')"
        >
          {{ t('Cancel') }}
        </button>
        <button
          class="codex-login-modal-submit"
          type="submit"
          :disabled="presentation.submitDisabled"
        >
          {{ presentation.submitLabel }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { getCodexLoginModalPresentation } from './codexLoginModal'

const props = defineProps<{
  loginUrl: string
  callbackUrl: string
  error: string
  isCompleting: boolean
  feedbackMailto: string
}>()

const emit = defineEmits<{
  'update:callbackUrl': [value: string]
  cancel: []
  submit: []
  'prepare-feedback': [event: MouseEvent, message: string]
}>()

const callbackInputRef = ref<HTMLInputElement | null>(null)
const presentation = computed(() => getCodexLoginModalPresentation(props.callbackUrl, props.isCompleting, t))

function onCallbackInput(event: Event): void {
  const input = event.currentTarget
  if (input instanceof HTMLInputElement) {
    emit('update:callbackUrl', input.value)
  }
}

function focusCallbackInput(): void {
  callbackInputRef.value?.focus()
}

defineExpose({ focusCallbackInput })
</script>

<style scoped>
@reference "tailwindcss";

.codex-login-modal-backdrop {
  @apply fixed inset-0 z-[100] flex items-center justify-center bg-black/35 px-4;
}

.codex-login-modal {
  @apply flex w-full max-w-md flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl;
}

.codex-login-modal-header {
  @apply flex items-center justify-between gap-3;
}

.codex-login-modal-title {
  @apply text-base font-semibold text-zinc-900;
}

.codex-login-modal-close {
  @apply inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg leading-none text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-default disabled:opacity-60;
}

.codex-login-modal-copy {
  @apply text-sm leading-5 text-zinc-600;
}

.codex-login-modal-link {
  @apply min-w-0 truncate text-sm text-blue-600 hover:text-blue-700 hover:underline;
}

.codex-login-modal-input {
  @apply w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-zinc-400 disabled:cursor-default disabled:opacity-60;
}

.codex-login-modal-error {
  @apply rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700;
}

.visible-error-with-feedback {
  @apply flex items-start justify-between gap-3;
}

.visible-error-feedback {
  @apply shrink-0 rounded-full border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300;
}

.codex-login-modal-actions {
  @apply flex items-center justify-end gap-2;
}

.codex-login-modal-cancel,
.codex-login-modal-submit {
  @apply rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-default disabled:opacity-60;
}

.codex-login-modal-submit {
  @apply border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800;
}

:global(:root.dark .codex-login-modal) {
  @apply border-zinc-700 bg-zinc-900;
}

:global(:root.dark .codex-login-modal-title) {
  @apply text-zinc-100;
}

:global(:root.dark .codex-login-modal-close),
:global(:root.dark .codex-login-modal-cancel) {
  @apply border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700;
}

:global(:root.dark .codex-login-modal-copy) {
  @apply text-zinc-300;
}

:global(:root.dark .codex-login-modal-link) {
  @apply text-sky-300 hover:text-sky-200;
}

:global(:root.dark .codex-login-modal-input) {
  @apply border-zinc-600 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-400;
}

:global(:root.dark .codex-login-modal-error) {
  @apply bg-rose-950/40 text-rose-200;
}

:global(:root.dark .codex-login-modal-submit) {
  @apply border-zinc-200 bg-zinc-100 text-zinc-900 hover:bg-white;
}
</style>
