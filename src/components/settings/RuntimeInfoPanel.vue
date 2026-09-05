<template>
  <details class="runtime-info-panel">
    <summary>{{ t('Runtime information') }}</summary>
    <p v-if="error" role="status">{{ error }}</p>
    <dl v-if="runtime">
      <dt>WebUI</dt><dd>{{ runtime.webui.version }} · {{ runtime.webui.commit.slice(0, 8) || t('Development build') }}{{ runtime.webui.dirty ? ' *' : '' }}</dd>
      <dt>Codex CLI</dt><dd>{{ runtime.codex.version || t('Not initialized') }}</dd>
      <dt>{{ t('Started at') }}</dt><dd>{{ runtime.codex.startedAt || '—' }}</dd>
      <dt>{{ t('Model metadata') }}</dt><dd>{{ runtime.codex.catalogStatus }}</dd>
      <dt>CODEX_HOME</dt><dd>{{ runtime.codex.home || '—' }}</dd>
      <dt>{{ t('Executable') }}</dt><dd>{{ runtime.codex.command || '—' }}</dd>
    </dl>
    <p class="runtime-info-help">{{ t('The CLI version comes from the running app-server handshake, not the global installation.') }}</p>
    <button type="button" :disabled="loading" @click="load">{{ loading ? t('Loading…') : t('Refresh') }}</button>
  </details>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useUiLanguage } from '../../composables/useUiLanguage'

type RuntimeInfo = {
  webui: { version: string; commit: string; dirty: boolean }
  codex: { version: string | null; startedAt: string; home: string; command: string; catalogStatus: string }
}

const { t } = useUiLanguage()
const runtime = ref<RuntimeInfo | null>(null)
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  controller = new AbortController()
  const timeout = setTimeout(() => controller?.abort(), 6000)
  try {
    const response = await fetch('/codex-api/runtime-info', { signal: controller.signal })
    if (!response.ok) throw new Error(t('Runtime information is unavailable'))
    const payload = await response.json()
    if (!payload.data?.webui || !payload.data?.codex) throw new Error(t('Runtime information is unavailable'))
    runtime.value = payload.data
  } catch {
    error.value = t('Runtime information is unavailable')
  } finally {
    clearTimeout(timeout)
    loading.value = false
  }
}

onMounted(() => void load())
onUnmounted(() => controller?.abort())
</script>
