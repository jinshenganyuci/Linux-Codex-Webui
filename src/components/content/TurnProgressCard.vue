<template>
  <article
    class="turn-progress-card"
    :data-tone="rootTone"
    aria-live="polite"
    aria-atomic="false"
  >
    <header class="turn-progress-header">
      <div class="turn-progress-title-wrap">
        <span class="turn-progress-pulse" aria-hidden="true"></span>
        <div class="turn-progress-heading">
          <div v-if="progress" class="turn-progress-title-line">
            <p class="turn-progress-title">{{ t('Main reasoning model') }}</p>
            <span class="turn-progress-status" :data-status="rootTone">{{ rootStatusLabel }}</span>
          </div>
          <p v-else class="turn-progress-title">{{ progressTitle }}</p>
          <p v-if="progress && overlay.mainModelDetails?.length" class="turn-progress-main-model-details">
            {{ overlay.mainModelDetails.join(' · ') }}
          </p>
          <p v-if="progress" class="turn-progress-summary">
            {{ progressTitle }} · {{ t('{active} active · {completed}/{total} completed', {
              active: counts.active,
              completed: counts.completed,
              total: counts.total,
            }) }}
          </p>
          <p v-else-if="overlay.activityDetails.length > 0" class="turn-progress-summary">
            {{ overlay.activityDetails.join(' · ') }}
          </p>
        </div>
      </div>
      <div class="turn-progress-header-meta">
        <span v-if="connectionWarning" class="turn-progress-connection" :data-state="connectionState">
          {{ connectionLabel }}
        </span>
        <span v-if="progress" class="turn-progress-elapsed">
          {{ progress.status === 'running'
            ? t('Elapsed {time}', { time: elapsedText })
            : t('Duration {time}', { time: elapsedText }) }}
        </span>
      </div>
    </header>

    <button
      v-if="progress && isMobile"
      ref="mobileOpenButtonRef"
      type="button"
      class="turn-progress-mobile-open"
      :aria-expanded="mobileOpen"
      @click="mobileOpen = true"
    >
      {{ t('View agent activity') }}
      <span aria-hidden="true">↑</span>
    </button>

    <div
      v-if="progress"
      ref="mobileSheetRef"
      class="turn-progress-body"
      :class="{ 'turn-progress-body-mobile-open': mobileOpen }"
      :role="isMobile && mobileOpen ? 'dialog' : undefined"
      :aria-modal="isMobile && mobileOpen ? 'true' : undefined"
      :aria-label="isMobile ? t('Agent activity') : undefined"
      :tabindex="isMobile && mobileOpen ? -1 : undefined"
      @keydown="onMobileSheetKeydown"
    >
      <div class="turn-progress-mobile-sheet-header">
        <div>
          <p class="turn-progress-title">{{ t('Agent activity') }}</p>
          <p class="turn-progress-summary">{{ progressTitle }} · {{ elapsedText }}</p>
        </div>
        <button ref="mobileCloseButtonRef" type="button" class="turn-progress-close" :aria-label="t('Close')" @click="mobileOpen = false">×</button>
      </div>

      <button
        v-if="!isMobile"
        type="button"
        class="turn-progress-agent-details-toggle"
        :aria-expanded="agentDetailsOpen"
        :aria-controls="agentDetailsId"
        @click="agentDetailsOpen = !agentDetailsOpen"
      >
        {{ agentDetailsOpen ? t('Hide agent details') : t('Show agent details') }}
        <span aria-hidden="true">{{ agentDetailsOpen ? '−' : '+' }}</span>
      </button>

      <div
        v-show="agentDetailsOpen || isMobile"
        :id="agentDetailsId"
        class="turn-progress-tree"
        role="list"
        :aria-label="t('Agent tree')"
      >
        <div
          v-for="(agent, index) in orderedAgents"
          :key="agent.threadId"
          class="turn-progress-agent-row"
          :style="agentIndentStyle(agent.depth)"
          :data-depth="agent.depth"
          role="listitem"
        >
          <span class="turn-progress-agent-rail" aria-hidden="true"></span>
          <span class="turn-progress-agent-dot" :data-status="agentTone(agent)" aria-hidden="true"></span>
          <div class="turn-progress-agent-copy">
            <div class="turn-progress-agent-line">
              <strong>{{ agentDisplayName(agent, index) }}</strong>
              <span v-if="agent.path" class="turn-progress-agent-path">{{ agent.path }}</span>
              <span class="turn-progress-status" :data-status="agentTone(agent)">
                {{ t(agentStatusTranslationKey(agent.status, agentIsStale(agent))) }}
              </span>
            </div>
            <p v-if="agent.taskSummary" class="turn-progress-agent-task">{{ agent.taskSummary }}</p>
            <p class="turn-progress-agent-meta">
              <span v-if="agent.currentActivity">{{ activityLabel(agent.currentActivity) }}</span>
              <span>{{ agent.status === 'starting' || agent.status === 'running'
                ? t('Last activity {time} ago', { time: relativeActivity(agent.lastActivityAtMs) })
                : t('Duration {time}', { time: agentDurationText(agent) }) }}</span>
              <span v-if="agent.model">{{ agent.model }}<template v-if="agent.reasoningEffort"> · {{ agent.reasoningEffort }}</template></span>
            </p>
            <div v-if="agent.resultAvailable" class="turn-progress-result-wrap">
              <button
                type="button"
                class="turn-progress-result-button"
                :aria-expanded="expandedResultIds.has(agent.threadId)"
                :aria-controls="agentResultId(agent.threadId)"
                @click="toggleAgentResult(agent)"
              >
                {{ agent.resultLoading
                  ? t('Loading result…')
                  : expandedResultIds.has(agent.threadId)
                    ? t('Hide result')
                    : t('View result') }}
              </button>
              <div
                v-if="expandedResultIds.has(agent.threadId)"
                :id="agentResultId(agent.threadId)"
                class="turn-progress-result"
                :aria-busy="agent.resultLoading"
              >
                <p v-if="agent.resultError" class="turn-progress-result-error" role="alert">{{ agent.resultError }}</p>
                <p v-else-if="agent.resultLoading" class="turn-progress-result-placeholder">{{ t('Loading result…') }}</p>
                <template v-else>
                  <p v-if="agent.resultTruncated" class="turn-progress-result-note">{{ t('Showing the last part of this result.') }}</p>
                  <pre>{{ agent.resultText || t('(no result text)') }}</pre>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        v-if="progress.events.length > 0"
        type="button"
        class="turn-progress-timeline-toggle"
        :aria-expanded="timelineOpen"
        @click="timelineOpen = !timelineOpen"
      >
        {{ timelineOpen ? t('Hide timeline') : t('Show timeline') }}
        <span aria-hidden="true">{{ timelineOpen ? '−' : '+' }}</span>
      </button>
      <ol v-if="timelineOpen && progress.events.length > 0" class="turn-progress-timeline">
        <li v-for="event in visibleEvents" :key="event.id">
          <time>{{ eventTime(event.atMs) }}</time>
          <span>{{ eventLabel(event.kind, event.detail) }}</span>
        </li>
      </ol>
    </div>

    <p v-if="overlay.reasoningText" class="turn-progress-reasoning">{{ overlay.reasoningText }}</p>
    <div v-if="overlay.errorText" class="turn-progress-error" role="alert">
      <span>{{ overlay.errorText }}</span>
      <slot name="error-action"></slot>
    </div>
  </article>

  <button
    v-if="progress && isMobile && mobileOpen"
    type="button"
    class="turn-progress-mobile-backdrop"
    :aria-label="t('Close agent activity')"
    @click="mobileOpen = false"
  ></button>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { UiAgentProgressNode, UiLiveOverlay } from '../../types/codex'
