import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import {
  createPendingRequestDraftStore, isSecretInputQuestion, isUserInputRequest, pendingRequestDraftIdentity,
} from '../pendingRequestDrafts'
import type { UiServerRequest } from '../types/codex'

function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function usePendingRequestDraft(request: Ref<UiServerRequest | null>) {
  const store = createPendingRequestDraftStore(browserStorage())
  const answers = ref<Record<string, string>>({})
  const otherAnswers = ref<Record<string, string>>({})
  const status = ref<'idle' | 'saved' | 'unavailable'>('idle')
  const identity = computed(() => request.value ? pendingRequestDraftIdentity(request.value) : '')
  let activeKey = ''
  let editableKeys = new Set<string>()
  let hydrating = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function keepPersistable(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).filter(([key]) => editableKeys.has(key)))
  }

  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!dirty || !activeKey) return
    dirty = false
    const persisted = store.write(activeKey, {
      answers: keepPersistable(answers.value), otherAnswers: keepPersistable(otherAnswers.value),
    })
    status.value = persisted ? 'saved' : 'unavailable'
  }

  watch(identity, (key) => {
    flush()
    hydrating = true
    activeKey = key
    editableKeys = new Set<string>()
    const current = request.value
    if (current && isUserInputRequest(current)) {
      const params = current.params as { questions?: Array<{ id?: unknown; isSecret?: unknown; secret?: unknown }> } | null
      for (const question of Array.isArray(params?.questions) ? params.questions : []) {
        if (question && typeof question.id === 'string' && !isSecretInputQuestion(question)) {
          editableKeys.add(`${String(current.id)}:${question.id}`)
        }
      }
    }
    const draft = key ? store.read(key) : null
    answers.value = keepPersistable(draft?.answers ?? {})
    otherAnswers.value = keepPersistable(draft?.otherAnswers ?? {})
    status.value = draft ? 'saved' : 'idle'
    hydrating = false
  }, { immediate: true, flush: 'sync' })

  watch([answers, otherAnswers], () => {
    if (hydrating || !activeKey || editableKeys.size === 0) return
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 250)
  }, { deep: true, flush: 'sync' })

  function clearSubmitted(key: string): void {
    if (key === activeKey) {
      if (timer) clearTimeout(timer)
      timer = undefined
      dirty = false
      hydrating = true
      answers.value = {}
      otherAnswers.value = {}
      status.value = 'idle'
      hydrating = false
    }
    store.remove(key)
  }

  onMounted(() => window.addEventListener('pagehide', flush))
  onBeforeUnmount(() => {
    flush()
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
  })
  return { answers, otherAnswers, status, flush, clearSubmitted }
}
