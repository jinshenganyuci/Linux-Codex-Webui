export type ProjectZipExportStatus = {
  phase: 'idle' | 'exporting' | 'ready'
  loaded: number
  total: number | null
  blob: Blob | null
  fileName: string
  error: string
}

export type ProjectZipExportPresentation = {
  copy: string
  phaseLabel: string
  progressText: string
  progressWidth: string
  isExporting: boolean
  hasDownload: boolean
}

type Translate = (message: string) => string

export function formatProjectZipByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

export function getProjectZipExportPresentation(
  status: ProjectZipExportStatus,
  translate: Translate,
): ProjectZipExportPresentation {
  const isExporting = status.phase === 'exporting'
  const loadedLabel = formatProjectZipByteCount(status.loaded)
  const progressText = status.total && status.total > 0
    ? `${loadedLabel} / ${formatProjectZipByteCount(status.total)}`
    : (status.loaded > 0 ? loadedLabel : translate('Preparing...'))

  let progressWidth: string
  if (status.phase === 'ready') {
    progressWidth = '100%'
  } else if (!status.total || status.total <= 0) {
    progressWidth = status.loaded > 0 ? '55%' : '20%'
  } else {
    progressWidth = `${Math.min(100, Math.max(5, Math.round((status.loaded / status.total) * 100)))}%`
  }

  return {
    copy: isExporting ? translate('Preparing project ZIP...') : status.fileName,
    phaseLabel: isExporting ? translate('Exporting') : translate('Ready'),
    progressText,
    progressWidth,
    isExporting,
    hasDownload: Boolean(status.blob),
  }
}
