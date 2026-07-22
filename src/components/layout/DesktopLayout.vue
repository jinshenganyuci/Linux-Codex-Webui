<template>
  <div class="desktop-layout" :class="{ 'is-mobile': isMobile }" :style="layoutStyle">
    <Teleport v-if="isMobile" to="body">
      <Transition name="drawer">
        <div v-if="!isSidebarCollapsed" class="mobile-drawer-backdrop" @click="$emit('close-sidebar')">
          <aside class="mobile-drawer" @click.stop>
            <slot name="sidebar" />
          </aside>
        </div>
      </Transition>
    </Teleport>

    <template v-if="!isMobile">
      <aside v-if="!isSidebarCollapsed" class="desktop-sidebar">
        <slot name="sidebar" />
      </aside>
      <button
        v-if="!isSidebarCollapsed"
        class="desktop-resize-handle"
        type="button"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('Resize sidebar')"
        :aria-valuemin="MIN_SIDEBAR_WIDTH"
        :aria-valuemax="MAX_SIDEBAR_WIDTH"
        :aria-valuenow="Math.round(sidebarWidth)"
        @pointerdown="onResizeHandlePointerDown"
        @keydown="onResizeHandleKeydown"
      />
    </template>

    <section class="desktop-main">
      <slot name="content" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMobile } from '../../composables/useMobile'
import { useUiLanguage } from '../../composables/useUiLanguage'

const props = withDefaults(
  defineProps<{
    isSidebarCollapsed?: boolean
  }>(),
  {
    isSidebarCollapsed: false,
  },
)

defineEmits<{
  'close-sidebar': []
}>()

const { isMobile } = useMobile()
const { t } = useUiLanguage()

const SIDEBAR_WIDTH_KEY = 'codex-web-local.sidebar-width.v1'
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 620
const DEFAULT_SIDEBAR_WIDTH = 320

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
}

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(parsed)
}

const sidebarWidth = ref(loadSidebarWidth())

const layoutStyle = computed(() => {
  if (isMobile.value || props.isSidebarCollapsed) {
    return {
      '--sidebar-width': '0px',
      '--layout-columns': 'minmax(0, 1fr)',
    }
  }
  return {
    '--sidebar-width': `${sidebarWidth.value}px`,
    '--layout-columns': 'var(--sidebar-width) 1px minmax(0, 1fr)',
  }
})

function saveSidebarWidth(value: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value))
}

function onResizeHandlePointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = sidebarWidth.value
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    target.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return
    const delta = moveEvent.clientX - startX
    sidebarWidth.value = clampSidebarWidth(startWidth + delta)
  }

  const onPointerEnd = (endEvent: PointerEvent) => {
    if (endEvent.pointerId !== event.pointerId) return
    saveSidebarWidth(sidebarWidth.value)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerEnd)
    window.removeEventListener('pointercancel', onPointerEnd)
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerEnd)
  window.addEventListener('pointercancel', onPointerEnd)
}

function onResizeHandleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const direction = event.key === 'ArrowLeft' ? -1 : 1
  const step = event.shiftKey ? 32 : 8
  sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + direction * step)
  saveSidebarWidth(sidebarWidth.value)
}
</script>

<style scoped>
@reference "tailwindcss";

.desktop-layout {
  @apply isolate grid bg-slate-100 text-slate-900 overflow-hidden;
  height: 100vh;
  height: 100dvh;
  grid-template-columns: var(--layout-columns);
}

.desktop-sidebar {
  @apply relative z-0 bg-slate-100 min-h-0 overflow-hidden;
}

.desktop-resize-handle {
  @apply relative z-10 w-px cursor-col-resize bg-slate-300 transition-colors;
}

.desktop-resize-handle::before {
  content: '';
  @apply absolute -left-2 -right-2 top-0 bottom-0;
}

.desktop-resize-handle:hover,
.desktop-resize-handle:focus-visible,
.desktop-resize-handle:active {
  background-color: var(--mac-accent);
}

.desktop-main {
  @apply relative z-0 bg-white min-h-0 overflow-y-hidden overflow-x-visible;
}

.desktop-layout:not(.is-mobile) .desktop-main {
  border-radius: var(--ui-radius-panel) 0 0 var(--ui-radius-panel);
  box-shadow: -8px 0 30px rgb(25 44 69 / 5%);
}

.mobile-drawer-backdrop {
  @apply fixed inset-0 bg-black/40;
  z-index: var(--ui-z-drawer);
}

.mobile-drawer {
  @apply absolute top-0 left-0 bottom-0 w-[88vw] max-w-[340px] bg-slate-100 overflow-hidden shadow-2xl;
  border-radius: 0 var(--ui-radius-sheet) var(--ui-radius-sheet) 0;
  padding-left: env(safe-area-inset-left);
}

.drawer-enter-active {
  transition: opacity 180ms var(--ui-ease-out);
}

.drawer-leave-active {
  transition: opacity 140ms var(--ui-ease-out);
}

.drawer-enter-active .mobile-drawer {
  transition: transform 220ms var(--ui-ease-drawer);
}

.drawer-leave-active .mobile-drawer {
  transition: transform 160ms var(--ui-ease-out);
}

.drawer-enter-from {
  @apply opacity-0;
}

.drawer-enter-from .mobile-drawer {
  transform: translateX(-100%);
}

.drawer-leave-to {
  @apply opacity-0;
}

.drawer-leave-to .mobile-drawer {
  transform: translateX(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active,
  .drawer-leave-active {
    transition-duration: 100ms;
  }

  .drawer-enter-active .mobile-drawer,
  .drawer-leave-active .mobile-drawer,
  .drawer-enter-from .mobile-drawer,
  .drawer-leave-to .mobile-drawer {
    transform: none;
    transition: none;
  }
}
</style>