import { useMobile } from '../../composables/useMobile'
import { useUiLanguage } from '../../composables/useUiLanguage'
import {
  agentDisplayName,
  agentDurationMs,
  agentStatusTranslationKey,
  countAgentProgress,
  formatProgressDuration,
  isAgentNodeStale,
  isAgentProgressStale,
  orderedAgentProgressNodes,
  phaseTranslationKey,
  progressDurationMs,
} from './turnProgressUtils'

const props = defineProps<{
  overlay: UiLiveOverlay
  loadAgentResult?: (threadId: string) => Promise<void>
}>()

const { isMobile } = useMobile()
const { t } = useUiLanguage()
const nowMs = ref(Date.now())
const mobileOpen = ref(false)
const agentDetailsOpen = ref(false)
const timelineOpen = ref(false)
const expandedResultIds = ref<Set<string>>(new Set())
const mobileOpenButtonRef = ref<HTMLButtonElement | null>(null)
const mobileCloseButtonRef = ref<HTMLButtonElement | null>(null)
const mobileSheetRef = ref<HTMLElement | null>(null)
let clockTimer: ReturnType<typeof setInterval> | null = null

const progress = computed(() => props.overlay.turnProgress ?? null)
const progressIdentity = computed(() => progress.value
  ? `${progress.value.rootThreadId}:${progress.value.turnId}`
  : '')
const agentDetailsId = computed(() => `agent-details-${progressIdentity.value.replace(/[^a-zA-Z0-9_-]/gu, '-') || 'current'}`)
const connectionState = computed(() => props.overlay.connectionState ?? 'connected')
const orderedAgents = computed(() => progress.value ? orderedAgentProgressNodes(progress.value) : [])
const counts = computed(() => progress.value
  ? countAgentProgress(progress.value)
  : { total: 0, active: 0, completed: 0, interrupted: 0, failed: 0 })
const rootStale = computed(() => progress.value
  ? isAgentProgressStale(progress.value, nowMs.value, connectionState.value)
  : false)
