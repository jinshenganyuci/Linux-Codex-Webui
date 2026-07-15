export type CodexLoginModalPresentation = {
  controlsDisabled: boolean
  submitDisabled: boolean
  submitLabel: string
}

type Translate = (message: string) => string

export function getCodexLoginModalPresentation(
  callbackUrl: string,
  isCompleting: boolean,
  translate: Translate,
): CodexLoginModalPresentation {
  return {
    controlsDisabled: isCompleting,
    submitDisabled: isCompleting || callbackUrl.trim().length === 0,
    submitLabel: isCompleting ? translate('Completing…') : translate('Complete'),
  }
}
