<template>
  <div class="command-execution-block">
    <button
      type="button"
      class="cmd-row"
      :class="[
        statusClass,
        {
          'cmd-expanded': expanded,
          'cmd-compact': compact,
        },
      ]"
      :aria-controls="outputDomId"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <span class="cmd-chevron" :class="{ 'cmd-chevron-open': expanded }" aria-hidden="true">▶</span>
      <code class="cmd-label">{{ renderState.commandLabel }}</code>
      <span class="cmd-status">{{ statusLabel }}</span>
    </button>
    <div
      :id="outputDomId"
      class="cmd-output-wrap"
      :class="{ 'cmd-output-visible': expanded }"
      role="region"
      :aria-hidden="!expanded"
      :aria-label="renderState.commandLabel"
    >
      <div class="cmd-output-inner">
        <pre
          v-if="renderState.mountedOutput !== null"
          class="cmd-output"
          :class="{ 'cmd-output-condensed': condensed }"
          v-text="renderState.mountedOutput"
        ></pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { buildCommandExecutionBlockState } from './commandExecutionBlockModel'

const props = defineProps<{
  instanceId: string
  command: string
  output: string
  statusLabel: string
  statusClass: string
  expanded: boolean
  compact: boolean
  condensed: boolean
  commandFallback: string
  emptyOutputLabel: string
}>()

const emit = defineEmits<{
  toggle: []
}>()

const renderState = computed(() => buildCommandExecutionBlockState({
  instanceId: props.instanceId,
  command: props.command,
  commandFallback: props.commandFallback,
  output: props.output,
  emptyOutputLabel: props.emptyOutputLabel,
  expanded: props.expanded,
}))

const outputDomId = computed(() => renderState.value.outputDomId)
</script>

<style scoped>
@reference "tailwindcss";

.command-execution-block {
  width: 100%;
  min-width: 0;
}

.cmd-row {
  @apply w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 cursor-pointer transition-colors text-left hover:bg-zinc-100;
}

.cmd-row.cmd-compact {
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  border-radius: 0.625rem;
}

.cmd-row.cmd-compact .cmd-chevron {
  font-size: 9px;
}

.cmd-row.cmd-compact .cmd-label {
  font-size: 0.75rem;
}

.cmd-row.cmd-compact .cmd-status {
  max-width: 4.5rem;
  font-size: 0.75rem;
}

.cmd-row.cmd-expanded {
  @apply rounded-b-none;
}

.cmd-chevron {
  @apply text-[10px] text-zinc-400 transition-transform duration-150 flex-shrink-0;
}

.cmd-chevron-open {
  transform: rotate(90deg);
}

.cmd-label {
  @apply flex-1 min-w-0 truncate text-xs font-mono text-zinc-700;
}

.cmd-status {
  @apply max-w-24 truncate text-right text-xs font-medium flex-shrink-0;
}

.cmd-status-running .cmd-status {
  @apply text-amber-600;
}

.cmd-status-ok .cmd-status {
  @apply text-emerald-600;
}

.cmd-status-error .cmd-status {
  @apply text-rose-600;
}

.cmd-output-wrap {
  @apply rounded-b-lg bg-zinc-900;
  display: none;
  border: 1px solid transparent;
  border-top: none;
}

.cmd-output-wrap.cmd-output-visible {
  display: block;
  border-color: #e4e4e7;
}

.cmd-output-inner {
  overflow: hidden;
  min-height: 0;
}

.cmd-output {
  @apply m-0 px-3 py-2 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words max-h-60 overflow-y-auto;
}

.cmd-output.cmd-output-condensed {
  max-height: 9rem;
}

@media (hover: none), (pointer: coarse) {
  .cmd-row {
    min-height: 2.75rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cmd-chevron {
    transition: none;
  }
}
</style>
