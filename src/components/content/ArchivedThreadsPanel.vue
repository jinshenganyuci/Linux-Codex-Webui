<template>
  <div class="archived-panel">
    <div class="archived-toolbar">
      <label class="archived-search">
        <IconTablerSearch aria-hidden="true" />
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="search"
          :placeholder="t('Search archived threads...')"
          :aria-label="t('Search archived threads')"
        />
      </label>
      <div class="archived-toolbar-side">
        <span class="archived-count">{{ threads.length }} {{ t('archived') }}</span>
        <button class="archived-refresh" type="button" :disabled="isLoading" @click="loadFirstPage">
          {{ isLoading ? t('Refreshing...') : t('Refresh') }}
        </button>
      </div>
    </div>

    <p v-if="notice" class="archived-notice" :data-kind="notice.kind" role="status">
      {{ notice.text }}
    </p>
    <p v-if="loadError" class="archived-error" role="alert">{{ loadError }}</p>

    <div v-if="isLoading && threads.length === 0" class="archived-empty">
      <IconTablerArchive aria-hidden="true" />
      <p>{{ t('Loading archived threads...') }}</p>
    </div>

    <div v-else-if="threads.length === 0" class="archived-empty">
      <IconTablerArchive aria-hidden="true" />
      <p>{{ t('No archived threads') }}</p>
    </div>

    <div v-else-if="filteredThreads.length === 0" class="archived-empty">
      <IconTablerSearch aria-hidden="true" />
      <p>{{ t('No archived threads match this search') }}</p>
    </div>

    <section v-else class="archived-list" :aria-label="t('Archived threads')">
      <article v-for="thread in filteredThreads" :key="thread.id" class="archived-row">
        <span class="archived-row-icon" aria-hidden="true">
          <IconTablerArchive />
        </span>
        <div class="archived-row-main">
          <h2 class="archived-row-title" :title="thread.title">{{ thread.title }}</h2>
          <p v-if="shouldShowPreview(thread)" class="archived-row-preview">{{ thread.preview }}</p>
          <div class="archived-row-meta">
            <span :title="thread.cwd">{{ thread.projectName }}</span>
            <span>{{ formatArchivedDate(thread.updatedAtIso) }}</span>
          </div>
        </div>
        <div class="archived-row-actions">
          <button
            class="archived-icon-button is-restore"
            type="button"
            :title="t('Restore thread')"
            :aria-label="t('Restore thread')"
            :disabled="actionThreadId.length > 0"
            @click="restoreThread(thread)"
          >
            <span v-if="actionThreadId === thread.id && actionKind === 'restore'" class="archived-action-spinner" aria-hidden="true" />
            <IconTablerArrowBackUp v-else />
          </button>
          <button
            class="archived-icon-button is-delete"
            type="button"
            :title="t('Permanently delete thread')"
            :aria-label="t('Permanently delete thread')"
            :disabled="actionThreadId.length > 0"
            @click="openDeleteDialog(thread)"
          >
            <IconTablerTrash />
          </button>
        </div>
      </article>
    </section>

    <button
      v-if="nextCursor && searchQuery.trim().length === 0"
      class="archived-load-more"
      type="button"
      :disabled="isLoading"
      @click="loadNextPage"
    >
      {{ isLoading ? t('Loading...') : t('Load more') }}
    </button>

    <Teleport to="body">
      <div v-if="deleteCandidate" class="archived-dialog-overlay" @click.self="closeDeleteDialog">
        <div
          ref="deleteDialogRef"
          class="archived-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="t('Permanently delete thread?')"
          tabindex="-1"
          @keydown="onDeleteDialogKeydown"
        >
          <span class="archived-dialog-icon" aria-hidden="true"><IconTablerTrash /></span>
          <div class="archived-dialog-copy">
            <h2>{{ t('Permanently delete thread?') }}</h2>
            <p>{{ t('This permanently deletes "{title}" and cannot be undone.', { title: deleteCandidate.title }) }}</p>
          </div>
          <div class="archived-dialog-actions">
            <button ref="deleteCancelButtonRef" type="button" :disabled="actionThreadId.length > 0" @click="closeDeleteDialog">{{ t('Cancel') }}</button>
            <button class="is-danger" type="button" :disabled="actionThreadId.length > 0" @click="deleteThread">
              <span v-if="actionThreadId === deleteCandidate.id && actionKind === 'delete'" class="archived-dialog-spinner" aria-hidden="true" />
              <span v-else>{{ t('Delete permanently') }}</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  getArchivedThreadsPage,
  permanentlyDeleteThread,
  unarchiveThread,
} from '../../api/codexGateway'
import type { UiThread } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerArchive from '../icons/IconTablerArchive.vue'
import IconTablerArrowBackUp from '../icons/IconTablerArrowBackUp.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerTrash from '../icons/IconTablerTrash.vue'

