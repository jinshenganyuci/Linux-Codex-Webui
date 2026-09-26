import type { UiMessage, UiPlanKind, UiPlanLifecycle, UiPlanStep } from '../../types/codex'

export function planKind(message: UiMessage, steps: UiPlanStep[]): UiPlanKind {
  if (message.plan?.kind) return message.plan.kind
  // Old stored progress snapshots did not carry a discriminator. An actual
  // checklist is still progress; a native plan document without steps is a proposal.
  return steps.length > 0 || message.messageType === 'plan.summary' ? 'checklist' : 'proposal'
}

export function planCardIdentity(threadId: string, message: UiMessage, steps: UiPlanStep[]): string {
  return JSON.stringify([
    threadId,
    message.turnId?.trim() || '',
    planKind(message, steps),
    message.plan?.itemId?.trim() || (planKind(message, steps) === 'checklist' ? 'turn-checklist' : message.id),
  ])
}

export function truthfulPlanLifecycle(message: UiMessage, steps: UiPlanStep[], failedTurn: boolean): UiPlanLifecycle {
  const explicit = message.plan?.lifecycle
  if (explicit === 'failed' || explicit === 'interrupted') return explicit
  if (failedTurn) return 'failed'
  if (explicit === 'completed') {
    if (planKind(message, steps) === 'checklist' && (!steps.length || steps.some(step => step.status !== 'completed'))) return 'incomplete'
    return 'completed'
  }
  if (explicit) return explicit
  if (message.messageType === 'plan.live') return 'live'
  // Completed checklist entries do not prove that their turn completed.
  return 'unconfirmed'
}

export function planConfirmedCount(steps: UiPlanStep[]): number {
  return steps.filter(step => step.status === 'completed').length
}

export function planCurrentSteps(steps: UiPlanStep[]): string[] {
  return steps.filter(step => step.status === 'inProgress').map(step => step.step.trim()).filter(Boolean)
}
