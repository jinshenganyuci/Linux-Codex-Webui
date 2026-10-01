import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingRequestDraftIdentity } from '../pendingRequestDrafts'
import type { UiServerRequest } from '../types/codex'
import { usePendingRequestSubmission } from './usePendingRequestSubmission'

const scopes: EffectScope[] = []

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

function request(overrides: Partial<UiServerRequest> = {}): UiServerRequest {
  return {
    id: 7, generation: 3, method: 'item/tool/requestUserInput',
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a',
    receivedAtIso: '2026-10-01T08:00:00.000Z', params: {}, ...overrides,
  }
}

function submissionState(initial: UiServerRequest | null = request()) {
  const currentRequest = ref(initial)
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => usePendingRequestSubmission(currentRequest))!
  return { currentRequest, ...state }
}

function deferredResult() {
  let resolve!: (value: boolean) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('pending request submission', () => {
  it('returns the submitted request identity after acknowledged success', async () => {
    const original = request()
    const state = submissionState(original)
    const response = deferredResult()
    const callback = vi.fn(() => response.promise)
    const result = state.submit(callback)
    expect(state.isSubmitting.value).toBe(true)
    expect(state.hasSubmissionError.value).toBe(false)
    expect(callback).toHaveBeenCalledTimes(1)
    response.resolve(true)
    await expect(result).resolves.toBe(pendingRequestDraftIdentity(original))
    expect(state.isSubmitting.value).toBe(false)
    expect(state.hasSubmissionError.value).toBe(false)
  })

  it('returns the captured identity when selection changes before success', async () => {
    const original = request()
    const state = submissionState(original)
    const response = deferredResult()
    const result = state.submit(() => response.promise)
    state.currentRequest.value = request({ threadId: 'thread-b', turnId: 'turn-b' })
    await nextTick()
    response.resolve(true)
    await expect(result).resolves.toBe(pendingRequestDraftIdentity(original))
    expect(state.hasSubmissionError.value).toBe(false)
    expect(state.isSubmitting.value).toBe(false)
  })

  it('keeps an unsuccessful response visible for retry', async () => {
    const state = submissionState()
    await expect(state.submit(async () => false)).resolves.toBeNull()
    expect(state.hasSubmissionError.value).toBe(true)
    expect(state.isSubmitting.value).toBe(false)
  })

  it('catches rejected response promises and exposes a retryable error', async () => {
    const state = submissionState()
    await expect(state.submit(async () => { throw new Error('response failed') })).resolves.toBeNull()
    expect(state.hasSubmissionError.value).toBe(true)
    expect(state.isSubmitting.value).toBe(false)
  })

  it.each(['false', 'rejection'] as const)('does not show a late %s from the previous request on a different question', async (outcome) => {
    const state = submissionState()
    const response = deferredResult()
    const result = state.submit(() => response.promise)
    state.currentRequest.value = request({ id: 8 })
    await nextTick()
    if (outcome === 'false') response.resolve(false)
    else response.reject(new Error('old question failed'))
    await expect(result).resolves.toBeNull()
    expect(state.hasSubmissionError.value).toBe(false)
    expect(state.isSubmitting.value).toBe(false)
  })

  it('does not execute a second submission callback while a response is pending', async () => {
    const state = submissionState()
    const response = deferredResult()
    const firstCallback = vi.fn(() => response.promise)
    const secondCallback = vi.fn(async () => true)
    const firstResult = state.submit(firstCallback)
    await expect(state.submit(secondCallback)).resolves.toBeNull()
    expect(firstCallback).toHaveBeenCalledTimes(1)
    expect(secondCallback).not.toHaveBeenCalled()
    expect(state.isSubmitting.value).toBe(true)
    expect(state.hasSubmissionError.value).toBe(false)
    response.resolve(true)
    await expect(firstResult).resolves.toBe(pendingRequestDraftIdentity(state.currentRequest.value!))
    expect(state.isSubmitting.value).toBe(false)
  })

  it('clears the prior error when retry starts and keeps it clear after success', async () => {
    const state = submissionState()
    await state.submit(async () => false)
    expect(state.hasSubmissionError.value).toBe(true)
    const response = deferredResult()
    const retry = state.submit(() => response.promise)
    expect(state.isSubmitting.value).toBe(true)
    expect(state.hasSubmissionError.value).toBe(false)
    response.resolve(true)
    await expect(retry).resolves.toBe(pendingRequestDraftIdentity(state.currentRequest.value!))
    expect(state.hasSubmissionError.value).toBe(false)
    expect(state.isSubmitting.value).toBe(false)
  })
})