const emit = defineEmits<{
  changed: []
}>()

const { t, uiLanguage } = useUiLanguage()
const threads = ref<UiThread[]>([])
const nextCursor = ref<string | null>(null)
const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const isLoading = ref(false)
const loadError = ref('')
const actionThreadId = ref('')
const actionKind = ref<'restore' | 'delete' | ''>('')
const deleteCandidate = ref<UiThread | null>(null)
const deleteDialogRef = ref<HTMLElement | null>(null)
const deleteCancelButtonRef = ref<HTMLButtonElement | null>(null)
const notice = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
let loadRequestId = 0
let deleteDialogPreviouslyFocused: HTMLElement | null = null
let deleteDialogBackground: HTMLElement | null = null
let deleteDialogBackgroundWasInert = false
let deleteDialogPreviousBodyOverflow = ''
let deleteDialogEnvironmentLocked = false

const filteredThreads = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return threads.value
  return threads.value.filter((thread) => (
    [thread.title, thread.preview, thread.projectName, thread.cwd]
      .some((value) => value.toLocaleLowerCase().includes(query))
  ))
})

onMounted(() => {
  void loadFirstPage()
})

watch(deleteCandidate, (candidate) => {
  if (candidate) {
    lockDeleteDialogEnvironment()
    void nextTick(() => deleteCancelButtonRef.value?.focus({ preventScroll: true }))
  } else {
    restoreDeleteDialogEnvironment()
  }
})

onBeforeUnmount(restoreDeleteDialogEnvironment)

async function loadFirstPage(): Promise<void> {
  const requestId = ++loadRequestId
  isLoading.value = true
  loadError.value = ''
  try {
    const page = await getArchivedThreadsPage()
    if (requestId !== loadRequestId) return
    threads.value = page.threads
    nextCursor.value = page.nextCursor
  } catch (error) {
    if (requestId !== loadRequestId) return
    loadError.value = error instanceof Error ? error.message : t('Failed to load archived threads')
  } finally {
    if (requestId === loadRequestId) isLoading.value = false
  }
}

async function loadNextPage(): Promise<void> {
  if (!nextCursor.value || isLoading.value) return
  const requestId = ++loadRequestId
  const cursor = nextCursor.value
  isLoading.value = true
  loadError.value = ''
  try {
    const page = await getArchivedThreadsPage(cursor)
    if (requestId !== loadRequestId) return
    const merged = new Map(threads.value.map((thread) => [thread.id, thread]))
    for (const thread of page.threads) merged.set(thread.id, thread)
    threads.value = Array.from(merged.values())
    nextCursor.value = page.nextCursor
  } catch (error) {
    if (requestId !== loadRequestId) return
    loadError.value = error instanceof Error ? error.message : t('Failed to load archived threads')
  } finally {
    if (requestId === loadRequestId) isLoading.value = false
  }
}

async function restoreThread(thread: UiThread): Promise<void> {
  if (actionThreadId.value) return
  actionThreadId.value = thread.id
  actionKind.value = 'restore'
  notice.value = null
  try {
    await unarchiveThread(thread.id)
    removeThread(thread.id)
    notice.value = { kind: 'success', text: t('Restored "{title}"', { title: thread.title }) }
    emit('changed')
  } catch (error) {
    notice.value = {
      kind: 'error',
      text: error instanceof Error ? error.message : t('Failed to restore thread'),
    }
  } finally {
    actionThreadId.value = ''
    actionKind.value = ''
  }
}

function closeDeleteDialog(): void {
  if (actionThreadId.value) return
  deleteCandidate.value = null
}

function openDeleteDialog(thread: UiThread): void {
  deleteDialogPreviouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  deleteCandidate.value = thread
}

