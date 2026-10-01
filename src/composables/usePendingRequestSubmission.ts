import { computed, ref, type Ref } from 'vue'
import { pendingRequestDraftIdentity } from '../pendingRequestDrafts'
import type { UiServerRequest } from '../types/codex'

export function usePendingRequestSubmission(request: Ref<UiServerRequest | null>) {
  const isSubmitting = ref(false)
  const failedRequestIdentity = ref('')
  const hasSubmissionError = computed(() => Boolean(
    request.value && failedRequestIdentity.value === pendingRequestDraftIdentity(request.value),
  ))

  async function submit(callback: () => Promise<boolean>): Promise<string | null> {
    if (isSubmitting.value || !request.value) return null
    const identity = pendingRequestDraftIdentity(request.value)
    failedRequestIdentity.value = ''
    isSubmitting.value = true
    try {
      if (await callback()) return identity
      failedRequestIdentity.value = identity
      return null
    } catch {
      failedRequestIdentity.value = identity
      return null
    } finally {
      isSubmitting.value = false
    }
  }

  return { isSubmitting, hasSubmissionError, submit }
}
