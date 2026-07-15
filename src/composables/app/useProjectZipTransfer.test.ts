import { describe, expect, it, vi } from 'vitest'
import { useProjectZipTransfer, type UseProjectZipTransferOptions } from './useProjectZipTransfer'

function createHarness(overrides: Partial<UseProjectZipTransferOptions> = {}) {
  const options: UseProjectZipTransferOptions = {
    resolveProjectBaseDirectory: vi.fn(async () => '/projects'),
    setImportedProjectPath: vi.fn(),
    pinImportedProject: vi.fn(),
    refreshWorkspaceRootOptions: vi.fn(async () => undefined),
    refreshThreadsAfterImport: vi.fn(async () => undefined),
    refreshDefaultProjectName: vi.fn(async () => undefined),
    translate: (message) => `translated:${message}`,
    downloadProjectZip: vi.fn(async () => ({ blob: new Blob(['zip']), fileName: 'project.zip' })),
    importProjectZip: vi.fn(async () => ({ path: '/projects/imported' })),
    downloadBlob: vi.fn(),
    shareBlob: vi.fn(async () => undefined),
    showAlert: vi.fn(),
    hasDocument: () => true,
    ...overrides,
  }
  return {
    options,
    transfer: useProjectZipTransfer(options),
  }
}

describe('useProjectZipTransfer', () => {
  it('keeps export progress, completion, and modal close transitions ordered', async () => {
    let resolveDownload!: (value: { blob: Blob; fileName: string }) => void
    const blob = new Blob(['zip-data'], { type: 'application/zip' })
    const downloadProjectZip = vi.fn((_cwd: string, onProgress?: (progress: { loaded: number; total: number | null }) => void) => {
      onProgress?.({ loaded: 3, total: 20 })
      return new Promise<{ blob: Blob; fileName: string }>((resolve) => {
        resolveDownload = resolve
      })
    })
    const { transfer } = createHarness({ downloadProjectZip })

    const exporting = transfer.exportProjectZipForCwd('/projects/demo')
    expect(downloadProjectZip).toHaveBeenCalledWith('/projects/demo', expect.any(Function))
    expect(transfer.projectZipExportStatus.value).toMatchObject({
      phase: 'exporting',
      loaded: 3,
      total: 20,
      blob: null,
    })

    transfer.onCloseProjectZipExportModal()
    expect(transfer.projectZipExportStatus.value.phase).toBe('exporting')

    resolveDownload({ blob, fileName: 'demo.zip' })
    await exporting
    expect(transfer.projectZipExportStatus.value).toMatchObject({
      phase: 'ready',
      loaded: blob.size,
      total: blob.size,
      blob,
      fileName: 'demo.zip',
      error: '',
    })

    transfer.onCloseProjectZipExportModal()
    expect(transfer.projectZipExportStatus.value).toEqual({
      phase: 'idle',
      loaded: 0,
      total: null,
      blob: null,
      fileName: '',
      error: '',
    })
  })

  it('preserves export guards and error handling', async () => {
    const downloadProjectZip = vi.fn(async () => {
      throw new Error('Export failed')
    })
    const showAlert = vi.fn()
    const { transfer } = createHarness({ downloadProjectZip, showAlert })

    await transfer.exportProjectZipForCwd('')
    expect(downloadProjectZip).not.toHaveBeenCalled()

    await transfer.exportProjectZipForCwd('/projects/demo')
    expect(transfer.projectZipExportStatus.value.phase).toBe('idle')
    expect(showAlert).toHaveBeenCalledWith('Export failed')

    downloadProjectZip.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
    await transfer.exportProjectZipForCwd('/projects/demo')
    expect(showAlert).toHaveBeenCalledTimes(1)
  })

  it('downloads ready exports and maps share failures without changing modal semantics', async () => {
    const blob = new Blob(['zip'])
    const downloadBlob = vi.fn()
    const shareBlob = vi.fn()
      .mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
    const { transfer } = createHarness({ downloadBlob, shareBlob })
    transfer.projectZipExportStatus.value = {
      phase: 'ready',
      loaded: blob.size,
      total: blob.size,
      blob,
      fileName: 'demo.zip',
      error: 'old error',
    }

    transfer.onDownloadProjectZipExport()
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'demo.zip')
    expect(transfer.projectZipExportStatus.value.error).toBe('')

    await transfer.onShareProjectZipExport()
    expect(transfer.projectZipExportStatus.value.error).toBe(
      'translated:This browser blocked sharing the ZIP. Use Download instead.',
    )

    await transfer.onShareProjectZipExport()
    expect(transfer.projectZipExportStatus.value.error).toBe('')
  })

  it('resets and opens the hidden import input only while idle', () => {
    const input = {
      value: 'previous.zip',
      click: vi.fn(),
      files: null,
    } as unknown as HTMLInputElement
    const { transfer } = createHarness()
    transfer.projectImportInputRef.value = input

    transfer.onChooseProjectImportZip()
    expect(input.value).toBe('')
    expect(input.click).toHaveBeenCalledTimes(1)

    transfer.isProjectImporting.value = true
    transfer.onChooseProjectImportZip()
    expect(input.click).toHaveBeenCalledTimes(1)
  })

  it('preserves the complete post-import refresh order and input cleanup', async () => {
    const events: string[] = []
    const file = new File(['zip'], 'project.zip', { type: 'application/zip' })
    const input = {
      value: 'project.zip',
      files: [file],
    } as unknown as HTMLInputElement
    const { transfer } = createHarness({
      resolveProjectBaseDirectory: vi.fn(async () => {
        events.push('resolve-base')
        return '/projects'
      }),
      importProjectZip: vi.fn(async (selectedFile, baseDir) => {
        expect(selectedFile).toBe(file)
        expect(baseDir).toBe('/projects')
        events.push('import')
        return { path: '/projects/imported' }
      }),
      setImportedProjectPath: vi.fn((path) => {
        expect(path).toBe('/projects/imported')
        events.push('set-path')
      }),
      pinImportedProject: vi.fn((path) => {
        expect(path).toBe('/projects/imported')
        events.push('pin')
      }),
      refreshWorkspaceRootOptions: vi.fn(async () => {
        events.push('refresh-roots')
      }),
      refreshThreadsAfterImport: vi.fn(async () => {
        events.push('refresh-threads')
      }),
      refreshDefaultProjectName: vi.fn(async () => {
        events.push('refresh-name')
      }),
      getProjectImportInput: () => input,
    })

    await transfer.onDirectProjectImportFileChange(new Event('change'))

    expect(events).toEqual([
      'resolve-base',
      'import',
      'set-path',
      'pin',
      'refresh-roots',
      'refresh-threads',
      'refresh-name',
    ])
    expect(transfer.isProjectImporting.value).toBe(false)
    expect(input.value).toBe('')
  })

  it('reports import errors and always releases the import guard', async () => {
    const file = new File(['zip'], 'project.zip')
    const input = {
      value: 'project.zip',
      files: [file],
    } as unknown as HTMLInputElement
    const showAlert = vi.fn()
    const { transfer } = createHarness({
      importProjectZip: vi.fn(async () => {
        throw new Error('Import failed')
      }),
      showAlert,
      getProjectImportInput: () => input,
    })

    await transfer.onDirectProjectImportFileChange(new Event('change'))

    expect(showAlert).toHaveBeenCalledWith('Import failed')
    expect(transfer.isProjectImporting.value).toBe(false)
    expect(input.value).toBe('')
  })
})
