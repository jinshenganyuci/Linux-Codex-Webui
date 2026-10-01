<template>
  <div class="runtime-diagnostics" data-testid="runtime-diagnostics">
    <div class="runtime-diagnostics-versions">
      <section class="runtime-diagnostics-version" data-testid="system-cli-version">
        <span>{{ t('System Codex CLI') }}</span>
        <strong>{{ runtime.systemCli.version || t('Unavailable') }}</strong>
        <small>{{ t('Resolved from server PATH') }}</small>
      </section>
      <section class="runtime-diagnostics-version" data-testid="running-cli-version">
        <span>{{ t('WebUI app-server') }}</span>
        <strong>{{ runtime.codex.version || t('Not initialized') }}</strong>
        <small>{{ runtime.explicitRuntime ? t('Explicit runtime command') : t('Default runtime command') }}</small>
      </section>
    </div>
    <p v-if="runtime.systemCli.version && runtime.codex.version && runtime.systemCli.version !== runtime.codex.version" class="runtime-diagnostics-note">{{ t('Upgrading the system CLI does not restart or replace the running WebUI runtime.') }}</p>
    <ul class="runtime-diagnostics-capabilities">
      <li data-testid="memory-capability">
        <div><strong>{{ t('Memory status') }}</strong><span class="runtime-diagnostics-badge" :data-status="runtime.memory.status">{{ statusLabel(runtime.memory.status) }}</span></div>
        <template v-if="runtime.memory.status === 'available'">
          <p>{{ runtime.memory.v2Ready ? t('Memory is ready') : t('Memory is not ready yet') }} · {{ t('Consolidated threads') }}: {{ runtime.memory.v2ConsolidatedThreads }}</p>
          <small>{{ t('Readiness does not prove that a particular reply used memory.') }}</small>
        </template>
        <p v-else>{{ runtime.memory.status === 'unsupported' ? t('This runtime does not support memory status.') : t('Memory status could not be confirmed. Refresh after the runtime is ready.') }}</p>
      </li>
      <li data-testid="temporary-features-capability">
        <div><strong>{{ t('Temporary feature switches') }}</strong><span class="runtime-diagnostics-badge" :data-status="runtime.temporaryFeatures.status">{{ statusLabel(runtime.temporaryFeatures.status) }}</span></div>
        <p>{{ runtime.temporaryFeatures.status === 'available' ? t('This exact CLI version has verified switch support. Stable stage and managed policy are checked before each change.') : t('Temporary switches remain read-only until this CLI version is verified.') }}</p>
      </li>
    </ul>
    <dl>
      <dt>WebUI</dt><dd>{{ runtime.webui.version }} · {{ runtime.webui.commit.slice(0, 8) || t('Development build') }}{{ runtime.webui.dirty ? ' *' : '' }}</dd>
      <dt>{{ t('Started at') }}</dt><dd>{{ runtime.codex.startedAt || '—' }}</dd>
      <dt>{{ t('Model metadata') }}</dt><dd>{{ runtime.codex.catalogStatus }}</dd>
      <dt>CODEX_HOME</dt><dd>{{ runtime.codex.home || '—' }}</dd>
      <dt>{{ t('Runtime executable') }}</dt><dd>{{ runtime.codex.command || '—' }}</dd>
      <dt>{{ t('System executable') }}</dt><dd>{{ runtime.systemCli.command || '—' }}</dd>
      <dt>{{ t('Memory checked at') }}</dt><dd>{{ formatTime(runtime.memory.checkedAt) }}</dd>
      <dt>{{ t('System CLI checked at') }}</dt><dd>{{ formatTime(runtime.systemCli.checkedAt) }}</dd>
    </dl>
    <p class="runtime-info-help">{{ t('The CLI version comes from the running app-server handshake, not the global installation.') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useUiLanguage } from '../../composables/useUiLanguage'
import type { CapabilityStatus, RuntimeDiagnostics } from '../../runtimeDiagnostics'

defineProps<{ runtime: RuntimeDiagnostics }>()
const { t } = useUiLanguage()
const statusLabel = (status: CapabilityStatus) => t({ available: 'Confirmed', unsupported: 'Unsupported', unknown: 'Unconfirmed' }[status])
const formatTime = (value: string) => value ? new Date(value).toLocaleString() : '—'
</script>
