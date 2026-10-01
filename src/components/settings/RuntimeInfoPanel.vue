<template>
  <details class="runtime-info-panel" data-testid="runtime-info-panel" @toggle="onToggle">
    <summary>{{ t('Runtime information') }}</summary>
    <p v-if="error" role="status" class="runtime-diagnostics-error">{{ error }}</p>
    <RuntimeInfoCard v-if="runtime" :runtime="runtime" />
    <p v-else class="runtime-info-help">{{ t('Runtime checks run only when this panel is opened or refreshed.') }}</p>
    <button type="button" :disabled="loading" :aria-busy="loading" @click="load(true)">{{ loading ? t('Loading…') : t('Refresh') }}</button>
  </details>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import RuntimeInfoCard from './RuntimeInfoCard.vue'
import type { RuntimeDiagnostics } from '../../runtimeDiagnostics'

const { t } = useUiLanguage()
const runtime = ref<RuntimeDiagnostics | null>(null)
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null
let disposed = false

function onToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void load()
}

async function load(refresh = false): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  controller = new AbortController()
  const timeout = setTimeout(() => controller?.abort(), 6000)
  try {
    const response = await fetch(`/codex-api/runtime-diagnostics${refresh ? '?refresh=1' : ''}`, { signal: controller.signal })
    if (!response.ok) throw new Error(t('Runtime information is unavailable'))
    const payload = await response.json()
    if (!payload.data?.webui || !payload.data?.codex || !payload.data?.systemCli || !payload.data?.memory || !payload.data?.temporaryFeatures) throw new Error(t('Runtime information is unavailable'))
    if (!disposed) runtime.value = payload.data
  } catch {
    if (!disposed) error.value = t('Runtime information is unavailable')
  } finally {
    clearTimeout(timeout)
    if (!disposed) loading.value = false
  }
}

onUnmounted(() => { disposed = true; controller?.abort() })
</script>