function lockDeleteDialogEnvironment(): void {
  if (deleteDialogEnvironmentLocked) return
  deleteDialogPreviousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  deleteDialogBackground = document.querySelector<HTMLElement>('.desktop-layout')
  deleteDialogBackgroundWasInert = deleteDialogBackground?.hasAttribute('inert') ?? false
  if (deleteDialogBackground && !deleteDialogBackgroundWasInert) deleteDialogBackground.setAttribute('inert', '')
  deleteDialogEnvironmentLocked = true
}

function restoreDeleteDialogEnvironment(): void {
  if (!deleteDialogEnvironmentLocked) return
  document.body.style.overflow = deleteDialogPreviousBodyOverflow
  if (deleteDialogBackground && !deleteDialogBackgroundWasInert) deleteDialogBackground.removeAttribute('inert')
  deleteDialogBackground = null
  deleteDialogBackgroundWasInert = false
  const focusTarget = deleteDialogPreviouslyFocused
  deleteDialogPreviouslyFocused = null
  deleteDialogEnvironmentLocked = false
  void nextTick(() => {
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true })
    else searchInputRef.value?.focus({ preventScroll: true })
  })
}

function onDeleteDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDeleteDialog()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = deleteDialogRef.value
  if (!dialog) return
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getClientRects().length > 0)
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus({ preventScroll: true })
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

async function deleteThread(): Promise<void> {
  const thread = deleteCandidate.value
  if (!thread || actionThreadId.value) return
  actionThreadId.value = thread.id
  actionKind.value = 'delete'
  notice.value = null
  try {
    await permanentlyDeleteThread(thread.id)
    removeThread(thread.id)
    deleteCandidate.value = null
    notice.value = { kind: 'success', text: t('Permanently deleted "{title}"', { title: thread.title }) }
    emit('changed')
  } catch (error) {
    notice.value = {
      kind: 'error',
      text: error instanceof Error ? error.message : t('Failed to permanently delete thread'),
    }
  } finally {
    actionThreadId.value = ''
    actionKind.value = ''
  }
}

function removeThread(threadId: string): void {
  threads.value = threads.value.filter((thread) => thread.id !== threadId)
}

function shouldShowPreview(thread: UiThread): boolean {
  const preview = thread.preview.trim()
  return preview.length > 0 && preview !== thread.title.trim()
}

function formatArchivedDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(uiLanguage.value === 'zh-CN' ? 'zh-CN' : 'en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
</script>

<style scoped>
@reference "tailwindcss";

.archived-panel {
  @apply mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-3 pb-4 sm:px-5;
}

.archived-toolbar {
  @apply flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3;
}

.archived-search {
  @apply flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-zinc-500 sm:max-w-md;
}

.archived-search > svg {
  @apply h-4 w-4 shrink-0;
}

.archived-search input {
  @apply min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-zinc-900 outline-none placeholder:text-zinc-400;
}

.archived-toolbar-side {
  @apply flex shrink-0 items-center gap-2;
}

.archived-count {
  @apply text-xs text-zinc-500;
}

.archived-refresh,
.archived-load-more {
  @apply h-9 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-default disabled:opacity-50;
}

.archived-notice,
.archived-error {
  @apply mb-0 mt-2 rounded-lg border px-3 py-2 text-sm;
}

.archived-notice[data-kind='success'] {
  @apply border-emerald-200 bg-emerald-50 text-emerald-800;
}

.archived-notice[data-kind='error'],
.archived-error {
  @apply border-red-200 bg-red-50 text-red-700;
}

.archived-list {
  @apply min-h-0 flex-1 overflow-y-auto;
}

.archived-row {
  @apply grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 border-b border-zinc-200 py-3;
}

.archived-row-icon {
  @apply flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600;
}

.archived-row-icon > svg {
  @apply h-4.5 w-4.5;
}

.archived-row-main {
  @apply min-w-0;
}

.archived-row-title {
  @apply m-0 truncate text-sm font-semibold tracking-normal text-zinc-900;
}

.archived-row-preview {
  @apply mb-0 mt-1 line-clamp-2 text-sm leading-5 text-zinc-600;
}

.archived-row-meta {
  @apply mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500;
}

.archived-row-meta span:first-child {
  @apply max-w-full truncate;
}

.archived-row-actions {
  @apply flex shrink-0 items-center gap-1;
}

.archived-icon-button {
  @apply flex h-8 w-8 items-center justify-center rounded-[10px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default disabled:opacity-40;
}

.archived-icon-button.is-restore:hover {
  @apply bg-emerald-50 text-emerald-700;
}

.archived-icon-button.is-delete:hover {
  @apply bg-red-50 text-red-700;
}

.archived-icon-button > svg {
  @apply h-4 w-4;
}

.archived-action-spinner,
.archived-dialog-spinner {
  @apply h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent;
}

.archived-load-more {
  @apply mx-auto mt-3 shrink-0;
}

.archived-empty {
  @apply flex min-h-64 flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-zinc-500;
}

.archived-empty > svg {
  @apply h-8 w-8 text-zinc-400;
}

.archived-empty p {
  @apply m-0;
}

.archived-dialog-overlay {
  @apply fixed inset-0 flex items-center justify-center bg-black/40 p-4;
  z-index: var(--ui-z-modal);
}

.archived-dialog {
  @apply grid w-full max-w-md grid-cols-[40px_minmax(0,1fr)] gap-3 border p-4;
  border-radius: var(--ui-radius-panel);
  border-color: var(--mac-border-strong);
  background: var(--mac-solid);
  box-shadow: var(--mac-shadow-menu);
}

.archived-dialog-icon {
  @apply flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-700;
}

.archived-dialog-icon > svg {
  @apply h-5 w-5;
}

.archived-dialog-copy {
  @apply min-w-0;
}

.archived-dialog-copy h2 {
  @apply m-0 text-base font-semibold tracking-normal text-zinc-950;
}

.archived-dialog-copy p {
  @apply mb-0 mt-1 break-words text-sm leading-5 text-zinc-600;
}

.archived-dialog-actions {
  @apply col-span-2 mt-2 flex justify-end gap-2;
}

.archived-dialog-actions button {
  @apply flex h-9 min-w-20 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-default disabled:opacity-50;
}

.archived-dialog-actions button.is-danger {
  @apply border-red-600 bg-red-600 text-white hover:bg-red-700;
}

@media (hover: none), (pointer: coarse) {
  .archived-icon-button,
  .archived-dialog-actions button {
    min-height: 2.75rem;
  }

  .archived-icon-button {
    min-width: 2.75rem;
  }
}

:global(:root.dark) .archived-toolbar,
:global(:root.dark) .archived-row {
  @apply border-zinc-800;
}

:global(:root.dark) .archived-search,
:global(:root.dark) .archived-refresh,
:global(:root.dark) .archived-load-more,
:global(:root.dark) .archived-dialog,
:global(:root.dark) .archived-dialog-actions button {
  @apply border-zinc-700 bg-zinc-900 text-zinc-200;
}

:global(:root.dark) .archived-search input,
:global(:root.dark) .archived-row-title,
:global(:root.dark) .archived-dialog-copy h2 {
  @apply text-zinc-100;
}

:global(:root.dark) .archived-row-preview,
:global(:root.dark) .archived-dialog-copy p {
  @apply text-zinc-400;
}

:global(:root.dark) .archived-row-icon {
  @apply bg-zinc-800 text-zinc-300;
}

:global(:root.dark) .archived-icon-button:hover,
:global(:root.dark) .archived-refresh:hover,
:global(:root.dark) .archived-load-more:hover,
:global(:root.dark) .archived-dialog-actions button:hover {
  @apply bg-zinc-800 text-zinc-100;
}

:global(:root.dark) .archived-dialog-actions button.is-danger,
:global(:root.dark) .archived-dialog-actions button.is-danger:hover {
  @apply border-red-600 bg-red-600 text-white hover:bg-red-700;
}

@media (max-width: 640px) {
  .archived-toolbar {
    @apply items-stretch;
  }

  .archived-search {
    @apply w-full basis-full;
  }

  .archived-toolbar-side {
    @apply w-full justify-between;
  }

  .archived-row {
    @apply grid-cols-[32px_minmax(0,1fr)] gap-x-2;
  }

  .archived-row-icon {
    @apply h-8 w-8;
  }

  .archived-row-actions {
    @apply col-start-2 mt-2 justify-end;
  }
}
</style>
