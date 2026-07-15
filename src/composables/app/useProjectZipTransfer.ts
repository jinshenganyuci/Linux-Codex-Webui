import { ref } from 'vue'
import {
  downloadProjectZip as downloadProjectZipFromGateway,
  importProjectZip as importProjectZipFromGateway,
} from '../../api/codexGateway'
import type { ProjectZipExportStatus } from '../../components/app/projectZipExportModal'

type ProjectZipProgress = {
  loaded: number
  total: number | null
}

type DownloadProjectZip = (
  cwd: string,
  onProgress?: (progress: ProjectZipProgress) => void,
) => Promise<{ blob: Blob; fileName: string }>

type ImportProjectZip = (file: Blob, parent: string) => Promise<{ path: string }>

export type UseProjectZipTransferOptions = {
  resolveProjectBaseDirectory: () => Promise<string>
  setImportedProjectPath: (path: string) => void
  pinImportedProject: (path: string) => void
  refreshWorkspaceRootOptions: () => Promise<void>
  refreshThreadsAfterImport: () => Promise<void>
  refreshDefaultProjectName: () => Promise<void>
  translate?: (message: string) => string
  downloadProjectZip?: DownloadProjectZip
  importProjectZip?: ImportProjectZip
  downloadBlob?: (blob: Blob, fileName: string) => void
  shareBlob?: (blob: Blob, fileName: string) => Promise<void>
  showAlert?: (message: string) => void
  hasDocument?: () => boolean
  getProjectImportInput?: (event: Event) => HTMLInputElement | null
}

function createIdleExportStatus(): ProjectZipExportStatus {
  return {
    phase: 'idle',
    loaded: 0,
    total: null,
    blob: null,
    fileName: '',
    error: '',
  }
}

function downloadBlobInBrowser(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 30000)
}

async function shareBlobInBrowser(blob: Blob, fileName: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type || 'application/zip' })
  const shareData = {
    files: [file],
    title: fileName,
  }
  const canShareFiles = typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData))
  if (!canShareFiles) {
    throw new Error('File sharing is not supported in this browser.')
  }
  await navigator.share(shareData)
}

function showBrowserAlert(message: string): void {
  if (typeof window !== 'undefined') window.alert(message)
}

function hasBrowserDocument(): boolean {
  return typeof document !== 'undefined'
}

function getBrowserProjectImportInput(event: Event): HTMLInputElement | null {
  if (typeof HTMLInputElement === 'undefined') return null
  return event.target instanceof HTMLInputElement ? event.target : null
}

function isDomException(error: unknown): error is DOMException {
  return typeof DOMException !== 'undefined' && error instanceof DOMException
}

export function useProjectZipTransfer(options: UseProjectZipTransferOptions) {
  const translate = options.translate ?? ((message: string) => message)
  const downloadProjectZip = options.downloadProjectZip ?? downloadProjectZipFromGateway
  const importProjectZip = options.importProjectZip ?? importProjectZipFromGateway
  const downloadBlob = options.downloadBlob ?? downloadBlobInBrowser
  const shareBlob = options.shareBlob ?? shareBlobInBrowser
  const showAlert = options.showAlert ?? showBrowserAlert
  const hasDocument = options.hasDocument ?? hasBrowserDocument
  const getProjectImportInput = options.getProjectImportInput ?? getBrowserProjectImportInput

  const projectZipExportStatus = ref<ProjectZipExportStatus>(createIdleExportStatus())
  const isProjectImporting = ref(false)
  const projectImportInputRef = ref<HTMLInputElement | null>(null)

  async function exportProjectZipForCwd(targetCwd: string): Promise<void> {
    if (!targetCwd || !hasDocument()) return
    projectZipExportStatus.value = {
      phase: 'exporting',
      loaded: 0,
      total: null,
      blob: null,
      fileName: '',
      error: '',
    }
    try {
      const { blob, fileName } = await downloadProjectZip(targetCwd, ({ loaded, total }) => {
        projectZipExportStatus.value = {
          ...projectZipExportStatus.value,
          phase: 'exporting',
          loaded,
          total,
        }
      })
      projectZipExportStatus.value = {
        phase: 'ready',
        loaded: blob.size,
        total: blob.size,
        blob,
        fileName,
        error: '',
      }
    } catch (error) {
      projectZipExportStatus.value = createIdleExportStatus()
      if (isDomException(error) && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : 'Failed to export project.'
      showAlert(message)
    }
  }

  function onCloseProjectZipExportModal(): void {
    if (projectZipExportStatus.value.phase === 'exporting') return
    projectZipExportStatus.value = createIdleExportStatus()
  }

  function onDownloadProjectZipExport(): void {
    const { blob, fileName } = projectZipExportStatus.value
    if (!blob || !fileName) return
    projectZipExportStatus.value = { ...projectZipExportStatus.value, error: '' }
    downloadBlob(blob, fileName)
  }

  async function onShareProjectZipExport(): Promise<void> {
    const { blob, fileName } = projectZipExportStatus.value
    if (!blob || !fileName) return
    try {
      projectZipExportStatus.value = { ...projectZipExportStatus.value, error: '' }
      await shareBlob(blob, fileName)
    } catch (error) {
      if (isDomException(error) && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : ''
      const wasBlocked = isDomException(error) && error.name === 'NotAllowedError'
        || /permission denied|notallowed|not allowed|gesture/iu.test(message)
      projectZipExportStatus.value = {
        ...projectZipExportStatus.value,
        error: wasBlocked
          ? translate('This browser blocked sharing the ZIP. Use Download instead.')
          : (message || translate('Failed to share project. Use Download instead.')),
      }
    }
  }

  function onChooseProjectImportZip(): void {
    const input = projectImportInputRef.value
    if (isProjectImporting.value || !input) return
    input.value = ''
    input.click()
  }

  async function finishProjectImport(input: HTMLInputElement | null, file: Blob): Promise<void> {
    isProjectImporting.value = true
    try {
      const baseDir = await options.resolveProjectBaseDirectory()
      if (!baseDir) return
      const result = await importProjectZip(file, baseDir)
      if (!result.path) return
      options.setImportedProjectPath(result.path)
      options.pinImportedProject(result.path)
      await options.refreshWorkspaceRootOptions()
      await options.refreshThreadsAfterImport()
      await options.refreshDefaultProjectName()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import project.'
      showAlert(message)
    } finally {
      isProjectImporting.value = false
      if (input) input.value = ''
    }
  }

  async function onDirectProjectImportFileChange(event: Event): Promise<void> {
    const input = getProjectImportInput(event)
    const file = input?.files?.[0] ?? null
    if (!file || isProjectImporting.value) return
    await finishProjectImport(input, file)
  }

  return {
    projectZipExportStatus,
    isProjectImporting,
    projectImportInputRef,
    exportProjectZipForCwd,
    onCloseProjectZipExportModal,
    onDownloadProjectZipExport,
    onShareProjectZipExport,
    onChooseProjectImportZip,
    onDirectProjectImportFileChange,
  }
}