const connectionWarning = computed(() => connectionState.value !== 'connected')
const progressTitle = computed(() => {
  if (connectionState.value === 'reconnecting') return t('Reconnecting to live updates')
  if (connectionState.value === 'unavailable') return t('Live updates unavailable')
  if (rootStale.value) return t('Still running, no recent activity')
  return progress.value ? t(phaseTranslationKey(progress.value.phase)) : t(props.overlay.activityLabel)
})
const connectionLabel = computed(() => {
  if (connectionState.value === 'connecting') return t('Connecting')
  if (connectionState.value === 'reconnecting') return t('Reconnecting')
  if (connectionState.value === 'unavailable') return t('Not connected')
  return t('Connected')
})
const rootTone = computed(() => {
  if (connectionWarning.value && progress.value?.status === 'running') return 'disconnected'
  if (rootStale.value) return 'stale'
  if (progress.value?.status === 'failed') return 'failed'
  if (progress.value?.status === 'interrupted') return 'interrupted'
  if (progress.value?.status === 'completed') return 'completed'
  return 'running'
})
const rootStatusLabel = computed(() => {
  if (rootTone.value === 'disconnected') return connectionLabel.value
  if (rootTone.value === 'stale') return t('Stale')
  if (progress.value?.status === 'completed') return t('Completed')
  if (progress.value?.status === 'interrupted') return t('Interrupted')
  if (progress.value?.status === 'failed') return t('Failed')
  return progress.value ? t(phaseTranslationKey(progress.value.phase)) : t('Running')
})
const elapsedText = computed(() => progress.value
  ? formatProgressDuration(progressDurationMs(progress.value, nowMs.value))
  : '0s')
const visibleEvents = computed(() => progress.value?.events.slice(-24).reverse() ?? [])

function relativeActivity(atMs: number): string {
  return formatProgressDuration(Math.max(0, nowMs.value - atMs))
}

function agentDurationText(agent: UiAgentProgressNode): string {
  return formatProgressDuration(agentDurationMs(agent, nowMs.value))
}

function agentIsStale(agent: UiAgentProgressNode): boolean {
  return isAgentNodeStale(agent, nowMs.value, connectionState.value)
}

function agentTone(agent: UiAgentProgressNode): string {
  if (connectionWarning.value && (agent.status === 'starting' || agent.status === 'running')) return 'disconnected'
  if (agentIsStale(agent)) return 'stale'
  if (agent.status === 'completed') return 'completed'
  if (agent.status === 'interrupted') return 'interrupted'
  if (agent.status === 'errored') return 'failed'
  return 'running'
}

function agentIndentStyle(depth: number): CSSProperties {
  return { '--agent-depth': String(Math.max(1, depth)) } as CSSProperties
}

function activityLabel(activity: string): string {
  const labels: Record<string, string> = {
    working: 'Working',
    communicating: 'Communicating',
    starting: 'Starting',
    reasoning: 'Reasoning',
    executing: 'Executing',
    applyingChanges: 'Applying changes',
    summarizing: 'Summarizing',
  }
  return t(labels[activity] ?? activity)
}

function eventTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function eventLabel(kind: string, detail: string): string {
  const labels: Record<string, string> = {
    phaseChanged: 'Phase changed',
    agentStarted: 'Agent started',
    agentInteracted: 'Agents communicated',
    agentCompleted: 'Agent completed',
    agentInterrupted: 'Agent interrupted',
    agentErrored: 'Agent failed',
    turnCompleted: 'Turn completed',
  }
  const label = t(labels[kind] ?? kind)
  return detail ? `${label} · ${detail}` : label
}

function agentResultId(threadId: string): string {
  return `agent-result-${threadId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
}

function toggleAgentResult(agent: UiAgentProgressNode): void {
  const next = new Set(expandedResultIds.value)
  if (next.has(agent.threadId)) {
    next.delete(agent.threadId)
  } else {
    next.add(agent.threadId)
    if (agent.resultText === undefined && !agent.resultLoading) void props.loadAgentResult?.(agent.threadId)
  }
  expandedResultIds.value = next
}

function onMobileSheetKeydown(event: KeyboardEvent): void {
  if (!mobileOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    mobileOpen.value = false
    return
  }
  if (event.key !== 'Tab') return
  const sheet = mobileSheetRef.value
  if (!sheet) return
  const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.offsetParent !== null)
  if (focusable.length === 0) {
    event.preventDefault()
    sheet.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(mobileOpen, async (isOpen) => {
  await nextTick()
  if (isOpen) mobileCloseButtonRef.value?.focus()
  else mobileOpenButtonRef.value?.focus()
})

watch(progressIdentity, () => {
  agentDetailsOpen.value = false
  timelineOpen.value = false
  expandedResultIds.value = new Set()
  mobileOpen.value = false
})

watch(() => progress.value?.status, (status) => {
  if (clockTimer !== null) {
    clearInterval(clockTimer)
    clockTimer = null
  }
  if (status !== 'running') return
  nowMs.value = Date.now()
  clockTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1_000)
}, { immediate: true })

onBeforeUnmount(() => {
  if (clockTimer !== null) clearInterval(clockTimer)
})
</script>
